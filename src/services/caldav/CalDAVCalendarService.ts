import type TaskNotesPlugin from "../../main";
import type { ICSEvent } from "../../types";
import type { CalDAVCalendarSetting } from "../../types/settings";
import { parseICSEvents } from "../../utils/icsParsing";
import { publishUserNotice } from "../../core/userNotices";
import { createTaskNotesLogger } from "../../utils/tasknotesLogger";
import {
	CalendarProvider,
	type CalendarEventData,
	type ProviderCalendar,
} from "../CalendarProvider";
import { CalDAVClient, CalDAVError, type CalDAVCredentials } from "./CalDAVClient";
import {
	applyEventUpdates,
	buildEventCalendar,
	generateUid,
	isRecurringCalendarObject,
	objectUrlForUid,
} from "./icalObjects";

const tasknotesLogger = createTaskNotesLogger({ tag: "Services/CalDAVCalendarService" });

export const CALDAV_PASSWORD_SECRET_ID = "tasknotes-caldav-password";

const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_PAST_DAYS = 180;
const FETCH_FUTURE_DAYS = 365;
const DEFAULT_EVENT_COLOR = "#7c6fcd";

interface CachedObject {
	calendarUrl: string;
	objectUrl: string;
	etag?: string;
	data: string;
}

/**
 * Reads CalDAV credentials from settings, with the password kept in Obsidian
 * SecretStorage so it never lands in the synced data.json.
 */
export function getCalDAVCredentials(plugin: TaskNotesPlugin): CalDAVCredentials | null {
	const settings = plugin.settings.caldav;
	if (!settings.serverUrl || !settings.username) return null;
	const password = plugin.app.secretStorage?.getSecret(CALDAV_PASSWORD_SECRET_ID) ?? "";
	// Without a password every request would be refused; treat CalDAV as not set up.
	if (!password) return null;
	return { serverUrl: settings.serverUrl, username: settings.username, password };
}

/** Stable, short subscription id for a calendar URL. */
export function caldavSubscriptionId(calendarUrl: string): string {
	let hash = 5381;
	for (let i = 0; i < calendarUrl.length; i++) {
		hash = ((hash << 5) + hash + calendarUrl.charCodeAt(i)) >>> 0;
	}
	return `caldav-${hash.toString(36)}`;
}

/**
 * Calendar provider for any CalDAV server (Baïkal, Nextcloud, Radicale, iCloud…).
 * Shows events of the enabled calendars and lets calendar views edit them.
 */
export class CalDAVCalendarService extends CalendarProvider {
	readonly providerId = "caldav";
	readonly providerName = "CalDAV";

	readonly client: CalDAVClient;
	private eventsByCalendar: Map<string, ICSEvent[]> = new Map();
	/** ICS event id (including expanded instances) → server object */
	private objectsByEventId: Map<string, CachedObject> = new Map();
	private refreshTimer: number | null = null;
	private refreshing: Promise<void> | null = null;
	private destroyed = false;
	private authFailureReported = false;

	constructor(private readonly plugin: TaskNotesPlugin) {
		super();
		this.client = new CalDAVClient(() => getCalDAVCredentials(plugin));
	}

	private get settings() {
		return this.plugin.settings.caldav;
	}

	/**
	 * Tells the user once per session when the server refuses the credentials,
	 * instead of failing silently on every refresh.
	 */
	reportError(error: unknown): void {
		if (!(error instanceof CalDAVError) || (error.status !== 401 && error.status !== 403)) return;
		if (this.authFailureReported) return;
		this.authFailureReported = true;
		publishUserNotice(
			this.plugin.emitter,
			this.plugin.i18n.translate("settings.integrations.caldav.notices.authFailed")
		);
	}

	isConfigured(): boolean {
		return this.settings.enabled && getCalDAVCredentials(this.plugin) !== null;
	}

	async initialize(): Promise<void> {
		this.destroyed = false;
		if (!this.isConfigured()) return;
		await this.refresh();
		this.scheduleRefresh();
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		if (this.destroyed || !this.isConfigured()) return;
		const minutes = Math.max(1, this.settings.refreshMinutes || 5);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.refresh().finally(() => this.scheduleRefresh());
		}, minutes * 60 * 1000);
	}

	/**
	 * Discovers the account's calendars and stores them in settings, keeping
	 * the enabled flag of calendars already known.
	 */
	async listCalendars(): Promise<ProviderCalendar[]> {
		this.authFailureReported = false;
		const discovered = await this.client.discoverCalendars();
		const previous = new Map(this.settings.calendars.map((c) => [c.url, c]));
		this.settings.calendars = discovered.map(
			(calendar): CalDAVCalendarSetting => ({
				url: calendar.url,
				name: calendar.displayName,
				color: calendar.color,
				components: calendar.components,
				enabled: previous.get(calendar.url)?.enabled ?? calendar.components.includes("VEVENT"),
			})
		);
		await this.plugin.saveSettings();
		return this.getAvailableCalendars();
	}

	getAvailableCalendars(): ProviderCalendar[] {
		if (!this.isConfigured()) return [];
		return this.settings.calendars
			.filter((calendar) => calendar.components.includes("VEVENT"))
			.map((calendar) => ({
				id: calendar.url,
				summary: calendar.name,
				backgroundColor: calendar.color,
			}));
	}

	getAllEvents(): ICSEvent[] {
		if (!this.isConfigured()) return [];
		const enabled = new Set(
			this.settings.calendars.filter((c) => c.enabled).map((c) => c.url)
		);
		const all: ICSEvent[] = [];
		for (const [calendarUrl, events] of this.eventsByCalendar) {
			if (enabled.has(calendarUrl)) all.push(...events);
		}
		return all;
	}

	async refresh(): Promise<void> {
		if (this.refreshing) return this.refreshing;
		this.refreshing = this.refreshEnabledCalendars().finally(() => {
			this.refreshing = null;
		});
		return this.refreshing;
	}

	private async refreshEnabledCalendars(): Promise<void> {
		if (!this.isConfigured()) return;
		const now = Date.now();
		const range = {
			start: new Date(now - FETCH_PAST_DAYS * DAY_MS),
			end: new Date(now + FETCH_FUTURE_DAYS * DAY_MS),
		};

		const calendars = this.settings.calendars.filter(
			(c) => c.enabled && c.components.includes("VEVENT")
		);
		const nextEvents: Map<string, ICSEvent[]> = new Map();
		const nextObjects: Map<string, CachedObject> = new Map();
		let changed = false;

		for (const calendar of calendars) {
			try {
				const objects = await this.client.fetchObjects(calendar.url, "VEVENT", range);
				const subscriptionId = caldavSubscriptionId(calendar.url);
				const calendarEvents: ICSEvent[] = [];
				for (const object of objects) {
					let parsed: ICSEvent[];
					try {
						parsed = parseICSEvents(object.data, subscriptionId);
					} catch (error) {
						tasknotesLogger.warn("Skipping unreadable CalDAV object", {
							category: "provider",
							operation: "caldav-parse-object",
							details: { url: object.url },
							error,
						});
						continue;
					}
					for (const event of parsed) {
						event.color = calendar.color ?? DEFAULT_EVENT_COLOR;
						calendarEvents.push(event);
						nextObjects.set(event.id, {
							calendarUrl: calendar.url,
							objectUrl: object.url,
							etag: object.etag,
							data: object.data,
						});
					}
				}
				nextEvents.set(calendar.url, calendarEvents);
				changed = true;
			} catch (error) {
				// Keep the previous events of a calendar that failed to refresh.
				const previous = this.eventsByCalendar.get(calendar.url);
				if (previous) {
					nextEvents.set(calendar.url, previous);
					for (const [id, object] of this.objectsByEventId) {
						if (object.calendarUrl === calendar.url) nextObjects.set(id, object);
					}
				}
				this.reportError(error);
				tasknotesLogger.error("CalDAV calendar refresh failed", {
					category: "provider",
					operation: "caldav-refresh",
					details: { calendar: calendar.name },
					error,
				});
			}
		}

		this.eventsByCalendar = nextEvents;
		this.objectsByEventId = nextObjects;
		if (changed) this.emit("data-changed");
	}

	ownsEvent(icsEvent: ICSEvent): boolean {
		return icsEvent.subscriptionId?.startsWith(`${this.providerId}-`) ?? false;
	}

	extractEventIds(icsEvent: ICSEvent): { calendarId: string; eventId: string } {
		const object = this.objectsByEventId.get(icsEvent.id);
		return { calendarId: object?.calendarUrl ?? "", eventId: icsEvent.id };
	}

	private requireObject(eventId: string): CachedObject {
		const object = this.objectsByEventId.get(eventId);
		if (!object) {
			throw new CalDAVError("CalDAV event is not loaded; refresh and try again", 404);
		}
		return object;
	}

	async updateEvent(
		_calendarId: string,
		eventId: string,
		updates: Partial<CalendarEventData>
	): Promise<ICSEvent> {
		const object = this.requireObject(eventId);
		if ((updates.start || updates.end) && isRecurringCalendarObject(object.data, "vevent")) {
			throw new CalDAVError("Moving a repeating CalDAV event is not supported yet", 0);
		}

		const data = applyEventUpdates(object.data, updates);
		const etag = await this.client.putObject(object.objectUrl, data, { etag: object.etag });
		const updatedObject = { ...object, etag, data };

		const subscriptionId = caldavSubscriptionId(object.calendarUrl);
		const updatedEvents = parseICSEvents(data, subscriptionId);
		const calendarColor = this.findCalendar(object.calendarUrl)?.color ?? DEFAULT_EVENT_COLOR;
		updatedEvents.forEach((event) => {
			event.color = calendarColor;
			this.objectsByEventId.set(event.id, updatedObject);
		});
		this.replaceObjectEvents(object, updatedEvents);
		this.emit("data-changed");

		return updatedEvents.find((event) => event.id === eventId) ?? updatedEvents[0];
	}

	async createEvent(calendarId: string, event: CalendarEventData): Promise<ICSEvent> {
		const uid = generateUid();
		const objectUrl = objectUrlForUid(calendarId, uid);
		const data = buildEventCalendar(uid, event);
		const etag = await this.client.putObject(objectUrl, data, { createOnly: true });

		const object: CachedObject = { calendarUrl: calendarId, objectUrl, etag, data };
		const created = parseICSEvents(data, caldavSubscriptionId(calendarId));
		const calendarColor = this.findCalendar(calendarId)?.color ?? DEFAULT_EVENT_COLOR;
		created.forEach((createdEvent) => {
			createdEvent.color = calendarColor;
			this.objectsByEventId.set(createdEvent.id, object);
		});
		this.eventsByCalendar.set(calendarId, [...(this.eventsByCalendar.get(calendarId) ?? []), ...created]);
		this.emit("data-changed");
		return created[0];
	}

	async deleteEvent(_calendarId: string, eventId: string): Promise<void> {
		const object = this.requireObject(eventId);
		await this.client.deleteObject(object.objectUrl, object.etag);
		this.replaceObjectEvents(object, []);
		this.emit("data-changed");
	}

	createCalendar(): Promise<string> {
		return Promise.reject(new Error("Creating CalDAV calendars is not supported"));
	}

	/** Replaces every cached event that came from the same server object. */
	private replaceObjectEvents(object: CachedObject, replacements: ICSEvent[]): void {
		const replacementIds = new Set(replacements.map((event) => event.id));
		const staleIds = new Set<string>();
		for (const [id, cached] of this.objectsByEventId) {
			if (cached.objectUrl === object.objectUrl && !replacementIds.has(id)) {
				staleIds.add(id);
			}
		}
		staleIds.forEach((id) => this.objectsByEventId.delete(id));
		const kept = (this.eventsByCalendar.get(object.calendarUrl) ?? []).filter(
			(event) => !staleIds.has(event.id) && !replacementIds.has(event.id)
		);
		this.eventsByCalendar.set(object.calendarUrl, [...kept, ...replacements]);
	}

	private findCalendar(url: string): CalDAVCalendarSetting | undefined {
		return this.settings.calendars.find((calendar) => calendar.url === url);
	}

	clearCache(): void {
		this.eventsByCalendar.clear();
		this.objectsByEventId.clear();
	}

	destroy(): void {
		this.destroyed = true;
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.clearCache();
	}
}
