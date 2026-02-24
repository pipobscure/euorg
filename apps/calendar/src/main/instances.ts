/**
 * Event instance query orchestrator.
 *
 * Combines SQL queries for non-recurring events, in-memory RRULE expansion
 * for recurring events, and merging of exception override rows.
 *
 * Returns EventInstance[] — the transfer type sent over RPC to the webview.
 */

import { Temporal } from "@js-temporal/polyfill";
import type { CalDavCalendar } from "@euorg/shared/euorg-accounts.ts";
import type { CalendarDB, EventRow } from "./db.ts";
import { readICS } from "./db.ts";
import { parseICS, parseICalDateTime, parseDuration } from "./ics.ts";
import { expandRRule, parseDtstart, zdtToDisplayISO } from "./rrule.ts";

// ── EventInstance — the RPC transfer type ────────────────────────────────────

export interface EventInstance {
	/**
	 * Stable ID for this specific occurrence.
	 * Non-recurring: same as uid.
	 * Recurring: "${uid}__${startISO}" (startISO in display timezone).
	 */
	instanceId: string;
	uid: string;
	calendarId: string;
	accountId: string;
	summary: string;
	description: string;
	location: string;
	organizer: string;
	/** ISO 8601 in display timezone, e.g. "2024-03-15T09:00:00+01:00" */
	startISO: string;
	/** ISO 8601 in display timezone */
	endISO: string;
	isAllDay: boolean;
	/** Hex color inherited from the calendar */
	color: string;
	hasRRule: boolean;
	/** Non-null for exception override instances (RECURRENCE-ID) */
	recurrenceId: string | null;
	etag: string | null;
	href: string;
	icsPath: string;
	status: string;
	/** null = synced; 'create' | 'update' | 'delete' = pending offline push */
	pendingSync: string | null;
	/** GEO latitude from RFC 5545 GEO property, null if not present */
	geoLat: number | null;
	/** GEO longitude from RFC 5545 GEO property, null if not present */
	geoLon: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const FALLBACK_TZ = "UTC";

/** Parse a stored dtstart string back into a Temporal object */
function parsStoredDtstart(
	row: EventRow,
	displayTzid: string,
): Temporal.ZonedDateTime | Temporal.PlainDate | null {
	const s = row.dtstart;
	if (!s) return null;

	if (row.dtstartIsDate) {
		// Date string: "20240315" or "2024-03-15"
		const clean = s.replace(/-/g, "");
		try {
			return Temporal.PlainDate.from(
				`${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`,
			);
		} catch {
			return null;
		}
	}

	// Check for Temporal annotation: "20240315T090000[America/New_York]"
	const annMatch = s.match(/^(.+)\[(.+)\]$/);
	if (annMatch) {
		try {
			const rawDt = annMatch[1];
			const tzid = annMatch[2];
			// rawDt is in iCal format: YYYYMMDDTHHMMSS
			const yr = rawDt.slice(0, 4), mo = rawDt.slice(4, 6), dy = rawDt.slice(6, 8);
			const hr = rawDt.slice(9, 11), mn = rawDt.slice(11, 13), sc = rawDt.slice(13, 15);
			return Temporal.ZonedDateTime.from(`${yr}-${mo}-${dy}T${hr}:${mn}:${sc}[${tzid}]`);
		} catch {
			return null;
		}
	}

	// UTC ISO string
	try {
		return Temporal.Instant.from(s).toZonedDateTimeISO(displayTzid);
	} catch {
		return null;
	}
}

/** Compute the end ZDT from an event row */
function computeEnd(
	row: EventRow,
	start: Temporal.ZonedDateTime | Temporal.PlainDate,
	displayTzid: string,
): Temporal.ZonedDateTime | Temporal.PlainDate {
	if (row.dtend) {
		if (row.dtstartIsDate) {
			const clean = row.dtend.replace(/-/g, "");
			try {
				return Temporal.PlainDate.from(
					`${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`,
				);
			} catch {}
		} else {
			const annMatch = row.dtend.match(/^(.+)\[(.+)\]$/);
			if (annMatch) {
				try {
					const rawDt = annMatch[1];
					const tzid = annMatch[2];
					const yr = rawDt.slice(0, 4), mo = rawDt.slice(4, 6), dy = rawDt.slice(6, 8);
					const hr = rawDt.slice(9, 11), mn = rawDt.slice(11, 13), sc = rawDt.slice(13, 15);
					return Temporal.ZonedDateTime.from(`${yr}-${mo}-${dy}T${hr}:${mn}:${sc}[${tzid}]`);
				} catch {}
			}
			try {
				return Temporal.Instant.from(row.dtend).toZonedDateTimeISO(displayTzid);
			} catch {}
		}
	}

	// Fallback: 1 hour for timed events, 1 day for all-day
	if (start instanceof Temporal.PlainDate) {
		return start.add({ days: 1 });
	}
	return start.add({ hours: 1 });
}

function rowToStartISO(
	row: EventRow,
	start: Temporal.ZonedDateTime | Temporal.PlainDate,
	displayTzid: string,
): string {
	if (start instanceof Temporal.PlainDate) {
		return start.toString();
	}
	return zdtToDisplayISO(start, displayTzid);
}

function rowToEndISO(
	end: Temporal.ZonedDateTime | Temporal.PlainDate,
	displayTzid: string,
): string {
	if (end instanceof Temporal.PlainDate) return end.toString();
	return zdtToDisplayISO(end, displayTzid);
}

function rowToInstance(
	row: EventRow,
	start: Temporal.ZonedDateTime | Temporal.PlainDate,
	end: Temporal.ZonedDateTime | Temporal.PlainDate,
	color: string,
	displayTzid: string,
	description: string = "",
	location: string = "",
): EventInstance {
	const startISO = rowToStartISO(row, start, displayTzid);
	const endISO = rowToEndISO(end, displayTzid);
	const instanceId = row.rrule ? `${row.uid}__${startISO}` : row.uid;
	return {
		instanceId,
		uid: row.uid,
		calendarId: row.calendarId,
		accountId: row.accountId,
		summary: row.summary,
		description,
		location,
		organizer: row.organizer,
		startISO,
		endISO,
		isAllDay: Boolean(row.dtstartIsDate),
		color,
		hasRRule: Boolean(row.rrule),
		recurrenceId: row.recurrenceId,
		etag: row.etag,
		href: row.href,
		icsPath: row.icsPath,
		status: row.status,
		pendingSync: row.pendingSync ?? null,
		geoLat: row.geoLat ?? null,
		geoLon: row.geoLon ?? null,
	};
}

/** Get description, location, url, organizer, and attendees from raw ICS (expensive, only for detail view) */
export function getEventDetail(row: EventRow): {
	description: string;
	location: string;
	url: string;
	organizer: string;
	attendees: Array<{ email: string; cn: string; partstat: string; role: string }>;
} {
	const empty = { description: "", location: "", url: "", organizer: "", attendees: [] };
	const ics = readICS(row.icsPath);
	if (!ics) return empty;
	const obj = parseICS(ics);
	const ev = obj.events.find((e) => e.uid === row.uid);
	if (!ev) return empty;
	return {
		description: ev.description,
		location: ev.location,
		url: ev.url,
		organizer: ev.organizer,
		attendees: ev.attendees.map((a) => ({ email: a.email, cn: a.cn, partstat: a.partstat, role: a.role })),
	};
}

// ── Main Query Function ───────────────────────────────────────────────────────

/**
 * Get all event instances within a display range.
 *
 * Algorithm:
 * 1. SQL: non-recurring events in range
 * 2. SQL: all recurring master events (no date filter)
 * 3. Expand RRULE for each recurring event within range
 * 4. Substitute/cancel instances with RECURRENCE-ID override rows
 * 5. Sort by startISO and return
 */
export function getInstancesInRange(
	db: CalendarDB,
	calendarConfig: Map<string, CalDavCalendar>,
	rangeStart: Temporal.PlainDate,
	rangeEnd: Temporal.PlainDate,
	displayTzid: string,
): EventInstance[] {
	const calendarIds = [...calendarConfig.keys()];
	if (calendarIds.length === 0) return [];

	const startISO = `${rangeStart.year}-${String(rangeStart.month).padStart(2, "0")}-${String(rangeStart.day).padStart(2, "0")}T00:00:00Z`;
	const endISO = `${rangeEnd.year}-${String(rangeEnd.month).padStart(2, "0")}-${String(rangeEnd.day).padStart(2, "0")}T23:59:59Z`;

	const instances: EventInstance[] = [];

	// 1. Non-recurring events
	const nonRecurring = db.getEventsInRange(calendarIds, startISO, endISO);
	for (const row of nonRecurring) {
		const cal = calendarConfig.get(row.calendarId);
		if (!cal) continue;
		const start = parsStoredDtstart(row, displayTzid);
		if (!start) continue;
		const end = computeEnd(row, start, displayTzid);
		instances.push(rowToInstance(row, start, end, cal.color, displayTzid));
	}

	// 2. Recurring master events + RRULE expansion
	const recurringRows = db.getRecurringEvents(calendarIds);

	// 3. All override rows for the calendars (for exception substitution)
	const allOverrides = db.getAllOverrides(calendarIds);
	// Group overrides by UID
	const overridesByUid = new Map<string, EventRow[]>();
	for (const ov of allOverrides) {
		const existing = overridesByUid.get(ov.uid) ?? [];
		existing.push(ov);
		overridesByUid.set(ov.uid, existing);
	}

	for (const row of recurringRows) {
		const cal = calendarConfig.get(row.calendarId);
		if (!cal) continue;

		// Read dtstart from row
		let dtstartTzid: string | null = null;
		// Try to extract tzid from stored dtstart annotation
		const annMatch = row.dtstart.match(/\[(.+)\]$/);
		if (annMatch) dtstartTzid = annMatch[1];
		const tzidForExpansion = dtstartTzid ?? displayTzid;

		// Parse dtstart using ICS parser
		const rawIcs = readICS(row.icsPath);
		if (!rawIcs) continue;
		const parsed = parseICS(rawIcs);
		const masterEvent = parsed.events.find((e) => e.uid === row.uid && !e.recurrenceId);
		if (!masterEvent) continue;

		const dtstart = parseDtstart(masterEvent.dtstart, masterEvent.dtstartTzid, masterEvent.dtstartIsDate);

		// Build exdate set
		const rawExdates = masterEvent.exdate;

		// Expand RRULE
		const expanded: Temporal.ZonedDateTime[] = [];
		const expandedDates: Temporal.PlainDate[] = [];
		if (dtstart instanceof Temporal.PlainDate) {
			// All-day recurring: expand as PlainDates
			const zdtList = expandRRule(
				row.rrule!,
				dtstart,
				rangeStart,
				rangeEnd,
				rawExdates,
				tzidForExpansion,
			);
			expandedDates.push(...zdtList.map((zdt) => zdt.toPlainDate()));
		} else {
			const zdtList = expandRRule(
				row.rrule!,
				dtstart,
				rangeStart,
				rangeEnd,
				rawExdates,
				tzidForExpansion,
			);
			expanded.push(...zdtList);
		}

		// Get overrides for this UID
		const overrides = overridesByUid.get(row.uid) ?? [];
		// Build a set of overridden recurrence IDs (normalized)
		const overriddenKeys = new Set<string>(overrides.map((ov) => ov.recurrenceId ?? ""));

		// Emit all-day expanded instances
		for (const pd of expandedDates) {
			const pad = (n: number, l = 2) => String(n).padStart(l, "0");
			const key = `${pad(pd.year, 4)}${pad(pd.month)}${pad(pd.day)}`;
			if (overriddenKeys.has(key)) continue;

			const startISO = pd.toString(); // "2026-11-18"
			const endISO = pd.add({ days: 1 }).toString();
			instances.push({
				instanceId: `${row.uid}__${startISO}`,
				uid: row.uid,
				calendarId: row.calendarId,
				accountId: row.accountId,
				summary: row.summary,
				description: "",
				location: "",
				organizer: row.organizer,
				startISO,
				endISO,
				isAllDay: true,
				color: cal.color,
				hasRRule: true,
				recurrenceId: null,
				etag: row.etag,
				href: row.href,
				icsPath: row.icsPath,
				status: row.status,
				pendingSync: row.pendingSync ?? null,
				geoLat: row.geoLat ?? null,
				geoLon: row.geoLon ?? null,
			});
		}

		// Emit timed expanded instances, skipping those with overrides
		for (const zdt of expanded) {
			const key = zdtToExdateKeyStr(zdt);
			if (overriddenKeys.has(key)) continue; // handled by override row below

			// Compute end time
			let end: Temporal.ZonedDateTime | Temporal.PlainDate;
			if (masterEvent.dtend) {
				const masterEnd = parseDtstart(masterEvent.dtend, masterEvent.dtendTzid, false);
				if (masterEnd instanceof Temporal.ZonedDateTime) {
					// Use since() to get a Duration without BigInt arithmetic
					const dur = masterEnd.since(dtstart as Temporal.ZonedDateTime, { largestUnit: "hours" });
					end = zdt.add(dur);
				} else {
					end = zdt.add({ hours: 1 });
				}
			} else if (masterEvent.duration) {
				const secs = parseDuration(masterEvent.duration);
				end = zdt.add({ seconds: secs });
			} else {
				end = zdt.add({ hours: 1 });
			}

			const startISO = zdtToDisplayISO(zdt, displayTzid);
			const endISO = zdtToDisplayISO(end as Temporal.ZonedDateTime, displayTzid);
			instances.push({
				instanceId: `${row.uid}__${startISO}`,
				uid: row.uid,
				calendarId: row.calendarId,
				accountId: row.accountId,
				summary: row.summary,
				description: "",
				location: "",
				organizer: row.organizer,
				startISO,
				endISO,
				isAllDay: false,
				color: cal.color,
				hasRRule: true,
				recurrenceId: null,
				etag: row.etag,
				href: row.href,
				icsPath: row.icsPath,
				status: row.status,
				pendingSync: row.pendingSync ?? null,
				geoLat: row.geoLat ?? null,
				geoLon: row.geoLon ?? null,
			});
		}

		// Emit override instances that fall within range
		for (const ov of overrides) {
			if (!ov.recurrenceId) continue;
			// Check if cancelled
			if (ov.status === "CANCELLED") continue;

			const ovStart = parsStoredDtstart(ov, displayTzid);
			if (!ovStart) continue;

			// Check if override is in range
			if (ovStart instanceof Temporal.PlainDate) {
				if (
					Temporal.PlainDate.compare(ovStart, rangeStart) < 0 ||
					Temporal.PlainDate.compare(ovStart, rangeEnd) >= 0
				) continue;
			} else {
				if (
					Temporal.PlainDate.compare(ovStart.toPlainDate(), rangeStart) < 0 ||
					Temporal.PlainDate.compare(ovStart.toPlainDate(), rangeEnd) >= 0
				) continue;
			}

			const ovEnd = computeEnd(ov, ovStart, displayTzid);
			instances.push(rowToInstance(ov, ovStart, ovEnd, cal.color, displayTzid));
		}
	}

	// Sort by startISO
	instances.sort((a, b) => a.startISO.localeCompare(b.startISO));

	// Deduplicate by instanceId (guards against server-side UID collisions
	// and SQLite NULL primary key quirks allowing duplicate non-override rows)
	const seen = new Set<string>();
	return instances.filter((inst) => {
		if (seen.has(inst.instanceId)) return false;
		seen.add(inst.instanceId);
		return true;
	});
}

function zdtToExdateKeyStr(zdt: Temporal.ZonedDateTime): string {
	const p = zdt.toPlainDateTime();
	const pad = (n: number, len = 2) => String(n).padStart(len, "0");
	return (
		`${pad(p.year, 4)}${pad(p.month)}${pad(p.day)}` +
		`T${pad(p.hour)}${pad(p.minute)}${pad(p.second)}`
	);
}
