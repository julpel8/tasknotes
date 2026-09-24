/**
 * Live check against a real CalDAV server. Skipped unless CALDAV_LIVE_URL is set.
 * CALDAV_LIVE_URL=http://localhost/dav.php/ CALDAV_LIVE_USER=… CALDAV_LIVE_PASS=… \
 * CALDAV_LIVE_CALENDAR=tasknotes-test npx jest tests/live
 */
import { execFileSync } from "child_process";

jest.mock("ical.js", () => {
	const actualICAL = jest.requireActual("../../node_modules/ical.js/dist/ical.es5.cjs");
	return { __esModule: true, default: actualICAL.default ?? actualICAL, ...actualICAL };
});
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { CalDAVClient } from "../../src/services/caldav/CalDAVClient";
import { buildEventCalendar, applyEventUpdates, objectUrlForUid } from "../../src/services/caldav/icalObjects";
import { parseICSEvents } from "../../src/utils/icsParsing";

const url = process.env.CALDAV_LIVE_URL;
const describeLive = url ? describe : describe.skip;

function curlRequest(request: RequestUrlParam): Promise<RequestUrlResponse> {
	const args = ["-s", "-i", "-X", request.method ?? "GET"];
	for (const [key, value] of Object.entries(request.headers ?? {})) args.push("-H", `${key}: ${value}`);
	if (request.contentType) args.push("-H", `Content-Type: ${request.contentType}`);
	if (request.body !== undefined) args.push("--data-binary", String(request.body));
	args.push(request.url);
	const raw = execFileSync("curl", args, { encoding: "utf8" });
	const split = raw.indexOf("\r\n\r\n");
	const head = raw.slice(0, split).split("\r\n");
	const status = Number(head[0].split(" ")[1]);
	const headers: Record<string, string> = {};
	head.slice(1).forEach((line) => {
		const i = line.indexOf(":");
		headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
	});
	const text = raw.slice(split + 4);
	return Promise.resolve({ status, headers, text } as RequestUrlResponse);
}

describeLive("CalDAV live server", () => {
	const client = new CalDAVClient(
		() => ({ serverUrl: url!, username: process.env.CALDAV_LIVE_USER!, password: process.env.CALDAV_LIVE_PASS! }),
		curlRequest
	);

	it("discovers calendars and round-trips an event", async () => {
		const calendars = await client.discoverCalendars();
		console.log(calendars.map((c) => `${c.displayName} ${c.url} ${c.components.join(",")} ${c.color ?? ""}`).join("\n"));
		const target = calendars.find((c) => c.displayName === process.env.CALDAV_LIVE_CALENDAR);
		expect(target).toBeDefined();

		const uid = `live-${Date.now()}`;
		const objectUrl = objectUrlForUid(target!.url, uid);
		const etag = await client.putObject(
			objectUrl,
			buildEventCalendar(uid, {
				summary: "Essai TaskNotes",
				start: { dateTime: "2026-09-25T10:00:00", timeZone: "Europe/Paris" },
				end: { dateTime: "2026-09-25T11:00:00", timeZone: "Europe/Paris" },
			}),
			{ createOnly: true }
		);
		console.log("etag after create", etag);

		const listed = await client.fetchObjects(target!.url, "VEVENT", {
			start: new Date("2026-09-24T00:00:00Z"),
			end: new Date("2026-09-26T00:00:00Z"),
		});
		const mine = listed.find((o) => o.url === objectUrl);
		expect(mine).toBeDefined();
		const events = parseICSEvents(mine!.data, "caldav-x");
		expect(events[0].title).toBe("Essai TaskNotes");
		expect(events[0].start).toBe("2026-09-25T08:00:00.000Z");

		const updated = applyEventUpdates(mine!.data, {
			start: { dateTime: "2026-09-25T14:00:00", timeZone: "Europe/Paris" },
			end: { dateTime: "2026-09-25T15:30:00", timeZone: "Europe/Paris" },
		});
		const etag2 = await client.putObject(objectUrl, updated, { etag: mine!.etag });
		const fetched = await client.getObject(objectUrl);
		expect(parseICSEvents(fetched!.data, "caldav-x")[0].start).toBe("2026-09-25T12:00:00.000Z");

		await expect(client.putObject(objectUrl, updated, { etag: mine!.etag })).rejects.toMatchObject({ status: 412 });

		await client.deleteObject(objectUrl, etag2 ?? fetched!.etag);
		expect(await client.getObject(objectUrl)).toBeNull();
	});
});

describeLive("CalDAV live server to-dos", () => {
	const client = new CalDAVClient(
		() => ({ serverUrl: url!, username: process.env.CALDAV_LIVE_USER!, password: process.env.CALDAV_LIVE_PASS! }),
		curlRequest
	);

	it("round-trips a to-do and keeps LAST-MODIFIED", async () => {
		const { writeTodo, readTodo } = await import("../../src/services/caldav/caldavTaskMapping");
		const calendars = await client.discoverCalendars();
		const target = calendars.find((c) => c.displayName === process.env.CALDAV_LIVE_CALENDAR)!;
		const uid = `live-todo-${Date.now()}`;
		const objectUrl = objectUrlForUid(target.url, uid);
		await client.putObject(
			objectUrl,
			writeTodo(null, uid, { title: "Essai rappel", completed: false, date: "2026-09-25T09:15", dateField: "due", priority: 1 }),
			{ createOnly: true }
		);
		const todos = await client.fetchObjects(target.url, "VTODO");
		const mine = todos.find((o) => o.url === objectUrl)!;
		expect(readTodo(mine.data)).toMatchObject({ title: "Essai rappel", date: "2026-09-25T09:15", priority: 1 });
		await client.deleteObject(objectUrl);
	});
});
