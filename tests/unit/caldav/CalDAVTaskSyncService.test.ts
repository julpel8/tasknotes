jest.mock("ical.js", () => {
	const actualICAL = jest.requireActual("../../../node_modules/ical.js/dist/ical.es5.cjs");
	return actualICAL;
});

import { TFile } from "obsidian";
import type TaskNotesPlugin from "../../../src/main";
import type { TaskInfo } from "../../../src/types";
import { DEFAULT_CALDAV_SETTINGS } from "../../../src/settings/defaults";
import { CalDAVError, type CalDAVObject } from "../../../src/services/caldav/CalDAVClient";
import { CalDAVTaskSyncService } from "../../../src/services/caldav/CalDAVTaskSyncService";
import type { CalDAVCalendarService } from "../../../src/services/caldav/CalDAVCalendarService";
import { readTodo } from "../../../src/services/caldav/caldavTaskMapping";

const TASKS_URL = "https://cal.example.com/dav.php/calendars/alice/tasks/";

class FakeServer {
	objects = new Map<string, { data: string; etag: string }>();
	private counter = 0;
	offline = false;

	private check() {
		if (this.offline) throw new CalDAVError("offline", 0);
	}
	fetchObjects = jest.fn(async (): Promise<CalDAVObject[]> => {
		this.check();
		return Array.from(this.objects, ([url, o]) => ({ url, etag: o.etag, data: o.data }));
	});
	getObject = jest.fn(async (url: string): Promise<CalDAVObject | null> => {
		this.check();
		const o = this.objects.get(url);
		return o ? { url, etag: o.etag, data: o.data } : null;
	});
	putObject = jest.fn(async (url: string, data: string, options: { etag?: string; createOnly?: boolean } = {}) => {
		this.check();
		const existing = this.objects.get(url);
		if (options.createOnly && existing) throw new CalDAVError("exists", 412);
		if (options.etag && existing?.etag !== options.etag) throw new CalDAVError("changed", 412);
		const etag = `"e${++this.counter}"`;
		this.objects.set(url, { data, etag });
		return etag;
	});
	deleteObject = jest.fn(async (url: string) => {
		this.check();
		this.objects.delete(url);
	});

	/** Simulates a change made in a phone's reminders app. */
	editFromPhone(url: string, change: (ics: string) => string, at: string) {
		const o = this.objects.get(url)!;
		const data = change(o.data).replace(/LAST-MODIFIED:\S+/u, `LAST-MODIFIED:${at}`);
		this.objects.set(url, { data, etag: `"e${++this.counter}"` });
	}
}

function makeFile(path: string, mtime: number): TFile {
	const file = Object.create(TFile.prototype) as TFile;
	Object.assign(file, { path, stat: { mtime, ctime: mtime, size: 1 } });
	return file;
}

function createDevice(server: FakeServer, tasks: Map<string, TaskInfo>, frontmatter: Map<string, Record<string, unknown>>) {
	const files = new Map<string, TFile>();
	const storage = new Map<string, unknown>();
	const fileFor = (path: string) => {
		if (!files.has(path)) files.set(path, makeFile(path, Date.parse("2026-09-01T00:00:00Z")));
		return files.get(path)!;
	};
	const events = { on: jest.fn(() => ({})), offref: jest.fn() };

	const plugin = {
		settings: {
			caldav: { ...DEFAULT_CALDAV_SETTINGS, enabled: true, syncTasks: true, taskCalendarUrl: TASKS_URL },
			customPriorities: [
				{ value: "low", weight: 1 },
				{ value: "normal", weight: 2 },
				{ value: "high", weight: 3 },
			],
			defaultTaskStatus: "open",
		},
		statusManager: {
			isCompletedStatus: (status: string) => status === "done",
			getCompletedStatuses: () => ["done"],
		},
		cacheManager: {
			...events,
			getAllTasks: jest.fn(async () => Array.from(tasks.values())),
			getTaskInfo: jest.fn(async (path: string) => tasks.get(path) ?? null),
		},
		emitter: events,
		taskService: {
			updateProperty: jest.fn(async (task: TaskInfo, property: keyof TaskInfo, value: unknown) => {
				const updated = { ...task, [property]: value, dateModified: new Date().toISOString() };
				tasks.set(task.path, updated);
				return updated;
			}),
			updateTask: jest.fn(async (task: TaskInfo, updates: Partial<TaskInfo>) => {
				const updated = { ...task, ...updates, dateModified: new Date().toISOString() };
				tasks.set(task.path, updated);
				return updated;
			}),
			toggleRecurringTaskComplete: jest.fn(),
			createTask: jest.fn(async (data: Partial<TaskInfo> & { customFrontmatter?: Record<string, unknown> }) => {
				const path = `TaskNotes/Tasks/${data.title}.md`;
				const created = task(path, { title: data.title, due: data.due, dateModified: new Date().toISOString() });
				tasks.set(path, created);
				frontmatter.set(path, { ...(data.customFrontmatter ?? {}) });
				return { file: fileFor(path), taskInfo: created };
			}),
		},
		app: {
			vault: {
				getAbstractFileByPath: fileFor,
				getName: () => "notes",
				// The body lives in task.details here; real notes carry it below the frontmatter.
				read: async (file: TFile) => `---\ntitle: x\n---\n\n${tasks.get(file.path)?.details ?? ""}\n`,
			},
			metadataCache: { getFileCache: (file: TFile) => ({ frontmatter: frontmatter.get(file.path) ?? {} }) },
			fileManager: {
				processFrontMatter: async (file: TFile, update: (fm: Record<string, unknown>) => void) => {
					const fm = { ...(frontmatter.get(file.path) ?? {}) };
					update(fm);
					frontmatter.set(file.path, fm);
				},
			},
			loadLocalStorage: (key: string) => storage.get(key) ?? null,
			saveLocalStorage: (key: string, value: unknown) => {
				if (value === null) storage.delete(key);
				else storage.set(key, value);
			},
		},
	} as unknown as TaskNotesPlugin;

	const calendarService = { isConfigured: () => true, reportError: jest.fn(), client: server } as unknown as CalDAVCalendarService;
	const service = new CalDAVTaskSyncService(plugin, calendarService);
	return { service, plugin, storage };
}

function task(path: string, extra: Partial<TaskInfo> = {}): TaskInfo {
	return {
		path,
		title: path.replace(/\.md$/u, ""),
		status: "open",
		priority: "normal",
		archived: false,
		dateModified: "2026-09-01T00:00:00.000Z",
		...extra,
	} as TaskInfo;
}

describe("CalDAVTaskSyncService", () => {
	let services: CalDAVTaskSyncService[];
	beforeEach(() => {
		services = [];
	});
	afterEach(() => services.forEach((s) => s.destroy()));

	function setup(server = new FakeServer(), tasks = new Map<string, TaskInfo>(), fm = new Map<string, Record<string, unknown>>()) {
		const device = createDevice(server, tasks, fm);
		services.push(device.service);
		return { server, tasks, fm, ...device };
	}

	it("gives a new task a UID and creates its to-do", async () => {
		const { service, server, tasks, fm } = setup();
		tasks.set("pain.md", task("pain.md", { scheduled: "2026-09-25" }));

		await service.runPass(true);

		const uid = fm.get("pain.md")?.caldav_uid as string;
		expect(uid).toBeTruthy();
		const object = server.objects.get(`${TASKS_URL}${uid}.ics`)!;
		expect(readTodo(object.data)).toMatchObject({
			uid,
			title: "pain",
			date: "2026-09-25",
			dateField: "scheduled",
			priority: 5,
			completed: false,
		});
	});

	it("does not create a second to-do when another device syncs the same note", async () => {
		const server = new FakeServer();
		const fm = new Map<string, Record<string, unknown>>();
		const a = setup(server, new Map([["pain.md", task("pain.md")]]), fm);
		await a.service.runPass(true);

		// Device B receives the note (with its caldav_uid) through file sync.
		const b = setup(server, new Map([["pain.md", task("pain.md")]]), fm);
		await b.service.runPass(true);

		expect(server.objects.size).toBe(1);
	});

	it("brings completion and a new date from the phone into the note", async () => {
		const { service, server, tasks, fm, plugin } = setup();
		tasks.set("pain.md", task("pain.md", { scheduled: "2026-09-25" }));
		await service.runPass(true);
		const url = `${TASKS_URL}${fm.get("pain.md")!.caldav_uid as string}.ics`;

		server.editFromPhone(
			url,
			(ics) =>
				ics
					.replace("STATUS:NEEDS-ACTION", "STATUS:COMPLETED\r\nCOMPLETED:20260926T080000Z")
					.replace("DUE;VALUE=DATE:20260925", "DUE;VALUE=DATE:20260927"),
			"20990101T000000Z"
		);
		await service.runPass(true);

		const updateProperty = plugin.taskService.updateProperty as jest.Mock;
		expect(updateProperty).toHaveBeenCalledWith(expect.anything(), "status", "done");
		expect(updateProperty).toHaveBeenCalledWith(expect.anything(), "scheduled", "2026-09-27");
		expect(tasks.get("pain.md")).toMatchObject({ status: "done", scheduled: "2026-09-27" });
	});

	it("sends note changes made after the server copy", async () => {
		const { service, server, tasks, fm } = setup();
		tasks.set("pain.md", task("pain.md"));
		await service.runPass(true);
		const url = `${TASKS_URL}${fm.get("pain.md")!.caldav_uid as string}.ics`;

		tasks.set("pain.md", task("pain.md", { title: "Pain complet", dateModified: "2099-01-01T00:00:00.000Z" }));
		await service.runPass(true);

		expect(readTodo(server.objects.get(url)!.data)!.title).toBe("Pain complet");
	});

	it("leaves the server alone when nothing changed", async () => {
		const { service, server, tasks } = setup();
		tasks.set("pain.md", task("pain.md"));
		await service.runPass(true);
		server.putObject.mockClear();

		await service.runPass(true);

		expect(server.putObject).not.toHaveBeenCalled();
	});

	it("removes archived tasks from the server and forgets their UID", async () => {
		const { service, server, tasks, fm } = setup();
		tasks.set("pain.md", task("pain.md"));
		await service.runPass(true);

		tasks.set("pain.md", task("pain.md", { archived: true }));
		await service.runPass(true);

		expect(server.objects.size).toBe(0);
		expect(fm.get("pain.md")?.caldav_uid).toBeUndefined();
	});

	it("deletes the to-do of a deleted note, retrying later when offline", async () => {
		const { service, server, tasks, fm, storage } = setup();
		tasks.set("pain.md", task("pain.md"));
		await service.runPass(true);
		const prevCache = { frontmatter: { ...fm.get("pain.md") } };
		tasks.delete("pain.md");

		server.offline = true;
		await (service as unknown as { handleDeletedNote(c: unknown): Promise<void> }).handleDeletedNote(prevCache);
		expect(server.objects.size).toBe(1);
		expect(storage.size).toBe(1);

		server.offline = false;
		await service.runPass(true);
		expect(server.objects.size).toBe(0);
		expect(storage.size).toBe(0);
	});

	it("marks a repeating task's occurrence done instead of closing the task", async () => {
		const { service, server, tasks, fm, plugin } = setup();
		tasks.set("vit.md", task("vit.md", { scheduled: "2026-09-25", recurrence: "FREQ=DAILY" }));
		await service.runPass(true);
		const url = `${TASKS_URL}${fm.get("vit.md")!.caldav_uid as string}.ics`;

		server.editFromPhone(url, (ics) => ics.replace("STATUS:NEEDS-ACTION", "STATUS:COMPLETED"), "20990101T000000Z");
		await service.runPass(true);

		const toggle = plugin.taskService.toggleRecurringTaskComplete as jest.Mock;
		expect(toggle).toHaveBeenCalledTimes(1);
		expect((toggle.mock.calls[0][1] as Date).toISOString()).toBe("2026-09-25T00:00:00.000Z");
		expect(plugin.taskService.updateProperty).not.toHaveBeenCalled();
	});

	it("imports open to-dos created on a phone, once, keeping their UID", async () => {
		const { service, server, tasks, fm, plugin } = setup();
		const phoneTodo = (uid: string, summary: string, extra = "") =>
			["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTODO", `UID:${uid}`, `SUMMARY:${summary}`, "DTSTAMP:20260901T000000Z", "LAST-MODIFIED:20260901T000000Z", "DUE;VALUE=DATE:20260930", extra, "END:VTODO", "END:VCALENDAR"]
				.filter(Boolean)
				.join("\r\n");
		server.objects.set(`${TASKS_URL}PHONE-1.ics`, { data: phoneTodo("PHONE-1", "Appeler le garage"), etag: '"p1"' });
		server.objects.set(`${TASKS_URL}PHONE-2.ics`, { data: phoneTodo("PHONE-2", "Déjà fait", "STATUS:COMPLETED"), etag: '"p2"' });

		await service.runPass(true);
		await service.runPass(true);

		const createTask = plugin.taskService.createTask as jest.Mock;
		expect(createTask).toHaveBeenCalledTimes(1);
		expect(createTask.mock.calls[0][0]).toMatchObject({
			title: "Appeler le garage",
			due: "2026-09-30",
			customFrontmatter: { caldav_uid: "PHONE-1" },
		});
		expect(fm.get("TaskNotes/Tasks/Appeler le garage.md")?.caldav_uid).toBe("PHONE-1");
		expect(tasks.size).toBe(1);
		// The imported to-do is now marked as written by a note.
		expect(readTodo(server.objects.get(`${TASKS_URL}PHONE-1.ics`)!.data)!.managed).toBe(true);
	});

	it("never imports to-dos written by a note that has not reached this device", async () => {
		const server = new FakeServer();
		const a = setup(server, new Map([["pain.md", task("pain.md")]]));
		await a.service.runPass(true);

		const b = setup(server, new Map());
		await b.service.runPass(true);

		expect(b.plugin.taskService.createTask).not.toHaveBeenCalled();
	});

	it("keeps a phone alarm when rewriting the to-do", async () => {
		const { service, server, tasks, fm } = setup();
		tasks.set("pain.md", task("pain.md"));
		await service.runPass(true);
		const url = `${TASKS_URL}${fm.get("pain.md")!.caldav_uid as string}.ics`;
		server.editFromPhone(
			url,
			(ics) => ics.replace("END:VTODO", "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT5M\r\nEND:VALARM\r\nEND:VTODO"),
			"20260901T000000Z"
		);

		tasks.set("pain.md", task("pain.md", { title: "Renommé", dateModified: "2099-01-01T00:00:00.000Z" }));
		await service.runPass(true);

		expect(server.objects.get(url)!.data).toContain("BEGIN:VALARM");
	});

	it("sends the note's text as the to-do's notes", async () => {
		const { service, server, tasks, fm } = setup();
		tasks.set("pain.md", task("pain.md", { details: "Aux céréales\nDeux baguettes" }));
		await service.runPass(true);
		const url = `${TASKS_URL}${fm.get("pain.md")!.caldav_uid as string}.ics`;

		expect(readTodo(server.objects.get(url)!.data)!.description).toBe("Aux céréales\nDeux baguettes");

		tasks.set("pain.md", task("pain.md", { details: "Trois baguettes", dateModified: "2099-01-01T00:00:00.000Z" }));
		await service.runPass(true);

		expect(readTodo(server.objects.get(url)!.data)!.description).toBe("Trois baguettes");
	});

	it("brings text written on the phone into the note", async () => {
		const { service, server, tasks, fm, plugin } = setup();
		tasks.set("pain.md", task("pain.md", { details: "Aux céréales" }));
		await service.runPass(true);
		const url = `${TASKS_URL}${fm.get("pain.md")!.caldav_uid as string}.ics`;

		server.editFromPhone(
			url,
			(ics) => ics.replace(/DESCRIPTION:[^\r\n]*/u, "DESCRIPTION:Aux céréales\\nEt un croissant"),
			"20990101T000000Z"
		);
		await service.runPass(true);

		expect(plugin.taskService.updateTask).toHaveBeenCalledWith(expect.anything(), {
			details: "Aux céréales\nEt un croissant",
		});
		expect(tasks.get("pain.md")!.details).toBe("Aux céréales\nEt un croissant");
	});

	it("leaves the server alone when the note's text did not change", async () => {
		const { service, server, tasks } = setup();
		tasks.set("pain.md", task("pain.md", { details: "Aux céréales\n" }));
		await service.runPass(true);
		server.putObject.mockClear();

		tasks.set("pain.md", task("pain.md", { details: "Aux céréales", dateModified: "2099-01-01T00:00:00.000Z" }));
		await service.runPass(true);

		expect(server.putObject).not.toHaveBeenCalled();
	});
});
