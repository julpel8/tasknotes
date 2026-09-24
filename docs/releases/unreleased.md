# TaskNotes - Unreleased

<!--

**Added** for new features.
**Changed** for changes in existing functionality.
**Deprecated** for soon-to-be removed features.
**Removed** for now removed features.
**Fixed** for any bug fixes.
**Security** in case of vulnerabilities.

Always acknowledge contributors and those who report issues.

Example:

```
## Fixed

- (#768) Fixed calendar view appearing empty in week and day views due to invalid time configuration values
  - Added time validation in settings UI with proper error messages and debouncing
  - Prevents "Cannot read properties of null (reading 'years')" error from FullCalendar
  - Thanks to @userhandle for reporting and help debugging
```

When a change has user-facing documentation, include a canonical tasknotes.dev link:

```
## Added

- Added materialized occurrence notes for recurring tasks. See [Recurring Tasks](https://tasknotes.dev/features/recurring-tasks/#materialized-occurrence-notes) for setup and calendar behavior.
```

-->

## Added

- (#811) Added a CalDAV calendar connection. Calendars from a CalDAV server (Nextcloud, Baïkal, Radicale, iCloud and others) now appear in calendar views, where their events can be created, moved, edited and deleted. The password stays on each device and is never synced.
  - Moving a repeating CalDAV event is not supported yet.
- (#811) Tasks can be sent to a CalDAV calendar as to-dos, so phone reminder apps show them. Checking a task off or changing its date there updates the note. Archived and deleted tasks leave the list.
  - A repeating task is sent with its next date only. Checking it off on the phone completes that occurrence.
  - Thanks to @Archetype444 for the request, and to @schobernoise, @slipstyle and @shileiye for their input on it.
