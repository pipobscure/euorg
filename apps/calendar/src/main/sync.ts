/**
 * CalDAV sync orchestrator.
 *
 * Handles bidirectional sync: pulls remote changes into the local DB,
 * and pushes local writes to the CalDAV server.
 *
 * Recurring event edit scopes:
 *   "all"              — replace master ICS entirely (same UID)
 *   "this"             — add EXDATE to master + create RECURRENCE-ID override
 *   "thisAndFollowing" — truncate master RRULE (add UNTIL) + create new master with new UID
 */

import { readFileSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
	readAccounts,
	writeAccounts,
	allEnabledCalendars,
	type EuorgAccount,
	type CalDavCalendar,
} from "@euorg/shared/euorg-accounts.ts";

// ── Sync log ──────────────────────────────────────────────────────────────────

const LOG_DIR = join(homedir(), ".euorg", "calendar");
const LOG_PATH = join(LOG_DIR, "sync.log");

function logSyncResult(result: SyncResult): void {
	const ts = new Date().toISOString();
	const summary = `[${ts}] Sync: +${result.added} added, ${result.updated} updated, ${result.deleted} deleted, ${result.errors.length} error(s)`;
	const lines = [summary, ...result.errors.map((e) => `  ERROR: ${e}`)].join("\n") + "\n";
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		appendFileSync(LOG_PATH, lines, "utf8");
	} catch {
		// Logging failure is non-fatal
	}
}
import type { CalendarDB } from "./db.ts";
import { writeICS, readICS } from "./db.ts";
import {
	parseICS,
	serializeICS,
	generateUID,
	type ICalEvent,
	type VEventInput,
} from "./ics.ts";
import {
	discoverCalendars,
	listEtags,
	fetchEventsInRange,
	fetchEvent,
	createEvent as caldavCreate,
	updateEvent as caldavUpdate,
	deleteEvent as caldavDelete,
	type CalDAVCredentials,
} from "./caldav.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type RecurringEditScope = "this" | "thisAndFollowing" | "all";

export interface SyncProgress {
	phase: "discovering" | "syncing" | "done";
	done: number;
	total: number;
	accountName?: string;
	calendarName?: string;
	/** Events fetched so far within the current calendar (phase 2+) */
	eventsDone?: number;
	/** Total events to fetch in the current calendar (phase 2+) */
	eventsTotal?: number;
}

export interface SyncResult {
	added: number;
	updated: number;
	deleted: number;
	errors: string[];
}

type ProgressCallback = (progress: SyncProgress) => void;
type EventsStoredCallback = () => void;

// ── Credentials helper ────────────────────────────────────────────────────────

function creds(account: EuorgAccount): CalDAVCredentials {
	return {
		serverUrl: account.serverUrl,
		username: account.username,
		password: account.password,
	};
}

// ── Main sync ─────────────────────────────────────────────────────────────────

export async function syncAll(
	db: CalendarDB,
	onProgress: ProgressCallback,
	onEventsStored: EventsStoredCallback = () => {},
): Promise<SyncResult> {
	const cfg = readAccounts();
	const pairs = allEnabledCalendars(cfg);
	const result: SyncResult = { added: 0, updated: 0, deleted: 0, errors: [] };

	const total = pairs.length;
	let done = 0;

	for (const { account, calendar } of pairs) {
		onProgress({
			phase: "syncing",
			done,
			total,
			accountName: account.name,
			calendarName: calendar.name,
		});

		try {
			const r = await syncCalendar(
				db, account, calendar,
				onEventsStored,
				(eventsDone, eventsTotal) => onProgress({
					phase: "syncing", done, total,
					accountName: account.name, calendarName: calendar.name,
					eventsDone, eventsTotal,
				}),
			);
			result.added += r.added;
			result.updated += r.updated;
			result.deleted += r.deleted;
			result.errors.push(...r.errors);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			result.errors.push(`${account.name} / ${calendar.name}: ${msg}`);
		}

		done++;
	}

	onProgress({ phase: "done", done: total, total });
	logSyncResult(result);
	return result;
}

async function syncCalendar(
	db: CalendarDB,
	account: EuorgAccount,
	calendar: CalDavCalendar,
	onEventsStored: EventsStoredCallback,
	onEventProgress: (done: number, total: number) => void,
): Promise<SyncResult> {
	const result: SyncResult = { added: 0, updated: 0, deleted: 0, errors: [] };
	const c = creds(account);

	// Helper: process a batch of { href, etag, ics } items from the server
	function storeEvents(
		items: Array<{ href: string; etag: string; ics: string }>,
		localEtags: Map<string, string>,
		r: SyncResult,
	): Set<string> {
		const processed = new Set<string>();
		for (const { href, etag, ics } of items) {
			processed.add(href);
			const localEtag = localEtags.get(href);
			if (localEtag === etag) continue; // already up to date
			try {
				const parsed = parseICS(ics);
				for (const event of parsed.events) {
					const path = writeICS(event.uid, event.recurrenceId, ics);
					db.upsertEvent(event, calendar.id, account.id, href, etag, path);
				}
				if (!localEtag) r.added++; else r.updated++;
			} catch (e) {
				r.errors.push(`Store ${href}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		return processed;
	}

	const now = new Date();
	const toUTC = (d: Date) => {
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
	};

	// ── Phase 1: near-term (today −2mo to +6mo) with ICS data ─────────────────
	// Fetches the events the user cares about most first.
	const p1Start = new Date(now); p1Start.setMonth(p1Start.getMonth() - 2);
	const p1End = new Date(now); p1End.setMonth(p1End.getMonth() + 6);

	let localEtags = db.getEtags(calendar.id);
	const phase1Hrefs = new Set<string>();
	try {
		const nearTerm = await fetchEventsInRange(calendar.url, c, toUTC(p1Start), toUTC(p1End));
		const processed = storeEvents(nearTerm, localEtags, result);
		for (const h of processed) phase1Hrefs.add(h);
		if (nearTerm.length > 0) onEventsStored(); // update UI immediately
	} catch {
		// Phase 1 failure is non-fatal; fall through to full sync
	}

	// ── Phase 2: far future (+6mo to +5yr) with ICS data ──────────────────────
	const p2End = new Date(now); p2End.setFullYear(p2End.getFullYear() + 5);
	try {
		const future = await fetchEventsInRange(calendar.url, c, toUTC(p1End), toUTC(p2End));
		localEtags = db.getEtags(calendar.id);
		const processed = storeEvents(future, localEtags, result);
		for (const h of processed) phase1Hrefs.add(h);
		if (future.length > 0) onEventsStored();
	} catch {}

	// ── Phase 3: recent past (−5yr to −2mo) with ICS data ────────────────────
	const p3Start = new Date(now); p3Start.setFullYear(p3Start.getFullYear() - 5);
	try {
		const past = await fetchEventsInRange(calendar.url, c, toUTC(p3Start), toUTC(p1Start));
		localEtags = db.getEtags(calendar.id);
		const processed = storeEvents(past, localEtags, result);
		for (const h of processed) phase1Hrefs.add(h);
		if (past.length > 0) onEventsStored();
	} catch {}

	// ── Phase 4: full ETag listing — catch anything outside ±5yr or changed ───
	const remoteEtags = await listEtags(calendar.url, c);
	localEtags = db.getEtags(calendar.id);

	const toFetch: string[] = [];
	const toDelete: string[] = [];

	for (const [href, remoteEtag] of remoteEtags) {
		if (phase1Hrefs.has(href)) continue; // already handled
		const localEtag = localEtags.get(href);
		if (!localEtag || localEtag !== remoteEtag) toFetch.push(href);
	}
	for (const [href] of localEtags) {
		if (!remoteEtags.has(href)) toDelete.push(href);
	}

	const eventsTotal = toFetch.length;
	let eventsDone = 0;
	const BATCH = 50; // notify UI every N events

	for (const href of toFetch) {
		try {
			const { ics, etag } = await fetchEvent(href, account.serverUrl, c);
			const parsed = parseICS(ics);
			for (const event of parsed.events) {
				const path = writeICS(event.uid, event.recurrenceId, ics);
				db.upsertEvent(event, calendar.id, account.id, href, etag, path);
			}
			const isNew = !localEtags.has(href);
			if (isNew) result.added++; else result.updated++;
		} catch (e) {
			result.errors.push(`Fetch ${href}: ${e instanceof Error ? e.message : String(e)}`);
		}

		eventsDone++;
		if (eventsDone % BATCH === 0 || eventsDone === eventsTotal) {
			onEventProgress(eventsDone, eventsTotal);
			onEventsStored();
		}
	}

	// Handle deletions by href
	for (const href of toDelete) {
		try {
			db.deleteEventByHref(href);
			result.deleted++;
		} catch (e) {
			result.errors.push(`Delete ${href}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return result;
}

// ── Write Operations ──────────────────────────────────────────────────────────

/**
 * Create a new event on the CalDAV server and in the local DB.
 * Returns the new UID.
 */
export async function writeCreate(
	db: CalendarDB,
	input: VEventInput,
	calendarId: string,
	accountId: string,
): Promise<string> {
	const cfg = readAccounts();
	const account = cfg.accounts.find((a) => a.id === accountId);
	if (!account) throw new Error(`Account ${accountId} not found`);
	const calendar = account.caldav?.calendars.find((c) => c.id === calendarId);
	if (!calendar) throw new Error(`Calendar ${calendarId} not found`);

	const uid = generateUID();
	const icsText = serializeICS({ ...input, uid });
	const { href, etag } = await caldavCreate(calendar.url, uid, icsText, creds(account));

	const parsed = parseICS(icsText);
	const event = parsed.events[0];
	if (event) {
		const path = writeICS(uid, null, icsText);
		db.upsertEvent(event, calendarId, accountId, href, etag, path);
	}

	return uid;
}

/**
 * Update an event on the CalDAV server and in the local DB.
 *
 * scope="all": replace master ICS entirely
 * scope="this": add EXDATE to master, create override
 * scope="thisAndFollowing": truncate master RRULE, create new event
 */
export async function writeUpdate(
	db: CalendarDB,
	uid: string,
	input: VEventInput,
	scope: RecurringEditScope,
	instanceStartISO?: string, // required for "this" and "thisAndFollowing"
): Promise<void> {
	const cfg = readAccounts();
	const row = db.getEvent(uid);
	if (!row) throw new Error(`Event ${uid} not found`);

	const account = cfg.accounts.find((a) => a.id === row.accountId);
	if (!account) throw new Error(`Account ${row.accountId} not found`);
	const calendar = account.caldav?.calendars.find((c) => c.id === row.calendarId);
	if (!calendar) throw new Error(`Calendar ${row.calendarId} not found`);
	const c = creds(account);

	if (scope === "all" || !row.rrule) {
		// Replace master ICS
		const newICS = serializeICS({ ...input, uid, sequence: getSequence(row.icsPath, uid) + 1 });
		const newEtag = await caldavUpdate(row.href, account.serverUrl, newICS, row.etag ?? "", c);
		const parsed = parseICS(newICS);
		const event = parsed.events[0];
		if (event) {
			const path = writeICS(uid, null, newICS);
			db.upsertEvent(event, row.calendarId, row.accountId, row.href, newEtag, path);
		}
	} else if (scope === "this" && instanceStartISO) {
		// Read master ICS
		const masterICS = readICS(row.icsPath);
		if (!masterICS) throw new Error("Cannot read master ICS");
		const masterParsed = parseICS(masterICS);
		const master = masterParsed.events.find((e) => e.uid === uid && !e.recurrenceId);
		if (!master) throw new Error("Master event not found in ICS");

		// Add EXDATE for this instance
		const exdateVal = isoToICalDateTime(instanceStartISO, master.dtstartTzid);
		const newExdates = [...master.exdate, exdateVal];
		const updatedMasterICS = rebuildMasterWithExdate(masterICS, uid, newExdates);
		const newMasterEtag = await caldavUpdate(
			row.href, account.serverUrl, updatedMasterICS, row.etag ?? "", c,
		);
		const masterPath = writeICS(uid, null, updatedMasterICS);
		const masterEvent = parseICS(updatedMasterICS).events[0];
		if (masterEvent) {
			db.upsertEvent(masterEvent, row.calendarId, row.accountId, row.href, newMasterEtag, masterPath);
		}

		// Create override VEVENT with RECURRENCE-ID
		const recurrenceId = exdateVal;
		const overrideICS = serializeICS({
			...input,
			uid,
			sequence: (master.sequence ?? 0) + 1,
			method: undefined,
		}, recurrenceId);
		const overrideHref = `${calendar.url.replace(/\/$/, "")}/${encodeURIComponent(uid)}_${encodeURIComponent(recurrenceId)}.ics`;
		// PUT override as a new resource
		const { href: ovHref, etag: ovEtag } = await caldavCreate(
			calendar.url, `${uid}_${recurrenceId}`, overrideICS, c,
		);
		const overrideEvent = parseICS(overrideICS).events[0];
		if (overrideEvent) {
			// Manually set recurrenceId
			overrideEvent.recurrenceId = recurrenceId;
			const ovPath = writeICS(uid, recurrenceId, overrideICS);
			db.upsertEvent(overrideEvent, row.calendarId, row.accountId, ovHref, ovEtag, ovPath);
		}
	} else if (scope === "thisAndFollowing" && instanceStartISO) {
		// Truncate master: add UNTIL to RRULE (day before instanceStart)
		const masterICS = readICS(row.icsPath);
		if (!masterICS) throw new Error("Cannot read master ICS");
		const masterParsed = parseICS(masterICS);
		const master = masterParsed.events.find((e) => e.uid === uid && !e.recurrenceId);
		if (!master) throw new Error("Master event not found in ICS");

		const untilStr = isoToICalDate(subtractOneDay(instanceStartISO));
		const truncatedRRule = addUntilToRRule(master.rrule ?? "", untilStr);
		const truncatedICS = rebuildMasterWithRRule(masterICS, uid, truncatedRRule);
		const truncEtag = await caldavUpdate(row.href, account.serverUrl, truncatedICS, row.etag ?? "", c);
		const truncPath = writeICS(uid, null, truncatedICS);
		const truncEvent = parseICS(truncatedICS).events[0];
		if (truncEvent) {
			db.upsertEvent(truncEvent, row.calendarId, row.accountId, row.href, truncEtag, truncPath);
		}
		// Delete local overrides from instanceStart onwards (convert to UTC for dtstart_utc comparison)
		db.deleteEventsFromDate(uid, new Date(instanceStartISO).toISOString().replace(/\.\d{3}Z$/, "Z"));

		// Create new master event starting from instanceStart
		const newInput: VEventInput = { ...input, uid: undefined, rrule: input.rrule };
		await writeCreate(db, newInput, row.calendarId, row.accountId);
	}
}

/**
 * Delete an event from the CalDAV server and local DB.
 */
export async function writeDelete(
	db: CalendarDB,
	uid: string,
	scope: RecurringEditScope,
	instanceStartISO?: string,
): Promise<void> {
	const cfg = readAccounts();
	const row = db.getEvent(uid);
	if (!row) throw new Error(`Event ${uid} not found`);

	const account = cfg.accounts.find((a) => a.id === row.accountId);
	if (!account) throw new Error(`Account ${row.accountId} not found`);
	const c = creds(account);

	if (scope === "all" || !row.rrule) {
		await caldavDelete(row.href, account.serverUrl, row.etag ?? "", c);
		db.deleteEvent(uid);
	} else if (scope === "this" && instanceStartISO) {
		// Add EXDATE for this instance to master
		const masterICS = readICS(row.icsPath);
		if (!masterICS) throw new Error("Cannot read master ICS");
		const masterParsed = parseICS(masterICS);
		const master = masterParsed.events.find((e) => e.uid === uid && !e.recurrenceId);
		if (!master) throw new Error("Master event not found");
		const exdateVal = isoToICalDateTime(instanceStartISO, master.dtstartTzid);
		const newExdates = [...master.exdate, exdateVal];
		const updatedMasterICS = rebuildMasterWithExdate(masterICS, uid, newExdates);
		const newEtag = await caldavUpdate(row.href, account.serverUrl, updatedMasterICS, row.etag ?? "", c);
		const masterPath = writeICS(uid, null, updatedMasterICS);
		const masterEvent = parseICS(updatedMasterICS).events[0];
		if (masterEvent) {
			db.upsertEvent(masterEvent, row.calendarId, row.accountId, row.href, newEtag, masterPath);
		}
		// Also delete override row if it exists
		if (instanceStartISO) {
			const ridKey = isoToICalDateTime(instanceStartISO, master.dtstartTzid);
			db.deleteOverride(uid, ridKey);
		}
	} else if (scope === "thisAndFollowing" && instanceStartISO) {
		const masterICS = readICS(row.icsPath);
		if (!masterICS) throw new Error("Cannot read master ICS");
		const masterParsed = parseICS(masterICS);
		const master = masterParsed.events.find((e) => e.uid === uid && !e.recurrenceId);
		if (!master) throw new Error("Master event not found");

		const untilStr = isoToICalDate(subtractOneDay(instanceStartISO));
		const truncatedRRule = addUntilToRRule(master.rrule ?? "", untilStr);
		const truncatedICS = rebuildMasterWithRRule(masterICS, uid, truncatedRRule);
		const truncEtag = await caldavUpdate(row.href, account.serverUrl, truncatedICS, row.etag ?? "", c);
		const truncPath = writeICS(uid, null, truncatedICS);
		const truncEvent = parseICS(truncatedICS).events[0];
		if (truncEvent) {
			db.upsertEvent(truncEvent, row.calendarId, row.accountId, row.href, truncEtag, truncPath);
		}
		// Delete local instances from instanceStart onwards (convert to UTC for dtstart_utc comparison)
		db.deleteEventsFromDate(uid, new Date(instanceStartISO).toISOString().replace(/\.\d{3}Z$/, "Z"));
	}
}

/**
 * Reschedule an event (from drag & drop).
 * Computes new start/end from the drag delta and calls writeUpdate.
 */
export async function writeReschedule(
	db: CalendarDB,
	uid: string,
	instanceStartISO: string,
	newStartISO: string,
	scope: RecurringEditScope,
): Promise<void> {
	const row = db.getEvent(uid);
	if (!row) throw new Error(`Event ${uid} not found`);

	const rawICS = readICS(row.icsPath);
	if (!rawICS) throw new Error("Cannot read event ICS");
	const parsed = parseICS(rawICS);
	const ev = parsed.events.find((e) => e.uid === uid && !e.recurrenceId);
	if (!ev) throw new Error("Event not found in ICS");

	// Compute duration to preserve end offset
	const startMs = new Date(instanceStartISO).getTime();
	const endMs = ev.dtend ? new Date(ev.dtend).getTime() : startMs + 3600_000;
	const durationMs = endMs - startMs;
	const newEndMs = new Date(newStartISO).getTime() + durationMs;
	const newEndISO = new Date(newEndMs).toISOString();

	const input: VEventInput = {
		uid,
		summary: ev.summary,
		description: ev.description,
		location: ev.location,
		startISO: newStartISO,
		endISO: newEndISO,
		isAllDay: ev.dtstartIsDate,
		tzid: ev.dtstartTzid ?? undefined,
		rrule: ev.rrule ?? undefined,
		organizer: ev.organizer,
		attendees: ev.attendees.map((a) => ({ email: a.email, cn: a.cn, role: a.role })),
	};

	await writeUpdate(db, uid, input, scope, instanceStartISO);
}

// ── ICS string manipulation helpers ──────────────────────────────────────────

function getSequence(icsPath: string, uid: string): number {
	const ics = readICS(icsPath);
	if (!ics) return 0;
	const parsed = parseICS(ics);
	return parsed.events.find((e) => e.uid === uid)?.sequence ?? 0;
}

/** Rebuild an ICS string, replacing EXDATE lines for a specific UID's master event */
function rebuildMasterWithExdate(icsText: string, uid: string, exdates: string[]): string {
	// Remove existing EXDATE lines and add new ones before END:VEVENT
	const lines = icsText.replace(/\r\n/g, "\n").split("\n");
	const result: string[] = [];
	let inTargetVEvent = false;
	let foundUid = false;

	for (const line of lines) {
		if (line === "BEGIN:VEVENT") { inTargetVEvent = true; foundUid = false; }
		if (inTargetVEvent && line.startsWith("UID:") && line.slice(4).trim() === uid) foundUid = true;
		if (inTargetVEvent && foundUid && line.startsWith("EXDATE")) continue; // skip old EXDATEs
		if (inTargetVEvent && foundUid && line === "END:VEVENT") {
			// Inject new EXDATEs
			for (const ex of exdates) result.push(`EXDATE:${ex}`);
		}
		result.push(line);
		if (line === "END:VEVENT") { inTargetVEvent = false; foundUid = false; }
	}
	return result.join("\r\n");
}

/** Rebuild an ICS string, replacing RRULE for a specific UID's master event */
function rebuildMasterWithRRule(icsText: string, uid: string, newRRule: string): string {
	const lines = icsText.replace(/\r\n/g, "\n").split("\n");
	const result: string[] = [];
	let inTargetVEvent = false;
	let foundUid = false;

	for (const line of lines) {
		if (line === "BEGIN:VEVENT") { inTargetVEvent = true; foundUid = false; }
		if (inTargetVEvent && line.startsWith("UID:") && line.slice(4).trim() === uid) foundUid = true;
		if (inTargetVEvent && foundUid && line.startsWith("RRULE:")) {
			result.push(`RRULE:${newRRule}`);
			continue;
		}
		result.push(line);
		if (line === "END:VEVENT") { inTargetVEvent = false; foundUid = false; }
	}
	return result.join("\r\n");
}

/** Append UNTIL=<value> to an RRULE string (or replace existing UNTIL) */
function addUntilToRRule(rrule: string, untilStr: string): string {
	const parts = rrule.split(";").filter((p) => !p.startsWith("UNTIL=") && !p.startsWith("COUNT="));
	parts.push(`UNTIL=${untilStr}`);
	return parts.join(";");
}

/** Convert an ISO datetime to iCal DATE format YYYYMMDD */
function isoToICalDate(iso: string): string {
	return iso.slice(0, 10).replace(/-/g, "");
}

/** Convert an ISO datetime to iCal DATETIME format YYYYMMDDTHHMMSSZ */
function isoToICalDateTime(iso: string, tzid: string | null): string {
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** Subtract one day from an ISO date string */
function subtractOneDay(iso: string): string {
	const d = new Date(iso);
	d.setUTCDate(d.getUTCDate() - 1);
	return d.toISOString();
}

/** Discover and update CalDAV calendars for an account, persisting to accounts.json */
export async function rediscoverCalendars(accountId: string): Promise<CalDavCalendar[]> {
	const cfg = readAccounts();
	const account = cfg.accounts.find((a) => a.id === accountId);
	if (!account) throw new Error(`Account ${accountId} not found`);

	const remote = await discoverCalendars(creds(account));

	const existing = account.caldav?.calendars ?? [];
	const calendars: CalDavCalendar[] = remote.map((r) => {
		const prev = existing.find((c) => c.id === r.id);
		return {
			id: r.id,
			url: r.url,
			name: r.name,
			color: prev?.color ?? r.color ?? "#6366f1",
			enabled: prev?.enabled ?? true,
		};
	});

	account.caldav = {
		homeUrl: account.caldav?.homeUrl ?? null,
		defaultCalendarId: account.caldav?.defaultCalendarId ?? (calendars[0]?.id ?? null),
		calendars,
	};

	const newCfg = {
		...cfg,
		accounts: cfg.accounts.map((a) => (a.id === accountId ? account : a)),
	};
	writeAccounts(newCfg);

	return calendars;
}

/** Serialize VEventInput with a RECURRENCE-ID override (for "this" edit scope) */
function serializeOverrideICS(input: VEventInput, recurrenceId: string): string {
	const lines: string[] = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//euorg//Calendar//EN",
		"CALSCALE:GREGORIAN",
		"BEGIN:VEVENT",
		`UID:${input.uid}`,
		`RECURRENCE-ID:${recurrenceId}`,
	];
	// Minimal for now; serializeICS handles the full case
	lines.push("END:VEVENT", "END:VCALENDAR");
	return lines.join("\r\n") + "\r\n";
}
