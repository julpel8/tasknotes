import type TaskNotesPlugin from "../../../src/main";
import type { ICSEvent, TaskInfo } from "../../../src/types";
import {
	canConvertEventToTask,
	convertEventToTask,
	getTaskEventTimes,
} from "../../../src/ui/taskEventConversion";

function task(extra: Partial<TaskInfo>): TaskInfo {
	return { path: "t.md", title: "T", status: "open", priority: "normal", archived: false, ...extra } as TaskInfo;
}

describe("taskEventConversion", () => {
	it("uses an all-day event for date-only tasks", () => {
		const times = getTaskEventTimes(task({ scheduled: "2026-09-25", due: "2026-09-30" }));
		expect(times.allDay).toBe(true);
		expect(times.start).toEqual(new Date(2026, 8, 25));
		expect(times.end).toEqual(new Date(2026, 8, 26));
	});

	it("uses the time estimate for timed tasks", () => {
		const times = getTaskEventTimes(task({ due: "2026-09-25T14:30", timeEstimate: 45 }));
		expect(times.allDay).toBe(false);
		expect(times.start).toEqual(new Date(2026, 8, 25, 14, 30));
		expect(times.end).toEqual(new Date(2026, 8, 25, 15, 15));
	});

	it("falls back to today for tasks without a date", () => {
		const times = getTaskEventTimes(task({}), new Date(2026, 8, 24, 16, 0));
		expect(times).toEqual({ start: new Date(2026, 8, 24), end: new Date(2026, 8, 25), allDay: true });
	});

	describe("event to task", () => {
		const event = { id: "caldav-x-uid", subscriptionId: "caldav-x", title: "RDV", start: "2026-09-25", allDay: true } as ICSEvent;

		function plugin(deleteEvent: jest.Mock) {
			const provider = { extractEventIds: () => ({ calendarId: "cal", eventId: event.id }), deleteEvent };
			return {
				i18n: { translate: (key: string) => key },
				calendarProviderRegistry: { findProviderForEvent: () => provider },
				icsNoteService: {
					createTaskFromICS: jest.fn(async () => ({ file: { path: "TaskNotes/Tasks/RDV.md" }, taskInfo: { title: "RDV" } })),
				},
				app: { vault: { getAbstractFileByPath: () => null } },
			} as unknown as TaskNotesPlugin;
		}

		it("creates the task then deletes the event", async () => {
			const deleteEvent = jest.fn().mockResolvedValue(undefined);
			const p = plugin(deleteEvent);
			await expect(convertEventToTask(p, event)).resolves.toBe("TaskNotes/Tasks/RDV.md");
			expect(p.icsNoteService.createTaskFromICS).toHaveBeenCalledWith(event);
			expect(deleteEvent).toHaveBeenCalledWith("cal", event.id);
		});

		it("keeps the task when the event cannot be deleted", async () => {
			const p = plugin(jest.fn().mockRejectedValue(new Error("offline")));
			await expect(convertEventToTask(p, event)).resolves.toBe("TaskNotes/Tasks/RDV.md");
			expect(p.icsNoteService.createTaskFromICS).toHaveBeenCalled();
		});

		it("is not offered for an occurrence of a repeating event", () => {
			const p = plugin(jest.fn());
			expect(canConvertEventToTask(p, event)).toBe(true);
			expect(canConvertEventToTask(p, { ...event, recurringEventId: "caldav-x-series" })).toBe(false);
		});
	});
});
