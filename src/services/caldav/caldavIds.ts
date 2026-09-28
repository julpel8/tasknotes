/** Stable, short subscription id for a calendar URL. */
export function caldavSubscriptionId(calendarUrl: string): string {
	let hash = 5381;
	for (let i = 0; i < calendarUrl.length; i++) {
		hash = ((hash << 5) + hash + calendarUrl.charCodeAt(i)) >>> 0;
	}
	return `caldav-${hash.toString(36)}`;
}
