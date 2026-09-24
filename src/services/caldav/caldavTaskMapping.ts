import ICAL from "ical.js";
import { format } from "date-fns";
import { icalTimeToISOString, rawTzidOf, registerCalendarVTimezones } from "../../utils/icsParsing";
import { createCalendarComponent, findMasterComponent, nowUtc, setOptionalText } from "./icalObjects";

/** Frontmatter key linking a task note to its CalDAV to-do. */
export const CALDAV_UID_FIELD = "caldav_uid";

/** Records which task field the to-do's DUE came from, so changes flow back to it. */
const DATE_FIELD_PROPERTY = "x-tasknotes-date-field";

export type TaskDateField = "due" | "scheduled";

/** The task fields a CalDAV to-do carries. */
export interface TodoFields {
	title: string;
	completed: boolean;
	/** TaskNotes date string: YYYY-MM-DD or local YYYY-MM-DDTHH:mm */
	date?: string;
	dateField: TaskDateField;
	/** iCalendar priority: 1 (highest) to 9 (lowest); undefined for none */
	priority?: number;
	/** Link back to the note; written but never compared */
	url?: string;
}

export interface TodoSnapshot extends TodoFields {
	uid: string;
	/** Epoch milliseconds of LAST-MODIFIED (or DTSTAMP) */
	lastModified?: number;
}

/**
 * Normalizes a TaskNotes date so values from notes and from the server compare
 * equal: date-only stays YYYY-MM-DD, timed values become local YYYY-MM-DDTHH:mm.
 */
export function normalizeTaskDate(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) return trimmed;
	const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(trimmed);
	const parsed = hasOffset ? new Date(trimmed) : new Date(trimmed.slice(0, 16));
	if (isNaN(parsed.getTime())) return trimmed;
	return format(parsed, "yyyy-MM-dd'T'HH:mm");
}

/** Picks the date a to-do shows: due when set, otherwise scheduled. */
export function pickTaskDate(task: { due?: string; scheduled?: string }): {
	date?: string;
	dateField: TaskDateField;
} {
	if (task.due) return { date: normalizeTaskDate(task.due), dateField: "due" };
	if (task.scheduled) return { date: normalizeTaskDate(task.scheduled), dateField: "scheduled" };
	return { date: undefined, dateField: "due" };
}

/**
 * Maps priority weights onto the iCalendar 1–9 scale: the heaviest priority is
 * 1, the lightest 9, and weight 0 (none) has no priority.
 */
export function priorityToIcal(
	value: string,
	priorities: { value: string; weight: number }[]
): number | undefined {
	const ranked = priorities
		.filter((priority) => priority.weight > 0)
		.sort((a, b) => b.weight - a.weight);
	const index = ranked.findIndex((priority) => priority.value === value);
	if (index < 0) return undefined;
	if (ranked.length === 1) return 5;
	return Math.round(1 + (8 * index) / (ranked.length - 1));
}

function taskDateToIcalTime(value: string): ICAL.Time {
	if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return ICAL.Time.fromDateString(value);
	return ICAL.Time.fromJSDate(new Date(value), true);
}

function textValue(component: ICAL.Component, name: string): string {
	const value = component.getFirstPropertyValue(name);
	return typeof value === "string" ? value : "";
}

function icalTimeToTaskDate(time: ICAL.Time, rawTzid: string | null): string {
	if (time.isDate) return icalTimeToISOString(time, rawTzid);
	return format(new Date(icalTimeToISOString(time, rawTzid)), "yyyy-MM-dd'T'HH:mm");
}

/**
 * Reads the master VTODO of a calendar object. Returns null for objects that
 * hold no to-do.
 */
export function readTodo(icsText: string): TodoSnapshot | null {
	const calendar = new ICAL.Component(ICAL.parse(icsText));
	registerCalendarVTimezones(calendar);
	const vtodo = findMasterComponent(calendar, "vtodo");
	if (!vtodo) return null;

	const status = textValue(vtodo, "status").toUpperCase();
	const completed = status === "COMPLETED" || vtodo.hasProperty("completed");

	const due = vtodo.getFirstPropertyValue("due");
	const date = due instanceof ICAL.Time ? icalTimeToTaskDate(due, rawTzidOf(vtodo, "due")) : undefined;

	const dateFieldValue = textValue(vtodo, DATE_FIELD_PROPERTY);
	const priorityValue = Number(vtodo.getFirstPropertyValue("priority") ?? 0);
	const modified =
		vtodo.getFirstPropertyValue("last-modified") ?? vtodo.getFirstPropertyValue("dtstamp");

	return {
		uid: textValue(vtodo, "uid"),
		title: textValue(vtodo, "summary"),
		completed,
		date,
		dateField: dateFieldValue === "scheduled" ? "scheduled" : "due",
		priority: priorityValue >= 1 && priorityValue <= 9 ? priorityValue : undefined,
		url: undefined,
		lastModified:
			modified instanceof ICAL.Time ? new Date(icalTimeToISOString(modified)).getTime() : undefined,
	};
}

/** True when the fields a note controls differ from the server copy. */
export function todoDiffers(local: TodoFields, server: TodoFields): boolean {
	return (
		local.title !== server.title ||
		local.completed !== server.completed ||
		(local.date ?? "") !== (server.date ?? "") ||
		(local.date ? local.dateField !== server.dateField : false) ||
		(local.priority ?? 0) !== (server.priority ?? 0)
	);
}

/**
 * Writes task fields into a to-do. With an existing object, other properties
 * (alarms set on a phone, notes, categories…) are kept.
 */
export function writeTodo(existingIcs: string | null, uid: string, fields: TodoFields): string {
	let calendar: ICAL.Component;
	let vtodo: ICAL.Component | null = null;
	if (existingIcs) {
		calendar = new ICAL.Component(ICAL.parse(existingIcs));
		vtodo = findMasterComponent(calendar, "vtodo");
	} else {
		calendar = createCalendarComponent();
	}
	if (!vtodo) {
		vtodo = new ICAL.Component("vtodo");
		vtodo.updatePropertyWithValue("uid", uid);
		vtodo.updatePropertyWithValue("created", nowUtc());
		calendar.addSubcomponent(vtodo);
	}

	vtodo.updatePropertyWithValue("summary", fields.title);

	if (fields.completed) {
		vtodo.updatePropertyWithValue("status", "COMPLETED");
		vtodo.updatePropertyWithValue("percent-complete", 100);
		if (!vtodo.hasProperty("completed")) vtodo.updatePropertyWithValue("completed", nowUtc());
	} else {
		vtodo.updatePropertyWithValue("status", "NEEDS-ACTION");
		vtodo.removeAllProperties("percent-complete");
		vtodo.removeAllProperties("completed");
	}

	vtodo.removeAllProperties("due");
	if (fields.date) {
		vtodo.addPropertyWithValue("due", taskDateToIcalTime(fields.date));
		vtodo.updatePropertyWithValue(DATE_FIELD_PROPERTY, fields.dateField);
		// A DTSTART after the new DUE would make the to-do invalid.
		vtodo.removeAllProperties("dtstart");
	} else {
		vtodo.removeAllProperties(DATE_FIELD_PROPERTY);
	}

	if (fields.priority) {
		vtodo.updatePropertyWithValue("priority", fields.priority);
	} else {
		vtodo.removeAllProperties("priority");
	}

	setOptionalText(vtodo, "url", fields.url);
	vtodo.updatePropertyWithValue("dtstamp", nowUtc());
	vtodo.updatePropertyWithValue("last-modified", nowUtc());
	return calendar.toString();
}
