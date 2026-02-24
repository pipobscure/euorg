/**
 * SQLite cache for calendar events.
 *
 * Stores indexed metadata for fast queries; raw .ics files are kept on disk
 * at ~/.euorg/calendar/ics/ for round-trip fidelity.
 *
 * Two datetime representations are stored:
 *   dtstart      — iCal annotated format, e.g. "20240315T090000[America/New_York]" or "20240315"
 *                  Preserves the original TZID; used by instances.ts for Temporal processing.
 *   dtstart_utc  — UTC ISO string, e.g. "2024-03-15T09:00:00Z" or "2024-03-15T00:00:00Z"
 *                  Used for SQL range queries (lexicographic comparison works correctly).
 *
 * Exception override instances (RECURRENCE-ID) are stored as separate rows
 * with the same UID but a non-null recurrenceId column.
 *
 * Only import from Bun (main-process) code.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, unlinkSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Temporal } from "@js-temporal/polyfill";
import type { ICalEvent } from "./ics.ts";
import { toUtcISO } from "./ics.ts";

// ── Paths ─────────────────────────────────────────────────────────────────────

export const EUORG_DIR = join(homedir(), ".euorg");
export const CALENDAR_DIR = join(EUORG_DIR, "calendar");
export const ICS_DIR = join(CALENDAR_DIR, "ics");
export const DB_PATH = join(CALENDAR_DIR, "calendar.db");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EventRow {
	uid: string;
	accountId: string;
	calendarId: string;
	etag: string | null;
	href: string;
	/** Path to raw .ics file on disk */
	icsPath: string;
	summary: string;
	/** iCal annotated format: "20240315T090000[America/New_York]", "20240315T090000Z", or "20240315" */
	dtstart: string;
	/** iCal annotated format or null */
	dtend: string | null;
	/** UTC ISO string for SQL range queries: "2024-03-15T09:00:00Z" or "2024-03-15T00:00:00Z" */
	dtstartUtc: string | null;
	/** UTC ISO string for SQL range queries or null */
	dtendUtc: string | null;
	/** true for VALUE=DATE (all-day) events */
	dtstartIsDate: number; // SQLite boolean (0/1)
	/** Raw RRULE value string */
	rrule: string | null;
	/** JSON array of raw EXDATE strings */
	exdates: string;
	/** Non-null if this row is a RECURRENCE-ID exception override */
	recurrenceId: string | null;
	status: string;
	organizer: string;
	lastSynced: number;
	/** null = synced; 'create' | 'update' | 'delete' = pending offline push */
	pendingSync: string | null;
	/** GEO property latitude (RFC 5545 §3.8.1.6), null if not present */
	geoLat: number | null;
	/** GEO property longitude, null if not present */
	geoLon: number | null;
}

export interface OfflineQueueItem {
	id: number;
	operation: 'create' | 'update' | 'delete';
	uid: string;
	calendarId: string;
	accountId: string;
	href: string | null;
	etag: string | null;
	queuedAt: number;
}

// ── UTC conversion helper ─────────────────────────────────────────────────────

/**
 * Convert an iCal datetime value to a UTC ISO string suitable for SQL range queries.
 * Returns null on parse failure.
 *
 * Examples:
 *   "20240315T090000Z"                 → "2024-03-15T09:00:00Z"
 *   "20240315T090000" (floating)       → "2024-03-15T09:00:00Z"
 *   "20240315T090000" + "America/NY"   → "2024-03-15T14:00:00Z"
 *   "20240315" (all-day)               → "2024-03-15T00:00:00Z"
 */
function iCalToUtcISOStr(rawValue: string, tzid: string | null, isDate: boolean): string | null {
	if (!rawValue) return null;

	if (isDate) {
		// "20240315" → "2024-03-15T00:00:00Z"
		const y = rawValue.slice(0, 4), m = rawValue.slice(4, 6), d = rawValue.slice(6, 8);
		return `${y}-${m}-${d}T00:00:00Z`;
	}

	if (rawValue.endsWith("Z")) {
		// Already UTC compact: "20240315T090000Z" → "2024-03-15T09:00:00Z"
		const c = rawValue.slice(0, -1);
		const y = c.slice(0, 4), mo = c.slice(4, 6), dy = c.slice(6, 8);
		const h = c.slice(9, 11) || "00", mn = c.slice(11, 13) || "00", s = c.slice(13, 15) || "00";
		return `${y}-${mo}-${dy}T${h}:${mn}:${s}Z`;
	}

	const y = rawValue.slice(0, 4), mo = rawValue.slice(4, 6), dy = rawValue.slice(6, 8);
	const h = rawValue.slice(9, 11) || "00", mn = rawValue.slice(11, 13) || "00", sc = rawValue.slice(13, 15) || "00";

	if (tzid) {
		try {
			const zdt = Temporal.ZonedDateTime.from(`${y}-${mo}-${dy}T${h}:${mn}:${sc}[${tzid}]`);
			return zdt.toInstant().toString(); // "2024-03-15T09:00:00Z"
		} catch {
			return null;
		}
	}

	// Floating time (no TZID, no Z) — treat as UTC
	return `${y}-${mo}-${dy}T${h}:${mn}:${sc}Z`;
}

// ── ICS file helpers ──────────────────────────────────────────────────────────

function icsFilename(uid: string, recurrenceId: string | null): string {
	const safeUid = uid.replace(/[/\\:*?"<>|]/g, "_");
	if (recurrenceId) {
		// Normalize recurrenceId to a safe filename component
		const safeRid = recurrenceId.replace(/[/\\:*?"<>|=]/g, "_");
		return `${safeUid}__${safeRid}.ics`;
	}
	return `${safeUid}.ics`;
}

export function icsPath(uid: string, recurrenceId: string | null = null): string {
	return join(ICS_DIR, icsFilename(uid, recurrenceId));
}

export function writeICS(uid: string, recurrenceId: string | null, icsText: string): string {
	mkdirSync(ICS_DIR, { recursive: true });
	const path = icsPath(uid, recurrenceId);
	writeFileSync(path, icsText, "utf8");
	return path;
}

export function readICS(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

export function deleteICSFile(path: string): void {
	try {
		if (existsSync(path)) unlinkSync(path);
	} catch {}
}

// ── Database class ────────────────────────────────────────────────────────────

export class CalendarDB {
	private db: Database;

	constructor(dbPath = DB_PATH) {
		mkdirSync(CALENDAR_DIR, { recursive: true });
		mkdirSync(ICS_DIR, { recursive: true });

		this.db = new Database(dbPath, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.migrate();
	}

	private migrate(): void {
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        uid             TEXT    NOT NULL,
        account_id      TEXT    NOT NULL,
        calendar_id     TEXT    NOT NULL,
        etag            TEXT,
        href            TEXT    NOT NULL,
        ics_path        TEXT    NOT NULL,
        summary         TEXT    NOT NULL DEFAULT '',
        dtstart         TEXT    NOT NULL,
        dtend           TEXT,
        dtstart_utc     TEXT,
        dtend_utc       TEXT,
        dtstart_is_date INTEGER NOT NULL DEFAULT 0,
        rrule           TEXT,
        exdates         TEXT    NOT NULL DEFAULT '[]',
        recurrence_id   TEXT,
        status          TEXT    NOT NULL DEFAULT '',
        organizer       TEXT    NOT NULL DEFAULT '',
        description     TEXT    NOT NULL DEFAULT '',
        location        TEXT    NOT NULL DEFAULT '',
        attendees_text  TEXT    NOT NULL DEFAULT '',
        last_synced     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (uid, recurrence_id)
      );
      CREATE INDEX IF NOT EXISTS idx_events_calendar    ON events (calendar_id);
      CREATE INDEX IF NOT EXISTS idx_events_dtstart_utc ON events (dtstart_utc);
      CREATE INDEX IF NOT EXISTS idx_events_uid         ON events (uid);
    `);
		// Add new columns to existing DBs that predate this migration
		try { this.db.exec("ALTER TABLE events ADD COLUMN dtstart_utc TEXT"); } catch {}
		try { this.db.exec("ALTER TABLE events ADD COLUMN dtend_utc TEXT"); } catch {}
		try { this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_dtstart_utc ON events (dtstart_utc)"); } catch {}
		try { this.db.exec("ALTER TABLE events ADD COLUMN description TEXT NOT NULL DEFAULT ''"); } catch {}
		try { this.db.exec("ALTER TABLE events ADD COLUMN location TEXT NOT NULL DEFAULT ''"); } catch {}
		try { this.db.exec("ALTER TABLE events ADD COLUMN attendees_text TEXT NOT NULL DEFAULT ''"); } catch {}
		try { this.db.exec("ALTER TABLE events ADD COLUMN pending_sync TEXT DEFAULT NULL"); } catch {}
		try { this.db.exec("ALTER TABLE events ADD COLUMN geo_lat REAL DEFAULT NULL"); } catch {}
		try { this.db.exec("ALTER TABLE events ADD COLUMN geo_lon REAL DEFAULT NULL"); } catch {}
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS offline_queue (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        operation   TEXT    NOT NULL CHECK(operation IN ('create', 'update', 'delete')),
        uid         TEXT    NOT NULL,
        calendar_id TEXT    NOT NULL,
        account_id  TEXT    NOT NULL,
        href        TEXT,
        etag        TEXT,
        queued_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
      );
    `);
	}

	// ── Queries ────────────────────────────────────────────────────────────────

	/** Get non-recurring events whose time range overlaps [startISO, endISO] (UTC ISO format). */
	getEventsInRange(calendarIds: string[], startISO: string, endISO: string): EventRow[] {
		if (calendarIds.length === 0) return [];
		const placeholders = calendarIds.map(() => "?").join(",");
		const stmt = this.db.prepare<EventRow, unknown[]>(`
      SELECT uid, account_id as accountId, calendar_id as calendarId, etag, href, ics_path as icsPath,
             summary, dtstart, dtend, dtstart_utc as dtstartUtc, dtend_utc as dtendUtc,
             dtstart_is_date as dtstartIsDate,
             rrule, exdates, recurrence_id as recurrenceId, status, organizer, last_synced as lastSynced,
             pending_sync as pendingSync, geo_lat as geoLat, geo_lon as geoLon
      FROM events
      WHERE calendar_id IN (${placeholders})
        AND rrule IS NULL
        AND recurrence_id IS NULL
        AND pending_sync IS NOT 'delete'
        AND dtstart_utc < ? AND (dtend_utc > ? OR (dtend_utc IS NULL AND dtstart_utc >= ?))
    `);
		return stmt.all(...calendarIds, endISO, startISO, startISO);
	}

	/** Get all recurring master events (for in-memory RRULE expansion). */
	getRecurringEvents(calendarIds: string[]): EventRow[] {
		if (calendarIds.length === 0) return [];
		const placeholders = calendarIds.map(() => "?").join(",");
		const stmt = this.db.prepare<EventRow, unknown[]>(`
      SELECT uid, account_id as accountId, calendar_id as calendarId, etag, href, ics_path as icsPath,
             summary, dtstart, dtend, dtstart_utc as dtstartUtc, dtend_utc as dtendUtc,
             dtstart_is_date as dtstartIsDate,
             rrule, exdates, recurrence_id as recurrenceId, status, organizer, last_synced as lastSynced,
             pending_sync as pendingSync, geo_lat as geoLat, geo_lon as geoLon
      FROM events
      WHERE calendar_id IN (${placeholders})
        AND rrule IS NOT NULL
        AND recurrence_id IS NULL
        AND pending_sync IS NOT 'delete'
    `);
		return stmt.all(...calendarIds);
	}

	/** Get all RECURRENCE-ID override rows for a given UID. */
	getOverrides(uid: string): EventRow[] {
		const stmt = this.db.prepare<EventRow, string>(`
      SELECT uid, account_id as accountId, calendar_id as calendarId, etag, href, ics_path as icsPath,
             summary, dtstart, dtend, dtstart_utc as dtstartUtc, dtend_utc as dtendUtc,
             dtstart_is_date as dtstartIsDate,
             rrule, exdates, recurrence_id as recurrenceId, status, organizer, last_synced as lastSynced,
             pending_sync as pendingSync, geo_lat as geoLat, geo_lon as geoLon
      FROM events
      WHERE uid = ? AND recurrence_id IS NOT NULL AND pending_sync IS NOT 'delete'
    `);
		return stmt.all(uid);
	}

	/** Get all override rows for events in a set of calendars. */
	getAllOverrides(calendarIds: string[]): EventRow[] {
		if (calendarIds.length === 0) return [];
		const placeholders = calendarIds.map(() => "?").join(",");
		const stmt = this.db.prepare<EventRow, unknown[]>(`
      SELECT uid, account_id as accountId, calendar_id as calendarId, etag, href, ics_path as icsPath,
             summary, dtstart, dtend, dtstart_utc as dtstartUtc, dtend_utc as dtendUtc,
             dtstart_is_date as dtstartIsDate,
             rrule, exdates, recurrence_id as recurrenceId, status, organizer, last_synced as lastSynced,
             pending_sync as pendingSync, geo_lat as geoLat, geo_lon as geoLon
      FROM events
      WHERE calendar_id IN (${placeholders})
        AND recurrence_id IS NOT NULL
        AND pending_sync IS NOT 'delete'
    `);
		return stmt.all(...calendarIds);
	}

	/** Get a single event by UID (master event, not override). */
	getEvent(uid: string): EventRow | null {
		const stmt = this.db.prepare<EventRow, string>(`
      SELECT uid, account_id as accountId, calendar_id as calendarId, etag, href, ics_path as icsPath,
             summary, dtstart, dtend, dtstart_utc as dtstartUtc, dtend_utc as dtendUtc,
             dtstart_is_date as dtstartIsDate,
             rrule, exdates, recurrence_id as recurrenceId, status, organizer, last_synced as lastSynced,
             pending_sync as pendingSync, geo_lat as geoLat, geo_lon as geoLon
      FROM events
      WHERE uid = ? AND recurrence_id IS NULL
      LIMIT 1
    `);
		return stmt.get(uid) ?? null;
	}

	/** Full-text search across summary, description, location, organizer, attendees.
	 *  Returns up to 20 most-recent matching events. */
	searchEvents(query: string): Array<{ uid: string; recurrenceId: string | null; summary: string; dtstartUtc: string; calendarId: string; accountId: string }> {
		const q = `%${query.toLowerCase()}%`;
		return this.db.query(`
      SELECT uid, recurrence_id as recurrenceId, summary, dtstart_utc as dtstartUtc,
             calendar_id as calendarId, account_id as accountId
      FROM events
      WHERE dtstart_utc IS NOT NULL
        AND (lower(summary) LIKE ? OR lower(description) LIKE ? OR lower(location) LIKE ?
             OR lower(organizer) LIKE ? OR lower(attendees_text) LIKE ?)
      ORDER BY dtstart_utc DESC
      LIMIT 20
    `).all(q, q, q, q, q) as any[];
	}

	/** Get ETag map { href → etag } for a specific calendar (for sync diffing). */
	getEtags(calendarId: string): Map<string, string> {
		const stmt = this.db.prepare<{ href: string; etag: string }, string>(`
      SELECT href, etag FROM events WHERE calendar_id = ? AND etag IS NOT NULL AND pending_sync IS NOT 'create'
    `);
		const rows = stmt.all(calendarId);
		return new Map(rows.map((r) => [r.href, r.etag]));
	}

	/**
	 * Insert or update an event row.
	 * Computes UTC dtstart/dtend from the parsed ICalEvent.
	 * Returns the UID.
	 */
	upsertEvent(
		event: ICalEvent,
		calendarId: string,
		accountId: string,
		href: string,
		etag: string | null,
		icsPath: string,
		pendingSync: string | null = null,
	): string {
		const dtstart = toUtcISO(event.dtstart, event.dtstartTzid, event.dtstartIsDate);
		const dtstartUtc = iCalToUtcISOStr(event.dtstart, event.dtstartTzid, event.dtstartIsDate);
		let dtend: string | null = null;
		let dtendUtc: string | null = null;
		if (event.dtend) {
			dtend = toUtcISO(event.dtend, event.dtendTzid, event.dtstartIsDate);
			dtendUtc = iCalToUtcISOStr(event.dtend, event.dtendTzid, event.dtstartIsDate);
		}
		// Normalize all-day events where DTEND ≤ DTSTART (zero-duration, non-standard).
		// Some ICS feeds use same-day DTEND instead of RFC 5545 exclusive next-day DTEND.
		// Without this, dtend_utc = dtstart_utc and the SQL strict > comparison excludes
		// the event from its own date's query range.
		if (event.dtstartIsDate && dtstartUtc && dtendUtc && dtendUtc <= dtstartUtc) {
			const d = new Date(dtstartUtc);
			d.setUTCDate(d.getUTCDate() + 1);
			const y = d.getUTCFullYear(), mo = String(d.getUTCMonth() + 1).padStart(2, "0"), da = String(d.getUTCDate()).padStart(2, "0");
			dtend = `${y}${mo}${da}`;
			dtendUtc = `${y}-${mo}-${da}T00:00:00Z`;
		}
		// Note: if only DURATION is present, dtend/dtendUtc remain null;
		// instances.ts handles duration → end expansion at display time.

		// SQLite treats NULL != NULL in composite primary keys, so ON CONFLICT (uid, recurrence_id)
		// never fires when recurrence_id IS NULL, allowing duplicate non-override rows.
		// Manually delete any existing non-override row with the same UID before upserting.
		if (!event.recurrenceId) {
			this.db.prepare("DELETE FROM events WHERE uid = ? AND recurrence_id IS NULL AND href != ?")
				.run(event.uid, href);
		}

		const attendeesText = event.attendees.map((a) => `${a.cn} ${a.email}`).join(' ');
		const stmt = this.db.prepare(`
      INSERT INTO events
        (uid, account_id, calendar_id, etag, href, ics_path, summary, dtstart, dtend,
         dtstart_utc, dtend_utc, dtstart_is_date, rrule, exdates, recurrence_id,
         status, organizer, description, location, attendees_text, last_synced, pending_sync,
         geo_lat, geo_lon)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (uid, recurrence_id) DO UPDATE SET
        account_id = excluded.account_id,
        calendar_id = excluded.calendar_id,
        etag = excluded.etag,
        href = excluded.href,
        ics_path = excluded.ics_path,
        summary = excluded.summary,
        dtstart = excluded.dtstart,
        dtend = excluded.dtend,
        dtstart_utc = excluded.dtstart_utc,
        dtend_utc = excluded.dtend_utc,
        dtstart_is_date = excluded.dtstart_is_date,
        rrule = excluded.rrule,
        exdates = excluded.exdates,
        status = excluded.status,
        organizer = excluded.organizer,
        description = excluded.description,
        location = excluded.location,
        attendees_text = excluded.attendees_text,
        last_synced = excluded.last_synced,
        pending_sync = excluded.pending_sync,
        geo_lat = excluded.geo_lat,
        geo_lon = excluded.geo_lon
    `);
		stmt.run(
			event.uid,
			accountId,
			calendarId,
			etag,
			href,
			icsPath,
			event.summary,
			dtstart,
			dtend,
			dtstartUtc,
			dtendUtc,
			event.dtstartIsDate ? 1 : 0,
			event.rrule ?? null,
			JSON.stringify(event.exdate),
			event.recurrenceId ?? null,
			event.status,
			event.organizer,
			event.description,
			event.location,
			attendeesText,
			Date.now(),
			pendingSync,
			event.geoLat ?? null,
			event.geoLon ?? null,
		);
		return event.uid;
	}

	/** Delete an event and all its override rows. Also deletes ICS files. */
	deleteEvent(uid: string): void {
		// Get all ICS paths before deleting
		const pathStmt = this.db.prepare<{ ics_path: string }, string>(
			"SELECT ics_path FROM events WHERE uid = ?",
		);
		const paths = pathStmt.all(uid);
		for (const { ics_path } of paths) deleteICSFile(ics_path);

		this.db.prepare("DELETE FROM events WHERE uid = ?").run(uid);
	}

	/**
	 * Remove event rows for a href whose UIDs are no longer present in the current ICS.
	 * Used after parser fixes (e.g. VALARM-UID bug) to clean up stale rows that were
	 * stored under wrong UIDs from the old parser.
	 */
	cleanupStaleHrefRows(href: string, validUids: string[]): void {
		if (validUids.length === 0) return;
		const placeholders = validUids.map(() => "?").join(", ");
		const stale = this.db.prepare<{ ics_path: string }, unknown[]>(
			`SELECT ics_path FROM events WHERE href = ? AND uid NOT IN (${placeholders})`,
		).all(href, ...validUids);
		for (const { ics_path } of stale) deleteICSFile(ics_path);
		this.db.prepare(`DELETE FROM events WHERE href = ? AND uid NOT IN (${placeholders})`)
			.run(href, ...validUids);
	}

	/** Delete all event rows with a given href (used when remote event is gone). */
	deleteEventByHref(href: string): void {
		const pathStmt = this.db.prepare<{ ics_path: string }, string>(
			"SELECT ics_path FROM events WHERE href = ?",
		);
		const paths = pathStmt.all(href);
		for (const { ics_path } of paths) deleteICSFile(ics_path);
		this.db.prepare("DELETE FROM events WHERE href = ?").run(href);
	}

	/** Delete a single override instance (RECURRENCE-ID). */
	deleteOverride(uid: string, recurrenceId: string): void {
		const pathStmt = this.db.prepare<{ ics_path: string }, [string, string]>(
			"SELECT ics_path FROM events WHERE uid = ? AND recurrence_id = ?",
		);
		const row = pathStmt.get(uid, recurrenceId);
		if (row) deleteICSFile(row.ics_path);
		this.db.prepare("DELETE FROM events WHERE uid = ? AND recurrence_id = ?").run(uid, recurrenceId);
	}

	/** Delete all events (and their overrides) for a calendar. */
	deleteEventsByCalendar(calendarId: string): void {
		const pathStmt = this.db.prepare<{ ics_path: string }, string>(
			"SELECT ics_path FROM events WHERE calendar_id = ?",
		);
		const paths = pathStmt.all(calendarId);
		for (const { ics_path } of paths) deleteICSFile(ics_path);
		this.db.prepare("DELETE FROM events WHERE calendar_id = ?").run(calendarId);
	}

	/** Delete all events for an account. */
	deleteEventsByAccount(accountId: string): void {
		const pathStmt = this.db.prepare<{ ics_path: string }, string>(
			"SELECT ics_path FROM events WHERE account_id = ?",
		);
		const paths = pathStmt.all(accountId);
		for (const { ics_path } of paths) deleteICSFile(ics_path);
		this.db.prepare("DELETE FROM events WHERE account_id = ?").run(accountId);
	}

	/** Delete override rows and events scheduled on or after a UTC ISO datetime (for thisAndFollowing). */
	deleteEventsFromDate(uid: string, fromUtcISO: string): void {
		const pathStmt = this.db.prepare<{ ics_path: string }, [string, string]>(
			"SELECT ics_path FROM events WHERE uid = ? AND dtstart_utc >= ?",
		);
		const paths = pathStmt.all(uid, fromUtcISO);
		for (const { ics_path } of paths) deleteICSFile(ics_path);
		this.db.prepare("DELETE FROM events WHERE uid = ? AND dtstart_utc >= ?").run(uid, fromUtcISO);
	}

	/** Set pending_sync on all rows for a UID (master + overrides). */
	setPendingSync(uid: string, state: string | null): void {
		this.db.prepare("UPDATE events SET pending_sync = ? WHERE uid = ?").run(state, uid);
	}

	/** Get all offline queue items in FIFO order. */
	getAllQueueItems(): OfflineQueueItem[] {
		return this.db.prepare<OfflineQueueItem, []>(`
      SELECT id, operation, uid, calendar_id as calendarId, account_id as accountId,
             href, etag, queued_at as queuedAt
      FROM offline_queue ORDER BY id ASC
    `).all();
	}

	/**
	 * Add an item to the offline queue with deduplication:
	 * - update while create pending → no-op (create will push latest ICS)
	 * - update while update pending → no-op (ICS on disk is latest)
	 * - delete replaces any existing entry for same uid
	 */
	addToQueue(item: Omit<OfflineQueueItem, 'id' | 'queuedAt'>): void {
		const existing = this.db.prepare<{ id: number; operation: string }, string>(
			"SELECT id, operation FROM offline_queue WHERE uid = ? LIMIT 1",
		).get(item.uid);

		if (existing) {
			if (item.operation === 'update' && (existing.operation === 'create' || existing.operation === 'update')) {
				return; // existing entry will push latest ICS from disk
			}
			// delete or other → replace
			this.db.prepare("DELETE FROM offline_queue WHERE uid = ?").run(item.uid);
		}

		this.db.prepare(`
      INSERT INTO offline_queue (operation, uid, calendar_id, account_id, href, etag)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(item.operation, item.uid, item.calendarId, item.accountId, item.href, item.etag);
	}

	/** Remove a queue item by id. */
	removeFromQueue(id: number): void {
		this.db.prepare("DELETE FROM offline_queue WHERE id = ?").run(id);
	}

	/** Remove all queue items for a UID. */
	clearQueueForUid(uid: string): void {
		this.db.prepare("DELETE FROM offline_queue WHERE uid = ?").run(uid);
	}

	/** Count of events with pending_sync not null (i.e., items in queue). */
	getPendingCount(): number {
		const row = this.db.query<{ count: number }, []>(
			"SELECT COUNT(*) as count FROM offline_queue",
		).get();
		return row?.count ?? 0;
	}

	/** Hrefs of events with pending local changes for a calendar (for sync to skip). */
	getPendingSyncHrefs(calendarId: string): Set<string> {
		const rows = this.db.prepare<{ href: string | null }, string>(
			"SELECT href FROM offline_queue WHERE calendar_id = ? AND href IS NOT NULL AND href != ''",
		).all(calendarId);
		return new Set(rows.filter((r) => r.href).map((r) => r.href!));
	}

	/** Close the database connection. */
	close(): void {
		this.db.close();
	}
}
