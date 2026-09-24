jest.mock("ical.js", () => {
	const actualICAL = jest.requireActual("../../../node_modules/ical.js/dist/ical.es5.cjs");
	return actualICAL;
});

import type TaskNotesPlugin from "../../../src/main";
import { DEFAULT_CALDAV_SETTINGS } from "../../../src/settings/defaults";
import {
	CalDAVCalendarService,
	caldavSubscriptionId,
} from "../../../src/services/caldav/CalDAVCalendarService";
import type { CalDAVObject } from "../../../src/services/caldav/CalDAVClient";

const CALENDAR = "https://cal.example.com/dav.php/calendars/alice/default/";

function vevent(uid: string, extra = "", start = "20260925T080000Z", end = "20260925T090000Z"): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Test//EN",
		"BEGIN:VEVENT",
		`UID:${uid}`,
		"DTSTAMP:20260901T000000Z",
		`DTSTART:${start}`,
		`DTEND:${end}`,
		`SUMMARY:${uid} title`,
		extra,
		"END:VEVENT",
		"END:VCALENDAR",
	]
		.filter(Boolean)
		.join("\r\n");
}

function createService(objects: CalDAVObject[]) {
	const plugin = {
		settings: {
			caldav: {
				...DEFAULT_CALDAV_SETTINGS,
				enabled: true,
				serverUrl: "https://cal.example.com/dav.php/",
				username: "alice",
				calendars: [
					{ url: CALENDAR, name: "Default", color: "#ff0000", components: ["VEVENT", "VTODO"], enabled: true },
				],
			},
		},
		app: { secretStorage: { getSecret: () => "pw", setSecret: jest.fn() } },
		saveSettings: jest.fn(),
	} as unknown as TaskNotesPlugin;

	const service = new CalDAVCalendarService(plugin);
	const client = service.client as unknown as Record<string, jest.Mock>;
	client.fetchObjects = jest.fn().mockResolvedValue(objects);
	client.putObject = jest.fn().mockResolvedValue('"etag-new"');
	client.deleteObject = jest.fn().mockResolvedValue(undefined);
	return { service, client };
}

describe("CalDAVCalendarService", () => {
	it("loads events of enabled calendars with the calendar color", async () => {
		const { service } = createService([
			{ url: `${CALENDAR}a.ics`, etag: '"a1"', data: vevent("a") },
		]);
		await service.refresh();

		const events = service.getAllEvents();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			title: "a title",
			start: "2026-09-25T08:00:00.000Z",
			color: "#ff0000",
			subscriptionId: caldavSubscriptionId(CALENDAR),
		});
		expect(service.ownsEvent(events[0])).toBe(true);
		expect(service.extractEventIds(events[0])).toEqual({ calendarId: CALENDAR, eventId: events[0].id });
	});

	it("updates an event with its etag and keeps other events", async () => {
		const { service, client } = createService([
			{ url: `${CALENDAR}a.ics`, etag: '"a1"', data: vevent("a") },
			{ url: `${CALENDAR}b.ics`, etag: '"b1"', data: vevent("b") },
		]);
		await service.refresh();
		const eventA = service.getAllEvents().find((e) => e.title === "a title")!;

		const updated = await service.updateEvent(CALENDAR, eventA.id, {
			start: { dateTime: "2026-09-25T14:00:00", timeZone: "Europe/Paris" },
			end: { dateTime: "2026-09-25T15:00:00", timeZone: "Europe/Paris" },
		});

		expect(client.putObject).toHaveBeenCalledWith(`${CALENDAR}a.ics`, expect.stringContaining("SEQUENCE:1"), {
			etag: '"a1"',
		});
		const written = client.putObject.mock.calls[0][1] as string;
		expect(written).toContain("DTSTART:20260925T120000Z");
		expect(updated.start).toBe("2026-09-25T12:00:00.000Z");
		expect(service.getAllEvents().map((e) => e.title).sort()).toEqual(["a title", "b title"]);
	});

	it("refuses to move a repeating event", async () => {
		const { service, client } = createService([
			{ url: `${CALENDAR}r.ics`, etag: '"r1"', data: vevent("r", "RRULE:FREQ=WEEKLY;COUNT=3") },
		]);
		await service.refresh();
		const instance = service.getAllEvents()[0];
		expect(instance.recurringEventId).toBeDefined();

		await expect(
			service.updateEvent(CALENDAR, instance.id, { start: { date: "2026-09-26" }, end: { date: "2026-09-27" } })
		).rejects.toThrow("repeating");
		expect(client.putObject).not.toHaveBeenCalled();
	});

	it("creates an event named after its UID without overwriting", async () => {
		const { service, client } = createService([]);
		await service.refresh();

		const created = await service.createEvent(CALENDAR, {
			summary: "Nouveau",
			start: { date: "2026-10-01" },
			end: { date: "2026-10-02" },
		});

		const [url, data, options] = client.putObject.mock.calls[0];
		expect(url).toMatch(/^https:\/\/cal\.example\.com\/dav\.php\/calendars\/alice\/default\/.+\.ics$/);
		expect(options).toEqual({ createOnly: true });
		expect(data).toContain("DTSTART;VALUE=DATE:20261001");
		expect(created).toMatchObject({ title: "Nouveau", allDay: true, start: "2026-10-01" });
		expect(service.getAllEvents()).toHaveLength(1);
	});

	it("deletes every instance of a deleted series", async () => {
		const { service, client } = createService([
			{ url: `${CALENDAR}r.ics`, etag: '"r1"', data: vevent("r", "RRULE:FREQ=DAILY;COUNT=3") },
			{ url: `${CALENDAR}b.ics`, etag: '"b1"', data: vevent("b") },
		]);
		await service.refresh();
		const instance = service.getAllEvents().find((e) => e.recurringEventId)!;

		await service.deleteEvent(CALENDAR, instance.id);

		expect(client.deleteObject).toHaveBeenCalledWith(`${CALENDAR}r.ics`, '"r1"');
		expect(service.getAllEvents().map((e) => e.title)).toEqual(["b title"]);
	});

	it("shows nothing when the integration is disabled", async () => {
		const { service } = createService([{ url: `${CALENDAR}a.ics`, data: vevent("a") }]);
		await service.refresh();
		(service as unknown as { plugin: TaskNotesPlugin }).plugin.settings.caldav.enabled = false;
		expect(service.getAllEvents()).toEqual([]);
		expect(service.getAvailableCalendars()).toEqual([]);
	});
});
