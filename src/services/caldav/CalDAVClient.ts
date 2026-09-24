import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";

const DAV_NS = "DAV:";
const CALDAV_NS = "urn:ietf:params:xml:ns:caldav";
const APPLE_ICAL_NS = "http://apple.com/ns/ical/";
const CALSERVER_NS = "http://calendarserver.org/ns/";

export type CalDAVComponent = "VEVENT" | "VTODO";

export interface CalDAVCredentials {
	serverUrl: string;
	username: string;
	password: string;
}

export interface CalDAVCalendarInfo {
	/** Absolute URL of the calendar collection, always ending with a slash */
	url: string;
	displayName: string;
	color?: string;
	/** Component types the collection accepts (e.g. VEVENT, VTODO) */
	components: string[];
	ctag?: string;
}

export interface CalDAVObject {
	/** Absolute URL of the calendar object resource */
	url: string;
	etag?: string;
	data: string;
}

export interface CalDAVTimeRange {
	start: Date;
	end: Date;
}

export class CalDAVError extends Error {
	constructor(
		message: string,
		public readonly status: number
	) {
		super(message);
		this.name = "CalDAVError";
	}
}

type RequestFn = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

/**
 * Minimal CalDAV client (RFC 4791) built on Obsidian's requestUrl so it works on
 * desktop and mobile without browser CORS restrictions.
 */
export class CalDAVClient {
	constructor(
		private readonly getCredentials: () => CalDAVCredentials | null,
		private readonly request: RequestFn = requestUrl
	) {}

	/**
	 * Finds the calendars of the configured account: principal, then calendar
	 * home, then the collections inside it.
	 */
	async discoverCalendars(): Promise<CalDAVCalendarInfo[]> {
		const credentials = this.requireCredentials();
		const serverUrl = ensureTrailingSlash(credentials.serverUrl);

		const principalUrl =
			(await this.findHref(serverUrl, DAV_NS, "current-user-principal")) ?? serverUrl;
		const homeUrl =
			(await this.findHref(principalUrl, CALDAV_NS, "calendar-home-set")) ?? principalUrl;

		const response = await this.send("PROPFIND", homeUrl, {
			depth: "1",
			body: propfindBody(
				'<d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/><cs:getctag/>'
			),
		});

		const calendars: CalDAVCalendarInfo[] = [];
		for (const entry of parseMultistatus(response.text, homeUrl)) {
			const resourceType = firstChild(entry.props, DAV_NS, "resourcetype");
			if (!resourceType || !firstChild(resourceType, CALDAV_NS, "calendar")) {
				continue;
			}
			const componentSet = firstChild(entry.props, CALDAV_NS, "supported-calendar-component-set");
			const components = componentSet
				? Array.from(componentSet.getElementsByTagNameNS(CALDAV_NS, "comp"))
						.map((comp) => comp.getAttribute("name")?.toUpperCase() ?? "")
						.filter(Boolean)
				: ["VEVENT", "VTODO"];
			const url = ensureTrailingSlash(entry.url);
			calendars.push({
				url,
				displayName: textOf(entry.props, DAV_NS, "displayname") || lastPathSegment(url),
				color: normalizeColor(textOf(entry.props, APPLE_ICAL_NS, "calendar-color")),
				components,
				ctag: textOf(entry.props, CALSERVER_NS, "getctag") || undefined,
			});
		}
		return calendars;
	}

	/**
	 * Lists calendar objects of one component type, optionally limited to a time range.
	 */
	async fetchObjects(
		calendarUrl: string,
		component: CalDAVComponent,
		range?: CalDAVTimeRange
	): Promise<CalDAVObject[]> {
		const timeRange = range
			? `<c:time-range start="${formatUtc(range.start)}" end="${formatUtc(range.end)}"/>`
			: "";
		const body =
			'<?xml version="1.0" encoding="utf-8"?>' +
			`<c:calendar-query xmlns:d="${DAV_NS}" xmlns:c="${CALDAV_NS}">` +
			"<d:prop><d:getetag/><c:calendar-data/></d:prop>" +
			'<c:filter><c:comp-filter name="VCALENDAR">' +
			`<c:comp-filter name="${component}">${timeRange}</c:comp-filter>` +
			"</c:comp-filter></c:filter></c:calendar-query>";

		const response = await this.send("REPORT", calendarUrl, { depth: "1", body });
		const objects: CalDAVObject[] = [];
		for (const entry of parseMultistatus(response.text, calendarUrl)) {
			const data = textOf(entry.props, CALDAV_NS, "calendar-data");
			if (!data) continue;
			objects.push({
				url: entry.url,
				etag: textOf(entry.props, DAV_NS, "getetag") || undefined,
				data,
			});
		}
		return objects;
	}

	/** Returns null when the object does not exist. */
	async getObject(url: string): Promise<CalDAVObject | null> {
		const response = await this.send("GET", url, { allowNotFound: true });
		if (response.status === 404) return null;
		return { url, etag: headerOf(response, "etag"), data: response.text };
	}

	/**
	 * Writes a calendar object. `etag` makes the write fail if the server copy
	 * changed; `createOnly` makes it fail if the object already exists.
	 * Returns the new ETag when the server sends one.
	 */
	async putObject(
		url: string,
		data: string,
		options: { etag?: string; createOnly?: boolean } = {}
	): Promise<string | undefined> {
		const headers: Record<string, string> = {};
		if (options.etag) headers["If-Match"] = options.etag;
		if (options.createOnly) headers["If-None-Match"] = "*";
		const response = await this.send("PUT", url, {
			body: data,
			contentType: "text/calendar; charset=utf-8",
			headers,
		});
		return headerOf(response, "etag");
	}

	async deleteObject(url: string, etag?: string): Promise<void> {
		await this.send("DELETE", url, {
			headers: etag ? { "If-Match": etag } : {},
			allowNotFound: true,
		});
	}

	private async findHref(
		url: string,
		namespace: string,
		property: string
	): Promise<string | undefined> {
		const prefix = namespace === CALDAV_NS ? "c" : "d";
		const response = await this.send("PROPFIND", url, {
			depth: "0",
			body: propfindBody(`<${prefix}:${property}/>`),
		});
		for (const entry of parseMultistatus(response.text, url)) {
			const element = firstChild(entry.props, namespace, property);
			const href = element ? textOf(element, DAV_NS, "href") : "";
			if (href) return ensureTrailingSlash(resolveUrl(href, url));
		}
		return undefined;
	}

	private requireCredentials(): CalDAVCredentials {
		const credentials = this.getCredentials();
		if (!credentials || !credentials.serverUrl || !credentials.username) {
			throw new CalDAVError("CalDAV server is not configured", 0);
		}
		return credentials;
	}

	private async send(
		method: string,
		url: string,
		options: {
			depth?: string;
			body?: string;
			contentType?: string;
			headers?: Record<string, string>;
			allowNotFound?: boolean;
		} = {}
	): Promise<RequestUrlResponse> {
		const credentials = this.requireCredentials();
		const headers: Record<string, string> = {
			Authorization: basicAuthHeader(credentials.username, credentials.password),
			...options.headers,
		};
		if (options.depth !== undefined) headers.Depth = options.depth;

		const response = await this.request({
			url,
			method,
			headers,
			body: options.body,
			contentType:
				options.contentType ??
				(options.body !== undefined ? "application/xml; charset=utf-8" : undefined),
			throw: false,
		});

		if (response.status === 404 && options.allowNotFound) return response;
		if (response.status < 200 || response.status >= 300) {
			throw new CalDAVError(
				`CalDAV ${method} ${url} failed with status ${response.status}`,
				response.status
			);
		}
		return response;
	}
}

interface MultistatusEntry {
	url: string;
	props: Element;
}

/**
 * Extracts each response's href and its successful (2xx) prop element.
 */
export function parseMultistatus(xml: string, baseUrl: string): MultistatusEntry[] {
	const doc = new DOMParser().parseFromString(xml, "application/xml");
	const entries: MultistatusEntry[] = [];
	for (const response of Array.from(doc.getElementsByTagNameNS(DAV_NS, "response"))) {
		const href = textOf(response, DAV_NS, "href");
		if (!href) continue;
		for (const propstat of Array.from(response.getElementsByTagNameNS(DAV_NS, "propstat"))) {
			const status = textOf(propstat, DAV_NS, "status");
			if (status && !/\s2\d\d\s/u.test(` ${status} `)) continue;
			const props = firstChild(propstat, DAV_NS, "prop");
			if (props) {
				entries.push({ url: resolveUrl(href, baseUrl), props });
				break;
			}
		}
	}
	return entries;
}

function propfindBody(props: string): string {
	return (
		'<?xml version="1.0" encoding="utf-8"?>' +
		`<d:propfind xmlns:d="${DAV_NS}" xmlns:c="${CALDAV_NS}" xmlns:a="${APPLE_ICAL_NS}" xmlns:cs="${CALSERVER_NS}">` +
		`<d:prop>${props}</d:prop></d:propfind>`
	);
}

function firstChild(parent: Element, namespace: string, name: string): Element | null {
	return parent.getElementsByTagNameNS(namespace, name)[0] ?? null;
}

function textOf(parent: Element, namespace: string, name: string): string {
	return firstChild(parent, namespace, name)?.textContent?.trim() ?? "";
}

function headerOf(response: RequestUrlResponse, name: string): string | undefined {
	const headers = response.headers ?? {};
	const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
	return key ? headers[key] : undefined;
}

export function resolveUrl(href: string, baseUrl: string): string {
	return new URL(href, baseUrl).toString();
}

export function ensureTrailingSlash(url: string): string {
	return url.endsWith("/") ? url : `${url}/`;
}

function lastPathSegment(url: string): string {
	const parts = url.split("/").filter(Boolean);
	return decodeURIComponent(parts[parts.length - 1] ?? url);
}

/** Apple stores colors as #RRGGBBAA; calendar views expect #RRGGBB. */
function normalizeColor(color: string): string | undefined {
	if (!color) return undefined;
	const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/iu.exec(color);
	return match ? `#${match[1]}` : undefined;
}

function formatUtc(date: Date): string {
	return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
}

export function basicAuthHeader(username: string, password: string): string {
	const bytes = new TextEncoder().encode(`${username}:${password}`);
	let binary = "";
	bytes.forEach((byte) => {
		binary += String.fromCharCode(byte);
	});
	return `Basic ${btoa(binary)}`;
}
