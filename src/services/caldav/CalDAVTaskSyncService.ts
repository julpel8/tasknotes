import { TFile, type EventRef } from "obsidian";
import type TaskNotesPlugin from "../../main";
import { EVENT_TASK_UPDATED, type TaskInfo } from "../../types";
import { getDatePart, parseDateToUTC } from "../../utils/dateUtils";
import { splitFrontmatterAndBody } from "../../utils/helpers";
import { createTaskNotesLogger } from "../../utils/tasknotesLogger";
import { processVaultFrontMatter } from "../../core/VaultMutationService";
import { CalDAVError, type CalDAVObject } from "./CalDAVClient";
import type { CalDAVCalendarService } from "./CalDAVCalendarService";
import { generateUid, objectUrlForUid } from "./icalObjects";
import {
	CALDAV_UID_FIELD,
	normalizeDescription,
	pickTaskDate,
	priorityToIcal,
	readTodo,
	todoDiffers,
	writeTodo,
	type TodoFields,
	type TodoSnapshot,
} from "./caldavTaskMapping";

const tasknotesLogger = createTaskNotesLogger({ tag: "Services/CalDAVTaskSyncService" });

const TASK_DEBOUNCE_MS = 1500;
/** Clock slack when deciding whether the server or the note changed last. */
const CLOCK_TOLERANCE_MS = 2000;
const MIN_PASS_INTERVAL_MS = 30 * 1000;
const PENDING_DELETIONS_KEY = "tasknotes-caldav-pending-deletions";

/**
 * Sends tasks to a CalDAV task calendar as to-dos (shown by phone reminder
 * apps) and brings completion, date and text changes back into the notes.
 *
 * No sync state lives in plugin data: the to-do's UID is stored in the note
 * (caldav_uid) and the object is named after it, so every device writes to the
 * same place. Conflicts resolve by comparing the note's modification time with
 * the to-do's LAST-MODIFIED on every pass.
 */
export class CalDAVTaskSyncService {
	private timers: Map<string, number> = new Map();
	private inFlight: Map<string, Promise<void>> = new Map();
	private eventRefs: { source: { offref(ref: EventRef): void }; ref: EventRef }[] = [];
	private passTimer: number | null = null;
	private passRunning: Promise<void> | null = null;
	private lastPassAt = 0;
	private destroyed = false;
	private readonly onVisibilityChange = () => {
		if (document.visibilityState === "visible") void this.runPass();
	};

	constructor(
		private readonly plugin: TaskNotesPlugin,
		private readonly calendarService: CalDAVCalendarService
	) {}

	isEnabled(): boolean {
		const settings = this.plugin.settings.caldav;
		return this.calendarService.isConfigured() && settings.syncTasks && !!settings.taskCalendarUrl;
	}

	start(): void {
		this.destroyed = false;
		const onTaskUpdated = (data: { path?: string } | undefined) => {
			if (data?.path) this.scheduleTask(data.path);
		};
		this.listen(this.plugin.emitter, EVENT_TASK_UPDATED, onTaskUpdated);
		this.listen(this.plugin.cacheManager, EVENT_TASK_UPDATED, onTaskUpdated);
		this.listen(this.plugin.cacheManager, "file-deleted", (data: { prevCache?: unknown }) => {
			void this.handleDeletedNote(data?.prevCache);
		});
		document.addEventListener("visibilitychange", this.onVisibilityChange);
		void this.runPass();
	}

	private listen<T>(
		source: { on(name: string, callback: (data: T) => void): EventRef; offref(ref: EventRef): void },
		name: string,
		callback: (data: T) => void
	): void {
		this.eventRefs.push({ source, ref: source.on(name, callback) });
	}

	destroy(): void {
		this.destroyed = true;
		this.eventRefs.forEach(({ source, ref }) => source.offref(ref));
		this.eventRefs = [];
		this.timers.forEach((timer) => window.clearTimeout(timer));
		this.timers.clear();
		if (this.passTimer !== null) window.clearTimeout(this.passTimer);
		this.passTimer = null;
		document.removeEventListener("visibilitychange", this.onVisibilityChange);
	}

	private schedulePass(): void {
		if (this.passTimer !== null) window.clearTimeout(this.passTimer);
		if (this.destroyed) return;
		const minutes = Math.max(1, this.plugin.settings.caldav.refreshMinutes || 5);
		this.passTimer = window.setTimeout(() => {
			this.passTimer = null;
			void this.runPass(true);
		}, minutes * 60 * 1000);
	}

	scheduleTask(path: string): void {
		if (this.destroyed || !this.isEnabled()) return;
		const existing = this.timers.get(path);
		if (existing) window.clearTimeout(existing);
		this.timers.set(
			path,
			window.setTimeout(() => {
				this.timers.delete(path);
				void this.syncTaskByPath(path);
			}, TASK_DEBOUNCE_MS)
		);
	}

	/**
	 * Full pass: retries pending deletions, then reconciles every task with the
	 * to-dos on the server. Runs at start, on the refresh interval and when the
	 * app comes back to the foreground.
	 */
	async runPass(force = false): Promise<void> {
		if (this.passRunning) return this.passRunning;
		if (!force && Date.now() - this.lastPassAt < MIN_PASS_INTERVAL_MS) return;
		this.passRunning = this.doPass().finally(() => {
			this.passRunning = null;
			this.lastPassAt = Date.now();
			this.schedulePass();
		});
		return this.passRunning;
	}

	private async doPass(): Promise<void> {
		if (!this.isEnabled()) return;
		try {
			await this.retryPendingDeletions();
			const calendarUrl = this.plugin.settings.caldav.taskCalendarUrl;
			const objects = await this.calendarService.client.fetchObjects(calendarUrl, "VTODO");
			const byUrl = new Map(objects.map((object) => [object.url, object]));
			const tasks = await this.plugin.cacheManager.getAllTasks();
			for (const task of tasks) {
				if (this.destroyed) return;
				await this.withTaskLock(task.path, () =>
					this.reconcile(task, (url) => Promise.resolve(byUrl.get(url) ?? null))
				);
			}
			await this.importForeignTodos(objects, tasks);
		} catch (error) {
			this.calendarService.reportError(error);
			tasknotesLogger.warn("CalDAV task pass failed", {
				category: "provider",
				operation: "caldav-task-pass",
				error,
			});
		}
	}

	async syncTaskByPath(path: string): Promise<void> {
		if (!this.isEnabled()) return;
		await this.withTaskLock(path, async () => {
			const task = await this.plugin.cacheManager.getTaskInfo(path);
			if (!task) return;
			await this.reconcile(task, (url) => this.calendarService.client.getObject(url));
		});
	}

	private async withTaskLock(path: string, work: () => Promise<void>): Promise<void> {
		const previous = this.inFlight.get(path) ?? Promise.resolve();
		const next = previous
			.then(work)
			.catch((error) => {
				tasknotesLogger.warn("CalDAV task sync failed", {
					category: "provider",
					operation: "caldav-task-sync",
					details: { path },
					error,
				});
			})
			.finally(() => {
				if (this.inFlight.get(path) === next) this.inFlight.delete(path);
			});
		this.inFlight.set(path, next);
		return next;
	}

	private getStoredUid(file: TFile): string | undefined {
		const value: unknown =
			this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.[CALDAV_UID_FIELD];
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	}

	/** The note's body, which travels as the to-do's description. */
	private async readNoteBody(file: TFile): Promise<string> {
		return normalizeDescription(splitFrontmatterAndBody(await this.plugin.app.vault.read(file)).body);
	}

	private taskToFields(task: TaskInfo, description: string): TodoFields {
		const { date, dateField } = pickTaskDate(task);
		const vault = encodeURIComponent(this.plugin.app.vault.getName());
		return {
			title: task.title,
			completed: this.plugin.statusManager.isCompletedStatus(task.status),
			date,
			dateField,
			priority: priorityToIcal(task.priority, this.plugin.settings.customPriorities),
			description,
			url: `obsidian://open?vault=${vault}&file=${encodeURIComponent(task.path)}`,
		};
	}

	private noteModifiedAt(task: TaskInfo, file: TFile): number {
		const fromFrontmatter = task.dateModified ? Date.parse(task.dateModified) : NaN;
		return Math.max(isNaN(fromFrontmatter) ? 0 : fromFrontmatter, file.stat.mtime);
	}

	private async reconcile(
		task: TaskInfo,
		loadObject: (url: string) => Promise<CalDAVObject | null>
	): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(task.path);
		if (!(file instanceof TFile)) return;
		const client = this.calendarService.client;
		const calendarUrl = this.plugin.settings.caldav.taskCalendarUrl;
		let uid = this.getStoredUid(file);

		if (task.archived) {
			// Archived tasks leave the reminders list. Dropping the UID means an
			// unarchived task comes back as a new to-do.
			if (uid) {
				await client.deleteObject(objectUrlForUid(calendarUrl, uid));
				await processVaultFrontMatter(this.plugin.app, file, (frontmatter) => {
					delete frontmatter[CALDAV_UID_FIELD];
				});
			}
			return;
		}

		if (!uid) {
			uid = generateUid();
			const newUid = uid;
			await processVaultFrontMatter(this.plugin.app, file, (frontmatter) => {
				frontmatter[CALDAV_UID_FIELD] = newUid;
			});
		}

		const url = objectUrlForUid(calendarUrl, uid);
		let local = this.taskToFields(task, await this.readNoteBody(file));
		const object = await loadObject(url);

		if (!object) {
			try {
				await client.putObject(url, writeTodo(null, uid, local), { createOnly: true });
			} catch (error) {
				// Another device created it first: reconcile against its copy next time.
				if (!(error instanceof CalDAVError && error.status === 412)) throw error;
			}
			return;
		}

		const server = readTodo(object.data);
		if (!server) return;

		const serverNewer =
			(server.lastModified ?? 0) > this.noteModifiedAt(task, file) + CLOCK_TOLERANCE_MS;
		if (serverNewer) {
			const updated = await this.applyServerChanges(task, local, server);
			// A to-do not yet marked as ours still gets rewritten once, with the marker.
			if (server.managed) return;
			local = this.taskToFields(updated, await this.readNoteBody(file));
		}

		if (!server.managed || todoDiffers(local, server)) {
			await client.putObject(url, writeTodo(object.data, uid, local), { etag: object.etag });
		}
	}

	/**
	 * Turns open to-dos created outside TaskNotes (e.g. in a phone's reminders
	 * app) into task notes that keep the to-do's UID, so both stay linked.
	 * To-dos written by a task note are never imported: their note may simply
	 * not have reached this device yet.
	 */
	private async importForeignTodos(objects: CalDAVObject[], tasks: TaskInfo[]): Promise<void> {
		const knownUids = new Set<string>();
		for (const task of tasks) {
			const file = this.plugin.app.vault.getAbstractFileByPath(task.path);
			const uid = file instanceof TFile ? this.getStoredUid(file) : undefined;
			if (uid) knownUids.add(uid);
		}

		const calendarUrl = this.plugin.settings.caldav.taskCalendarUrl;
		for (const object of objects) {
			if (this.destroyed) return;
			let todo: TodoSnapshot | null;
			try {
				todo = readTodo(object.data);
			} catch {
				continue;
			}
			if (!todo || !todo.uid || todo.managed || todo.completed || knownUids.has(todo.uid)) {
				continue;
			}
			// Only objects named after their UID can be found again from the note.
			if (object.url !== objectUrlForUid(calendarUrl, todo.uid)) continue;

			knownUids.add(todo.uid);
			await this.plugin.taskService.createTask({
				title: todo.title || "Untitled",
				due: todo.date,
				details: todo.description,
				creationContext: "import",
				customFrontmatter: { [CALDAV_UID_FIELD]: todo.uid },
			});
		}
	}

	/**
	 * Brings completion, date and text changes made on the server (e.g. in a
	 * phone's reminders app) into the note. Other fields stay under the note's
	 * control.
	 */
	private async applyServerChanges(
		task: TaskInfo,
		local: TodoFields,
		server: TodoSnapshot
	): Promise<TaskInfo> {
		const taskService = this.plugin.taskService;
		let current = task;

		if ((server.description ?? "") !== (local.description ?? "")) {
			current = await taskService.updateTask(current, { details: server.description ?? "" });
		}

		if (server.completed !== local.completed) {
			if (current.recurrence) {
				if (server.completed) {
					const date = server.date ?? local.date;
					const target = date ? parseDateToUTC(getDatePart(date)) : undefined;
					const dateKey = date ? getDatePart(date) : undefined;
					if (!dateKey || !current.complete_instances?.includes(dateKey)) {
						current = (await taskService.toggleRecurringTaskComplete(current, target)) ?? current;
					}
				}
				// Reopening a finished occurrence from the phone has no single meaning
				// for a repeating task; the next push shows the next occurrence again.
				return current;
			}
			const status = server.completed
				? (this.plugin.statusManager.getCompletedStatuses()[0] ?? "done")
				: this.plugin.settings.defaultTaskStatus;
			current = await taskService.updateProperty(current, "status", status);
		}

		if ((server.date ?? "") !== (local.date ?? "")) {
			const field = local.date ? local.dateField : server.dateField;
			current = await taskService.updateProperty(current, field, server.date);
		}
		return current;
	}

	private async handleDeletedNote(prevCache: unknown): Promise<void> {
		if (!this.isEnabled()) return;
		const frontmatter = (prevCache as { frontmatter?: Record<string, unknown> } | undefined)?.frontmatter;
		const value: unknown = frontmatter?.[CALDAV_UID_FIELD];
		if (typeof value !== "string" || !value.trim()) return;
		const url = objectUrlForUid(this.plugin.settings.caldav.taskCalendarUrl, value.trim());
		try {
			await this.calendarService.client.deleteObject(url);
		} catch (error) {
			this.queueDeletion(url);
			tasknotesLogger.warn("CalDAV to-do deletion queued for retry", {
				category: "provider",
				operation: "caldav-task-delete",
				details: { url },
				error,
			});
		}
	}

	private readPendingDeletions(): string[] {
		const stored: unknown = this.plugin.app.loadLocalStorage(PENDING_DELETIONS_KEY);
		return Array.isArray(stored) ? stored.filter((url): url is string => typeof url === "string") : [];
	}

	private queueDeletion(url: string): void {
		const pending = new Set(this.readPendingDeletions());
		pending.add(url);
		this.plugin.app.saveLocalStorage(PENDING_DELETIONS_KEY, Array.from(pending));
	}

	private async retryPendingDeletions(): Promise<void> {
		const pending = this.readPendingDeletions();
		if (pending.length === 0) return;
		const remaining: string[] = [];
		for (const url of pending) {
			try {
				await this.calendarService.client.deleteObject(url);
			} catch {
				remaining.push(url);
			}
		}
		this.plugin.app.saveLocalStorage(PENDING_DELETIONS_KEY, remaining.length ? remaining : null);
	}
}
