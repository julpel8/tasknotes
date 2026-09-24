import ICAL from "ical.js";
import type { CalendarEventData, EventDateTime } from "../CalendarProvider";
import { wallTimeInZoneToUtcIso } from "../../utils/icsTimezoneFallback";

export const TASKNOTES_PRODID = "-//TaskNotes//CalDAV//EN";

/**
 * Converts a provider date (all-day date or wall-clock time in a zone) into an
 * ICAL.Time. Timed values are written in UTC so no VTIMEZONE is needed.
 */
export function eventDateTimeToIcalTime(value: EventDateTime): ICAL.Time {
	if (value.date) {
		return ICAL.Time.fromDateString(value.date);
	}
	if (!value.dateTime) {
		throw new Error("Event date has neither date nor dateTime");
	}

	const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(value.dateTime);
	let utcIso: string;
	if (hasOffset || !value.timeZone) {
		utcIso = new Date(value.dateTime).toISOString();
	} else {
		const wallTime = ICAL.Time.fromDateTimeString(value.dateTime.slice(0, 19));
		utcIso = wallTimeInZoneToUtcIso(wallTime, value.timeZone);
	}
	return ICAL.Time.fromJSDate(new Date(utcIso), true);
}

export function createCalendarComponent(): ICAL.Component {
	const calendar = new ICAL.Component(["vcalendar", [], []]);
	calendar.updatePropertyWithValue("prodid", TASKNOTES_PRODID);
	calendar.updatePropertyWithValue("version", "2.0");
	return calendar;
}

export function nowUtc(): ICAL.Time {
	return ICAL.Time.fromJSDate(new Date(), true);
}

export function setOptionalText(component: ICAL.Component, name: string, value?: string): void {
	if (value === undefined) return;
	if (value === "") {
		component.removeAllProperties(name);
	} else {
		component.updatePropertyWithValue(name, value);
	}
}

function setDateProperty(component: ICAL.Component, name: string, value: EventDateTime): void {
	component.removeAllProperties(name);
	component.addPropertyWithValue(name, eventDateTimeToIcalTime(value));
}

/**
 * Builds a complete iCalendar document holding one VEVENT.
 */
export function buildEventCalendar(uid: string, data: CalendarEventData): string {
	const calendar = createCalendarComponent();
	const vevent = new ICAL.Component("vevent");
	vevent.updatePropertyWithValue("uid", uid);
	vevent.updatePropertyWithValue("dtstamp", nowUtc());
	vevent.updatePropertyWithValue("created", nowUtc());
	vevent.updatePropertyWithValue("last-modified", nowUtc());
	vevent.updatePropertyWithValue("summary", data.summary);
	setOptionalText(vevent, "description", data.description);
	setOptionalText(vevent, "location", data.location);
	setDateProperty(vevent, "dtstart", data.start);
	setDateProperty(vevent, "dtend", data.end);
	calendar.addSubcomponent(vevent);
	return calendar.toString();
}

/**
 * Returns the series master (or single) component of the given type.
 */
export function findMasterComponent(
	calendar: ICAL.Component,
	type: "vevent" | "vtodo"
): ICAL.Component | null {
	const components = calendar.getAllSubcomponents(type);
	return components.find((component) => !component.hasProperty("recurrence-id")) ?? null;
}

/**
 * Applies partial event changes to an existing iCalendar document and returns
 * the updated text. Unknown properties (alarms, attendees…) are kept.
 */
export function applyEventUpdates(icsText: string, updates: Partial<CalendarEventData>): string {
	const calendar = new ICAL.Component(ICAL.parse(icsText));
	const vevent = findMasterComponent(calendar, "vevent");
	if (!vevent) {
		throw new Error("Calendar object has no event");
	}

	if (updates.summary !== undefined) vevent.updatePropertyWithValue("summary", updates.summary);
	setOptionalText(vevent, "description", updates.description);
	setOptionalText(vevent, "location", updates.location);
	if (updates.start) {
		setDateProperty(vevent, "dtstart", updates.start);
		vevent.removeAllProperties("duration");
	}
	if (updates.end) {
		setDateProperty(vevent, "dtend", updates.end);
		vevent.removeAllProperties("duration");
	}

	const sequence = Number(vevent.getFirstPropertyValue("sequence") ?? 0);
	vevent.updatePropertyWithValue("sequence", Number.isFinite(sequence) ? sequence + 1 : 1);
	vevent.updatePropertyWithValue("dtstamp", nowUtc());
	vevent.updatePropertyWithValue("last-modified", nowUtc());
	return calendar.toString();
}

export function isRecurringCalendarObject(icsText: string, type: "vevent" | "vtodo"): boolean {
	const calendar = new ICAL.Component(ICAL.parse(icsText));
	const master = findMasterComponent(calendar, type);
	return Boolean(master?.hasProperty("rrule") || master?.hasProperty("rdate"));
}

export function generateUid(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Resource URL of an object inside a collection, named after its UID. */
export function objectUrlForUid(collectionUrl: string, uid: string): string {
	const base = collectionUrl.endsWith("/") ? collectionUrl : `${collectionUrl}/`;
	return `${base}${encodeURIComponent(uid)}.ics`;
}
