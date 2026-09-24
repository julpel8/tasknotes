import { Notice } from "obsidian";
import type TaskNotesPlugin from "../main";
import type { ICSEvent, TaskInfo } from "../types";
import { CalendarEventCreationModal } from "../modals/CalendarEventCreationModal";
import { createTaskNotesLogger } from "../utils/tasknotesLogger";

const tasknotesLogger = createTaskNotesLogger({ tag: "UI/TaskEventConversion" });

const DEFAULT_EVENT_MINUTES = 60;

export interface TaskEventTimes {
	start: Date;
	end: Date;
	allDay: boolean;
}

/**
 * Event times for a task: its scheduled date (else due date). Date-only values
 * give an all-day event; timed values last the time estimate (default one
 * hour). A task without a date becomes an all-day event today.
 */
export function getTaskEventTimes(task: TaskInfo, now = new Date()): TaskEventTimes {
	const value = task.scheduled || task.due;
	const dateOnly = !value || /^\d{4}-\d{2}-\d{2}$/u.test(value);

	if (dateOnly) {
		const start = value
			? new Date(`${value}T00:00:00`)
			: new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const end = new Date(start);
		end.setDate(end.getDate() + 1);
		return { start, end, allDay: true };
	}

	const start = new Date(value.slice(0, 16));
	const minutes = task.timeEstimate && task.timeEstimate > 0 ? task.timeEstimate : DEFAULT_EVENT_MINUTES;
	return { start, end: new Date(start.getTime() + minutes * 60 * 1000), allDay: false };
}

function hasWritableCalendar(plugin: TaskNotesPlugin): boolean {
	return (
		plugin.calendarProviderRegistry
			?.getAllProviders()
			.some((provider) => provider.getAvailableCalendars().length > 0) ?? false
	);
}

/**
 * Opens the event creation dialog filled from the task. Once the event exists,
 * the task is archived, which also removes its CalDAV to-do.
 */
export function openConvertTaskToEvent(plugin: TaskNotesPlugin, task: TaskInfo): void {
	const translate = plugin.i18n.translate.bind(plugin.i18n);
	if (!hasWritableCalendar(plugin)) {
		new Notice(translate("taskEventConversion.notices.noWritableCalendar"));
		return;
	}

	const times = getTaskEventTimes(task);
	const vault = encodeURIComponent(plugin.app.vault.getName());
	const link = `obsidian://open?vault=${vault}&file=${encodeURIComponent(task.path)}`;
	const description = [task.details?.trim(), link].filter(Boolean).join("\n\n");

	new CalendarEventCreationModal(plugin.app, plugin, {
		...times,
		initialTitle: task.title,
		initialDescription: description,
		onEventCreated: () => {
			void (async () => {
				try {
					const fresh = (await plugin.cacheManager.getTaskInfo(task.path)) ?? task;
					if (!fresh.archived) await plugin.taskService.toggleArchive(fresh);
					new Notice(translate("taskEventConversion.notices.taskConverted", { title: task.title }));
				} catch (error) {
					tasknotesLogger.error("Failed to archive task after converting it to an event", {
						category: "provider",
						operation: "convert-task-to-event",
						error,
					});
					new Notice(translate("taskEventConversion.notices.archiveFailed"));
				}
			})();
		},
	}).open();
}

/** A provider event that can be turned into a task (not part of a series). */
export function canConvertEventToTask(plugin: TaskNotesPlugin, icsEvent: ICSEvent): boolean {
	if (icsEvent.recurringEventId) return false;
	return Boolean(plugin.calendarProviderRegistry?.findProviderForEvent(icsEvent));
}

/**
 * Creates a task from a calendar event, then deletes the event. If the deletion
 * fails the task is kept and the user is told the event is still there.
 * Returns the new task's path.
 */
export async function convertEventToTask(
	plugin: TaskNotesPlugin,
	icsEvent: ICSEvent
): Promise<string | null> {
	const translate = plugin.i18n.translate.bind(plugin.i18n);
	const provider = plugin.calendarProviderRegistry?.findProviderForEvent(icsEvent);
	if (!provider) return null;

	const result = await plugin.icsNoteService.createTaskFromICS(icsEvent);
	try {
		const { calendarId, eventId } = provider.extractEventIds(icsEvent);
		await provider.deleteEvent(calendarId, eventId);
		new Notice(translate("taskEventConversion.notices.eventConverted", { title: result.taskInfo.title }));
	} catch (error) {
		tasknotesLogger.error("Task created but the event could not be deleted", {
			category: "provider",
			operation: "convert-event-to-task",
			error,
		});
		new Notice(translate("taskEventConversion.notices.eventDeleteFailed"));
	}

	return result.file.path;
}
