import { describe, expect, it } from "@jest/globals";
import { buildExternalCalendarEvents } from "../../../src/bases/calendarExternalEvents";
import { caldavSubscriptionId } from "../../../src/services/caldav/caldavIds";
import type { ICSEvent } from "../../../src/types";

const calendarUrl = "https://dav.example.com/dav.php/calendars/julien/default/";
const subscriptionId = caldavSubscriptionId(calendarUrl);

function createEvent(): ICSEvent {
	return {
		id: `${subscriptionId}-event-1`,
		subscriptionId,
		title: "Rendez-vous",
		start: "2026-09-29T10:30:00",
		end: "2026-09-29T11:30:00",
		allDay: false,
		color: "#007AFF",
	};
}

function createPlugin() {
	return {
		icsSubscriptionService: { getSubscriptions: () => [] },
		caldavCalendarService: {
			getAvailableCalendars: () => [{ id: calendarUrl, summary: "Default calendar" }],
		},
	};
}

describe("CalDAV events in calendar views", () => {
	it("renders CalDAV events as editable events named after their calendar", () => {
		const [event] = buildExternalCalendarEvents({
			events: [createEvent()],
			provider: "caldav",
			plugin: createPlugin() as any,
		});

		expect(event).toBeDefined();
		expect(event.title).toBe("Rendez-vous");
		expect(event.editable).toBe(true);
		expect(event.borderColor).toBe("#007AFF");
		expect(event.extendedProps?.subscriptionName).toBe("Default calendar");
	});

	it("hides CalDAV events of a calendar toggled off in the view", () => {
		const events = buildExternalCalendarEvents({
			events: [createEvent()],
			provider: "caldav",
			plugin: createPlugin() as any,
			toggles: new Map([[subscriptionId, false]]),
		});

		expect(events).toHaveLength(0);
	});
});
