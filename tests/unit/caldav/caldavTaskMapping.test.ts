jest.mock("ical.js", () => {
	const actualICAL = jest.requireActual("../../../node_modules/ical.js/dist/ical.es5.cjs");
	return actualICAL;
});

import {
	normalizeTaskDate,
	pickTaskDate,
	priorityToIcal,
	readTodo,
	todoDiffers,
	writeTodo,
	type TodoFields,
} from "../../../src/services/caldav/caldavTaskMapping";

const PRIORITIES = [
	{ value: "none", weight: 0 },
	{ value: "low", weight: 1 },
	{ value: "normal", weight: 2 },
	{ value: "high", weight: 3 },
];

const fields: TodoFields = {
	title: "Acheter du pain",
	completed: false,
	date: "2026-09-25",
	dateField: "scheduled",
	priority: 5,
	url: "obsidian://open?vault=notes&file=a.md",
};

describe("caldavTaskMapping", () => {
	it("maps priority weights onto the 1-9 scale", () => {
		expect(priorityToIcal("high", PRIORITIES)).toBe(1);
		expect(priorityToIcal("normal", PRIORITIES)).toBe(5);
		expect(priorityToIcal("low", PRIORITIES)).toBe(9);
		expect(priorityToIcal("none", PRIORITIES)).toBeUndefined();
	});

	it("prefers due over scheduled and normalizes times", () => {
		expect(pickTaskDate({ due: "2026-09-25", scheduled: "2026-09-20" })).toEqual({
			date: "2026-09-25",
			dateField: "due",
		});
		expect(pickTaskDate({ scheduled: "2026-09-20T09:30:00" })).toEqual({
			date: "2026-09-20T09:30",
			dateField: "scheduled",
		});
		expect(pickTaskDate({})).toEqual({ date: undefined, dateField: "due" });
		expect(normalizeTaskDate("2026-09-20T09:30")).toBe("2026-09-20T09:30");
	});

	it("round-trips a to-do", () => {
		const ics = writeTodo(null, "uid-1", fields);
		expect(ics).toContain("DUE;VALUE=DATE:20260925");
		expect(ics).toContain("STATUS:NEEDS-ACTION");
		const read = readTodo(ics)!;
		expect(read).toMatchObject({
			uid: "uid-1",
			title: "Acheter du pain",
			completed: false,
			date: "2026-09-25",
			dateField: "scheduled",
			priority: 5,
		});
		expect(read.lastModified).toBeGreaterThan(0);
		expect(todoDiffers(fields, read)).toBe(false);
	});

	it("round-trips a timed date through UTC", () => {
		const ics = writeTodo(null, "uid-2", { ...fields, date: "2026-09-25T14:30", dateField: "due" });
		expect(ics).toMatch(/DUE:\d{8}T\d{6}Z/u);
		expect(readTodo(ics)!.date).toBe("2026-09-25T14:30");
	});

	it("keeps phone-side properties and toggles completion", () => {
		const phone = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Apple Inc.//iOS//EN",
			"BEGIN:VTODO",
			"UID:uid-3",
			"DTSTAMP:20260924T100000Z",
			"LAST-MODIFIED:20260924T100000Z",
			"SUMMARY:Old",
			"STATUS:COMPLETED",
			"COMPLETED:20260924T100000Z",
			"BEGIN:VALARM",
			"ACTION:DISPLAY",
			"TRIGGER:-PT15M",
			"END:VALARM",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		expect(readTodo(phone)!.completed).toBe(true);

		const reopened = writeTodo(phone, "uid-3", { ...fields, date: undefined });
		expect(reopened).toContain("BEGIN:VALARM");
		expect(reopened).toContain("STATUS:NEEDS-ACTION");
		expect(reopened).not.toContain("COMPLETED:");
		expect(reopened).not.toContain("DUE");
		expect(readTodo(reopened)).toMatchObject({ title: "Acheter du pain", completed: false });
	});

	it("reads a DUE written with a time zone by a phone", () => {
		const phone = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"BEGIN:VTIMEZONE",
			"TZID:Europe/Paris",
			"BEGIN:DAYLIGHT",
			"TZOFFSETFROM:+0100",
			"TZOFFSETTO:+0200",
			"DTSTART:19810329T020000",
			"RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
			"END:DAYLIGHT",
			"BEGIN:STANDARD",
			"TZOFFSETFROM:+0200",
			"TZOFFSETTO:+0100",
			"DTSTART:19961027T030000",
			"RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
			"END:STANDARD",
			"END:VTIMEZONE",
			"BEGIN:VTODO",
			"UID:uid-4",
			"SUMMARY:RDV",
			"DUE;TZID=Europe/Paris:20260925T100000",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		const expected = new Date("2026-09-25T08:00:00Z");
		const pad = (n: number) => String(n).padStart(2, "0");
		expect(readTodo(phone)!.date).toBe(
			`${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())}T${pad(expected.getHours())}:${pad(expected.getMinutes())}`
		);
	});

	it("detects note-controlled differences only", () => {
		const server = { ...fields, url: "something else" };
		expect(todoDiffers(fields, server)).toBe(false);
		expect(todoDiffers(fields, { ...server, completed: true })).toBe(true);
		expect(todoDiffers(fields, { ...server, date: "2026-09-26" })).toBe(true);
		expect(todoDiffers(fields, { ...server, title: "Autre" })).toBe(true);
	});
});
