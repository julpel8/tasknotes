import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import {
	CalDAVClient,
	basicAuthHeader,
	parseMultistatus,
} from "../../../src/services/caldav/CalDAVClient";

const NS =
	'xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:x1="http://apple.com/ns/ical/"';

function multistatus(body: string): string {
	return `<?xml version="1.0"?><d:multistatus ${NS}>${body}</d:multistatus>`;
}

function response(href: string, props: string, status = "HTTP/1.1 200 OK"): string {
	return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>${status}</d:status></d:propstat></d:response>`;
}

function reply(status: number, text = "", headers: Record<string, string> = {}): RequestUrlResponse {
	return { status, text, headers } as RequestUrlResponse;
}

function createClient(handler: (request: RequestUrlParam) => RequestUrlResponse) {
	const requests: RequestUrlParam[] = [];
	const client = new CalDAVClient(
		() => ({ serverUrl: "https://cal.example.com/dav.php", username: "alice", password: "sécret" }),
		(request) => {
			requests.push(request);
			return Promise.resolve(handler(request));
		}
	);
	return { client, requests };
}

describe("CalDAVClient", () => {
	it("builds a UTF-8 safe Basic authorization header", () => {
		expect(basicAuthHeader("alice", "sécret")).toBe(
			`Basic ${Buffer.from("alice:sécret", "utf8").toString("base64")}`
		);
	});

	it("keeps only successful propstat blocks and resolves hrefs", () => {
		const xml = multistatus(
			`<d:response><d:href>/dav.php/calendars/alice/home/</d:href>` +
				`<d:propstat><d:prop><cs:getctag/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>` +
				`<d:propstat><d:prop><d:displayname>Home</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>` +
				`</d:response>`
		);
		const entries = parseMultistatus(xml, "https://cal.example.com/dav.php/");
		expect(entries).toHaveLength(1);
		expect(entries[0].url).toBe("https://cal.example.com/dav.php/calendars/alice/home/");
		expect(entries[0].props.textContent).toBe("Home");
	});

	it("discovers calendars through the principal and calendar home", async () => {
		const { client, requests } = createClient((request) => {
			if (request.url === "https://cal.example.com/dav.php/") {
				return reply(
					207,
					multistatus(
						response(
							"/dav.php/",
							"<d:current-user-principal><d:href>/dav.php/principals/alice/</d:href></d:current-user-principal>"
						)
					)
				);
			}
			if (request.url === "https://cal.example.com/dav.php/principals/alice/") {
				return reply(
					207,
					multistatus(
						response(
							"/dav.php/principals/alice/",
							"<cal:calendar-home-set><d:href>/dav.php/calendars/alice/</d:href></cal:calendar-home-set>"
						)
					)
				);
			}
			return reply(
				207,
				multistatus(
					response("/dav.php/calendars/alice/", "<d:resourcetype><d:collection/></d:resourcetype>") +
						response(
							"/dav.php/calendars/alice/default/",
							'<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>Default calendar</d:displayname><x1:calendar-color>#FF2968FF</x1:calendar-color><cal:supported-calendar-component-set><cal:comp name="VEVENT"/><cal:comp name="VTODO"/></cal:supported-calendar-component-set><cs:getctag>ctag-1</cs:getctag>'
						) +
						response(
							"/dav.php/calendars/alice/todo",
							'<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set>'
						)
				)
			);
		});

		const calendars = await client.discoverCalendars();

		expect(calendars).toEqual([
			{
				url: "https://cal.example.com/dav.php/calendars/alice/default/",
				displayName: "Default calendar",
				color: "#FF2968",
				components: ["VEVENT", "VTODO"],
				ctag: "ctag-1",
			},
			{
				url: "https://cal.example.com/dav.php/calendars/alice/todo/",
				displayName: "todo",
				color: undefined,
				components: ["VTODO"],
				ctag: undefined,
			},
		]);
		expect(requests.map((r) => [r.method, r.headers?.Depth])).toEqual([
			["PROPFIND", "0"],
			["PROPFIND", "0"],
			["PROPFIND", "1"],
		]);
	});

	it("sends a time-ranged calendar-query and returns objects with etags", async () => {
		const { client, requests } = createClient(() =>
			reply(
				207,
				multistatus(
					response(
						"/dav.php/calendars/alice/default/a.ics",
						'<d:getetag>"e1"</d:getetag><cal:calendar-data>BEGIN:VCALENDAR\nEND:VCALENDAR</cal:calendar-data>'
					)
				)
			)
		);

		const objects = await client.fetchObjects(
			"https://cal.example.com/dav.php/calendars/alice/default/",
			"VEVENT",
			{ start: new Date("2026-01-01T00:00:00Z"), end: new Date("2026-02-01T12:30:00Z") }
		);

		expect(objects).toEqual([
			{
				url: "https://cal.example.com/dav.php/calendars/alice/default/a.ics",
				etag: '"e1"',
				data: "BEGIN:VCALENDAR\nEND:VCALENDAR",
			},
		]);
		expect(requests[0].method).toBe("REPORT");
		expect(requests[0].body).toContain('<c:comp-filter name="VEVENT">');
		expect(requests[0].body).toContain('start="20260101T000000Z" end="20260201T123000Z"');
	});

	it("uses conditional headers when writing and reports failures", async () => {
		const { client, requests } = createClient((request) =>
			request.headers?.["If-Match"] === '"stale"' ? reply(412) : reply(201, "", { ETag: '"new"' })
		);
		const url = "https://cal.example.com/dav.php/calendars/alice/default/x.ics";

		await expect(client.putObject(url, "DATA", { createOnly: true })).resolves.toBe('"new"');
		expect(requests[0].headers?.["If-None-Match"]).toBe("*");
		expect(requests[0].contentType).toBe("text/calendar; charset=utf-8");

		await expect(client.putObject(url, "DATA", { etag: '"stale"' })).rejects.toMatchObject({
			status: 412,
		});
	});

	it("treats a missing object as already deleted", async () => {
		const { client } = createClient(() => reply(404));
		await expect(
			client.deleteObject("https://cal.example.com/dav.php/calendars/alice/default/x.ics")
		).resolves.toBeUndefined();
		await expect(
			client.getObject("https://cal.example.com/dav.php/calendars/alice/default/x.ics")
		).resolves.toBeNull();
	});
});
