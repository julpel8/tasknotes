/* eslint-disable @typescript-eslint/no-non-null-assertion -- ICS parsing normalizes optional event fields before use. */
import ICAL from "ical.js";
import { getICSCalendarOwnerEmail, getICSOwnerDeclined } from "./icsAttendeeFiltering";
import { ICSEvent } from "../types";
import { createTaskNotesLogger } from "./tasknotesLogger";
import { resolveTzidToIANA, wallTimeInZoneToUtcIso } from "./icsTimezoneFallback";

const tasknotesLogger = createTaskNotesLogger({ tag: "Utils/icsParsing" });

const ICS_RECURRENCE_EXPANSION_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_RECURRING_ICS_VISIBLE_INSTANCES = 3000;
const MAX_RECURRING_ICS_ITERATIONS = 10000;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function getVTimezoneTzid(vtimezone: ICAL.Component): string | null {
	const value = vtimezone.getFirstPropertyValue("tzid");
	return typeof value === "string" ? value.trim() : null;
}

function getVTimezoneAliases(tzid: string): string[] {
	const alias = tzid.replace(/\s+\([^)]+\)$/u, "").trim();
	return alias && alias !== tzid ? [alias] : [];
}

function findVTimezone(calendar: ICAL.Component, tzid: string): ICAL.Component | null {
	return (
		calendar
			.getAllSubcomponents("vtimezone")
			.find((vtimezone) => getVTimezoneTzid(vtimezone) === tzid) ?? null
	);
}

function cloneVTimezoneWithTzid(vtimezone: ICAL.Component, tzid: string): ICAL.Component {
	const aliasVTimezone = new ICAL.Component(
		JSON.parse(JSON.stringify(vtimezone.toJSON())) as unknown[]
	);
	aliasVTimezone.updatePropertyWithValue("tzid", tzid);
	return aliasVTimezone;
}

export function registerCalendarVTimezones(calendar: ICAL.Component): void {
	const vtimezones = calendar.getAllSubcomponents("vtimezone");

	vtimezones.forEach((vtimezone) => {
		const tzid = getVTimezoneTzid(vtimezone);
		ICAL.TimezoneService.register(vtimezone);

		if (!tzid) {
			return;
		}

		getVTimezoneAliases(tzid).forEach((alias) => {
			const existingAliasVTimezone = findVTimezone(calendar, alias);
			const aliasVTimezone =
				existingAliasVTimezone ?? cloneVTimezoneWithTzid(vtimezone, alias);
			const timezone = new ICAL.Timezone({
				component: aliasVTimezone,
				tzid: alias,
			});

			if (!existingAliasVTimezone) {
				calendar.addSubcomponent(aliasVTimezone);
			}

			ICAL.TimezoneService.register(timezone);
		});
	});
}

function dateOnlyToUtcMs(dateString: string): number | null {
	if (!DATE_ONLY_PATTERN.test(dateString)) {
		return null;
	}

	const [year, month, day] = dateString.split("-").map(Number);
	return Date.UTC(year, month - 1, day);
}

function formatUtcDateOnly(date: Date): string {
	const year = date.getUTCFullYear().toString().padStart(4, "0");
	const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
	const day = date.getUTCDate().toString().padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function getDateOnlyDurationDays(startDate: string, endDate: string): number | null {
	const startMs = dateOnlyToUtcMs(startDate);
	const endMs = dateOnlyToUtcMs(endDate);

	if (startMs === null || endMs === null || endMs <= startMs) {
		return null;
	}

	return Math.round((endMs - startMs) / MS_PER_DAY);
}

function addDaysToDateOnly(dateString: string, days: number): string {
	const dateMs = dateOnlyToUtcMs(dateString);

	if (dateMs === null) {
		return dateString;
	}

	return formatUtcDateOnly(new Date(dateMs + days * MS_PER_DAY));
}

/**
 * Converts an ICAL.Time object to an ISO string with proper timezone handling.
 *
 * For timed events, uses toUnixTime() which correctly handles all timezones.
 * For all-day events, preserves the date without time conversion.
 *
 * When ical.js can't resolve a TZID (no matching VTIMEZONE in the feed and
 * no IANA tzdata in ical.js itself), it demotes the time to "floating",
 * and `toUnixTime()` then misinterprets the wall clock as UTC. To recover,
 * the caller can pass the raw TZID parameter from the source property; if
 * it maps to a known IANA zone (directly or via the Windows TZID alias
 * table), Intl.DateTimeFormat is used to compute the correct UTC instant.
 * Timed values with no TZID are floating wall times, so they are resolved
 * against the user's local runtime timezone before storing as UTC.
 *
 * This fixes issues with:
 * - Outlook/Exchange feeds that reference Windows TZIDs without
 *   inlining a VTIMEZONE block for every referenced zone.
 * - Events with IANA TZIDs that have no accompanying VTIMEZONE.
 * - Non-IANA timezones (e.g., TZID=Zurich without VTIMEZONE).
 * - Floating timed events with no TZID.
 * - All-day events (date-only output, no zone math).
 */
export function icalTimeToISOString(icalTime: ICAL.Time, rawTzid?: string | null): string {
	// For all-day events, return date-only string (YYYY-MM-DD)
	// This preserves the calendar date semantics without timezone ambiguity
	// per iCalendar RFC 5545 specification for VALUE=DATE events
	if (icalTime.isDate) {
		const year = icalTime.year.toString().padStart(4, "0");
		const month = icalTime.month.toString().padStart(2, "0");
		const day = icalTime.day.toString().padStart(2, "0");
		return `${year}-${month}-${day}`;
	}

	// Fallback path: when ical.js fell back to floating but the source
	// property had a TZID that resolves to a known IANA zone, compute
	// the UTC instant from the wall clock using Intl tzdata.
	const zoneTzid = icalTime.zone?.tzid;
	if (zoneTzid === "floating" || zoneTzid === undefined) {
		const iana = resolveTzidToIANA(rawTzid);
		if (iana) {
			return wallTimeInZoneToUtcIso(icalTime, iana);
		}

		const hasExplicitTzid = typeof rawTzid === "string" && rawTzid.trim().length > 0;
		if (!hasExplicitTzid) {
			const localTimeZone = getLocalTimeZoneForFloatingTime();
			if (localTimeZone) {
				return wallTimeInZoneToUtcIso(icalTime, localTimeZone);
			}
		}
	}

	// Normal path: ical.js has a registered timezone for this Time
	// (either from a VTIMEZONE in the feed or because the time is UTC),
	// so toUnixTime() gives the correct instant.
	const unixTime = icalTime.toUnixTime();
	return new Date(unixTime * 1000).toISOString();
}

function getLocalTimeZoneForFloatingTime(): string | null {
	try {
		return resolveTzidToIANA(Intl.DateTimeFormat().resolvedOptions().timeZone);
	} catch {
		return null;
	}
}

/**
 * Extract the raw TZID parameter from a property (e.g. DTSTART, DTEND).
 * Returns null when the property is missing or has no TZID parameter
 * (which means the value is either UTC, date-only, or a floating wall time).
 */
export function rawTzidOf(vevent: ICAL.Component, propName: string): string | null {
	const prop = vevent.getFirstProperty(propName);
	if (!prop) return null;
	const tzid = prop.getParameter("tzid");
	return typeof tzid === "string" ? tzid : null;
}

export function getRecurringInstanceEnd(
	instanceStart: string,
	startISO: string,
	endISO: string | undefined,
	isAllDay: boolean
): string | undefined {
	if (!endISO) {
		return undefined;
	}

	if (isAllDay) {
		const durationDays = getDateOnlyDurationDays(startISO, endISO);
		return durationDays === null ? endISO : addDaysToDateOnly(instanceStart, durationDays);
	}

	const durationMs = new Date(endISO).getTime() - new Date(startISO).getTime();
	return new Date(new Date(instanceStart).getTime() + durationMs).toISOString();
}

/**
 * Parses iCalendar text into TaskNotes events, expanding recurring series.
 */
export function parseICSEvents(icsData: string, subscriptionId: string): ICSEvent[] {
	try {
		const jcalData = ICAL.parse(icsData);
		const comp = new ICAL.Component(jcalData);

		// Register VTIMEZONE components before processing events.
		registerCalendarVTimezones(comp);

		const ownerEmail = getICSCalendarOwnerEmail(comp);
		const vevents = comp.getAllSubcomponents("vevent");
		const events: ICSEvent[] = [];

		// Maps to track recurring event exceptions
		const modifiedInstances = new Map<string, Map<string, ICAL.Event>>(); // uid -> Map of recurrence-id to Event

		// First pass: identify exceptions and modified instances
		vevents.forEach((vevent: ICAL.Component) => {
			const event = new ICAL.Event(vevent);
			const uid = event.uid;

			if (!uid) return;

			// Check if this is a modified instance (has RECURRENCE-ID)
			const recurrenceId = vevent.getFirstPropertyValue("recurrence-id");
			if (recurrenceId instanceof ICAL.Time) {
				if (!modifiedInstances.has(uid)) {
					modifiedInstances.set(uid, new Map());
				}
				// Use the same ICAL.Time representation as iterator occurrences,
				// not JSON serialization of the time's internal fields.
				const recurrenceIdStr = recurrenceId.toString();
				modifiedInstances.get(uid)!.set(recurrenceIdStr, event);
			}
		});

		// Second pass: process events
		vevents.forEach((vevent: ICAL.Component) => {
			try {
				const event = new ICAL.Event(vevent);

				// Skip if this is a modified instance (will be handled as part of the recurring series)
				const recurrenceId = vevent.getFirstPropertyValue("recurrence-id");
				if (recurrenceId) {
					return;
				}

				// Skip cancelled events (STATUS:CANCELLED)
				const status = vevent.getFirstPropertyValue("status");
				if (typeof status === "string" && status.toUpperCase() === "CANCELLED") {
					return;
				}

				// Another guest declining is not evidence that the owner declined.
				// Keep events visible when the feed does not identify the owner.
				const ownerDeclined = getICSOwnerDeclined(vevent, ownerEmail) ?? false;
				if (ownerDeclined && !event.isRecurring()) {
					return;
				}

				// Extract basic properties
				const summary = event.summary || "Untitled Event";
				const description = event.description || undefined;
				const location = event.location || undefined;

				// Handle start and end times
				const startDate = event.startDate;
				const endDate = event.endDate;

				if (!startDate) {
					return; // Skip events without start date
				}

				// Capture the raw TZID parameters so icalTimeToISOString can
				// fall back to Intl-based resolution for floating times whose
				// TZID was a Windows (Outlook) zone name or any other IANA
				// name not present in the calendar's VTIMEZONE blocks.
				const startTzidRaw = rawTzidOf(vevent, "dtstart");
				const endTzidRaw = rawTzidOf(vevent, "dtend");

				const isAllDay = startDate.isDate;
				const startISO = icalTimeToISOString(startDate, startTzidRaw);
				const endISO = endDate
					? icalTimeToISOString(endDate, endTzidRaw ?? startTzidRaw)
					: undefined;

				// Generate unique ID
				const uid = event.uid || `${subscriptionId}-${events.length}`;
				const eventId = `${subscriptionId}-${uid}`;

				const icsEvent: ICSEvent = {
					id: eventId,
					subscriptionId: subscriptionId,
					title: summary,
					description: description,
					start: startISO,
					end: endISO,
					allDay: isAllDay,
					location: location,
					url: event.url || undefined,
				};

				// Handle recurring events
				if (event.isRecurring()) {
					// Parse EXDATE (exception dates) - dates to exclude from the recurrence
					const exdates = new Set<string>();
					const exdateProp = vevent.getAllProperties("exdate");
					exdateProp.forEach((prop) => {
						const exdateValue = prop.getFirstValue();
						if (exdateValue) {
							// Handle both single dates and arrays of dates
							const dates = Array.isArray(exdateValue)
								? exdateValue
								: [exdateValue];
							dates.forEach((date) => {
								if (date && typeof date.toString === "function") {
									exdates.add(date.toString());
								}
							});
						}
					});

					// Get modified instances for this UID
					const modifiedForThisEvent = modifiedInstances.get(uid) || new Map();

					// Generate instances for the next year
					const iterator = event.iterator(startDate);
					const maxDate = new ICAL.Time();
					maxDate.fromJSDate(
						new Date(Date.now() + ICS_RECURRENCE_EXPANSION_WINDOW_MS)
					); // One year from now

					let occurrence;
					let occurrenceCount = 0;
					let visibleInstanceCount = 0;

					while (
						(occurrence = iterator.next()) &&
						occurrenceCount < MAX_RECURRING_ICS_ITERATIONS &&
						visibleInstanceCount < MAX_RECURRING_ICS_VISIBLE_INSTANCES
					) {
						occurrenceCount++;

						if (occurrence.compare(maxDate) > 0) {
							break;
						}

						const occurrenceStr = occurrence.toString();

						// Skip if this date is in EXDATE
						if (exdates.has(occurrenceStr)) {
							continue;
						}

						const instanceId = `${eventId}-${visibleInstanceCount}`;

						// Check if this instance has been modified
						const modifiedEvent = modifiedForThisEvent.get(occurrenceStr);
						if (modifiedEvent) {
							const modifiedStatus = modifiedEvent.component.getFirstPropertyValue("status");
							if (typeof modifiedStatus === "string" && modifiedStatus.toUpperCase() === "CANCELLED") {
								continue;
							}
							if (getICSOwnerDeclined(modifiedEvent.component, ownerEmail) ?? ownerDeclined) {
								continue;
							}
							// Use the modified event instead
							const modifiedStart = modifiedEvent.startDate;
							const modifiedEnd = modifiedEvent.endDate;
							const modifiedVevent: ICAL.Component | undefined =
								(modifiedEvent as { component?: ICAL.Component }).component;
							const modStartTzidRaw = modifiedVevent
								? rawTzidOf(modifiedVevent, "dtstart")
								: null;
							const modEndTzidRaw = modifiedVevent
								? rawTzidOf(modifiedVevent, "dtend")
								: null;

							if (modifiedStart) {
								events.push({
									id: instanceId,
									subscriptionId: subscriptionId,
									title: modifiedEvent.summary || summary,
									description: modifiedEvent.description || description,
									start: icalTimeToISOString(
										modifiedStart,
										modStartTzidRaw
									),
									end: modifiedEnd
										? icalTimeToISOString(
												modifiedEnd,
												modEndTzidRaw ?? modStartTzidRaw
											)
										: undefined,
									allDay: modifiedStart.isDate,
									location: modifiedEvent.location || location,
									url: modifiedEvent.url || icsEvent.url,
									recurringEventId: eventId,
								});
								visibleInstanceCount++;
							}
						} else {
							if (ownerDeclined) continue;
							// Use the original recurring event instance.
							// The iterator emits ICAL.Time values that share the
							// startDate's TZID, so pass startTzidRaw for fallback.
							const instanceStart = icalTimeToISOString(
								occurrence,
								startTzidRaw
							);
							// Derive duration from the already-resolved ISO
							// strings so the fallback path stays consistent
							// across the start and end of an instance.
							const instanceEnd = getRecurringInstanceEnd(
								instanceStart,
								startISO,
								endISO,
								isAllDay
							);

							events.push({
								...icsEvent,
								id: instanceId,
								start: instanceStart,
								end: instanceEnd,
								recurringEventId: eventId,
							});
							visibleInstanceCount++;
						}
					}
				} else {
					events.push(icsEvent);
				}
			} catch (eventError) {
				tasknotesLogger.warn("Failed to parse individual event:", {
					category: "provider",
					operation: "parse-individual-event",
					error: eventError,
				});
			}
		});

		return events;
	} catch (error) {
		tasknotesLogger.error("Failed to parse ICS data:", {
			category: "provider",
			operation: "parse-ics-data",
			error: error,
		});
		throw new Error("Invalid ICS format");
	}
}
/* eslint-enable @typescript-eslint/no-non-null-assertion -- End of ICS parsing helpers. */
