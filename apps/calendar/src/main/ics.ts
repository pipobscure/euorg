/**
 * ICS (iCalendar, RFC 5545) adapter — wraps @pipobscure/ical.
 *
 * Exposes the same interface as before (ICalEvent, ICalObject, VEventInput,
 * parseICS, serializeICS, updateEventInICS, toUtcISO, parseICalDateTime,
 * parseDuration, generateUID, getVTimezone) so callers need no changes.
 *
 * Only import from Bun (main-process) code.
 */

import { Temporal } from "@js-temporal/polyfill";
import {
	parse as libParse,
	parseAll as libParseAll,
	Calendar as LibCalendar,
	Event as LibEvent,
	parseProperty as libParseProperty,
} from "@pipobscure/ical";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ICalAttendee {
	/** Email address (mailto: URI stripped) */
	email: string;
	/** CN parameter */
	cn: string;
	/** PARTSTAT: ACCEPTED | DECLINED | NEEDS-ACTION | TENTATIVE */
	partstat: string;
	/** ROLE: REQ-PARTICIPANT | OPT-PARTICIPANT | CHAIR */
	role: string;
	rsvp: boolean;
}

export interface ICalEvent {
	uid: string;
	summary: string;
	description: string;
	location: string;
	/** URL property (RFC 5545) or URI extracted from CONFERENCE property */
	url: string;
	/** Raw value from ICS, e.g. "20240315T090000Z" or "20240315" */
	dtstart: string;
	/** TZID parameter from DTSTART (null if UTC or VALUE=DATE) */
	dtstartTzid: string | null;
	/** true when DTSTART has VALUE=DATE (all-day event) */
	dtstartIsDate: boolean;
	/** Raw DTEND value; null if not present (use duration) */
	dtend: string | null;
	/** TZID parameter from DTEND */
	dtendTzid: string | null;
	/** DURATION value string, e.g. "PT1H30M" (if DTEND absent) */
	duration: string | null;
	/** Raw RRULE value, e.g. "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10" */
	rrule: string | null;
	/** Raw EXDATE values (may include comma-separated values) */
	exdate: string[];
	/** Raw RDATE values */
	rdate: string[];
	/** RECURRENCE-ID value (present on exception override instances) */
	recurrenceId: string | null;
	/** TZID parameter from RECURRENCE-ID */
	recurrenceIdTzid: string | null;
	status: "CONFIRMED" | "TENTATIVE" | "CANCELLED" | "";
	transp: "OPAQUE" | "TRANSPARENT";
	/** mailto: URI for organizer */
	organizer: string;
	attendees: ICalAttendee[];
	sequence: number;
	created: string;
	lastModified: string;
	/** GEO property latitude (RFC 5545 §3.8.1.6) */
	geoLat: number | null;
	/** GEO property longitude */
	geoLon: number | null;
	/** Full raw VEVENT block for round-trip fidelity */
	raw: string;
}

export interface ICalObject {
	prodid: string;
	version: string;
	calscale: string;
	/** METHOD value, e.g. "REQUEST", "REPLY", "CANCEL" */
	method: string | null;
	events: ICalEvent[];
	/** Raw VTIMEZONE blocks (preserved verbatim for round-trip safety) */
	timezones: string[];
}

/** Input type for creating/updating events */
export interface VEventInput {
	uid?: string;
	calendarId?: string;
	summary: string;
	description?: string;
	location?: string;
	/** URL property for the event (e.g. meeting join link) */
	url?: string;
	/** ISO datetime string in local timezone or UTC, e.g. "2024-03-15T09:00:00" */
	startISO: string;
	/** ISO datetime string */
	endISO: string;
	isAllDay: boolean;
	/** TZID for the event timezone, e.g. "Europe/Berlin" */
	tzid?: string;
	/** Raw RRULE value string */
	rrule?: string;
	attendees?: Array<{ email: string; cn?: string; role?: string }>;
	organizer?: string;
	sequence?: number;
	/** METHOD for iTIP: "REQUEST", "REPLY", "CANCEL" */
	method?: string;
	/** Existing attendees with their PARTSTAT (for REPLY) */
	existingAttendees?: ICalAttendee[];
	/** RECURRENCE-ID for override instances (iCal datetime string, e.g. "20260222T100000Z") */
	recurrenceId?: string;
	/** GEO latitude (RFC 5545 §3.8.1.6) */
	geoLat?: number;
	/** GEO longitude */
	geoLon?: number;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Get a scalar string from a Property's params (handles string | string[]) */
function param(params: Readonly<Record<string, string | readonly string[]>>, key: string): string {
	const v = params[key];
	if (Array.isArray(v)) return (v as string[])[0] ?? "";
	return (v as string | undefined) ?? "";
}

/**
 * Decode HTML entities from text (RFC 5545 text escapes are already handled
 * by the library; this covers non-standard HTML entities found in some feeds).
 */
function decodeHtmlEntities(s: string): string {
	return s
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
		.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}

/** Convert a library LibEvent to the app's ICalEvent */
function toICalEvent(evt: LibEvent): ICalEvent {
	// DTSTART
	const dtstartProp = evt.getProperty("DTSTART");
	const dtstart = dtstartProp?.rawValue ?? "";
	const dtstartTzid = param(dtstartProp?.params ?? {}, "TZID") || null;
	const dtstartIsDate =
		param(dtstartProp?.params ?? {}, "VALUE") === "DATE" || /^\d{8}$/.test(dtstart);

	// DTEND
	const dtendProp = evt.getProperty("DTEND");
	const dtend = dtendProp?.rawValue ?? null;
	const dtendTzid = param(dtendProp?.params ?? {}, "TZID") || null;

	// DURATION
	const duration = evt.getProperty("DURATION")?.rawValue ?? null;

	// RRULE — raw value (library parses to ICalRecur, we need raw string for rrule.ts)
	const rrule = evt.getProperty("RRULE")?.rawValue ?? null;

	// EXDATE / RDATE — raw values, split comma-lists
	const exdate: string[] = evt.getProperties("EXDATE")
		.flatMap((p) => p.rawValue.split(",").map((v) => v.trim()).filter(Boolean));
	const rdate: string[] = evt.getProperties("RDATE")
		.flatMap((p) => p.rawValue.split(",").map((v) => v.trim()).filter(Boolean));

	// RECURRENCE-ID
	const ridProp = evt.getProperty("RECURRENCE-ID");
	const recurrenceId = ridProp?.rawValue ?? null;
	const recurrenceIdTzid = param(ridProp?.params ?? {}, "TZID") || null;

	// STATUS / TRANSP
	const status = (evt.status ?? "") as ICalEvent["status"];
	const transp = evt.transp === "TRANSPARENT" ? "TRANSPARENT" : "OPAQUE";

	// ORGANIZER — strip mailto: prefix
	const organizer = (evt.organizer ?? "").replace(/^mailto:/i, "");

	// ATTENDEES
	const attendees: ICalAttendee[] = evt.attendees.map((p) => ({
		email: (p.text ?? "").replace(/^mailto:/i, ""),
		cn: param(p.params, "CN"),
		partstat: param(p.params, "PARTSTAT") || "NEEDS-ACTION",
		role: param(p.params, "ROLE") || "REQ-PARTICIPANT",
		rsvp: param(p.params, "RSVP").toUpperCase() === "TRUE",
	}));

	// GEO
	const geo = evt.geo;

	// Text properties (library handles RFC 5545 text unescaping; we add HTML entities on top)
	const summary = decodeHtmlEntities(evt.summary ?? "");
	const description = decodeHtmlEntities(evt.description ?? "");
	const location = decodeHtmlEntities(evt.location ?? "");

	// URL + CONFERENCE
	const url = evt.url ?? evt.getProperty("CONFERENCE")?.rawValue ?? "";

	// Scalar metadata
	const sequence = evt.sequence ?? 0;
	const created = evt.getProperty("CREATED")?.rawValue ?? "";
	const lastModified = evt.getProperty("LAST-MODIFIED")?.rawValue ?? "";

	// Raw VEVENT block
	const raw = evt.toString();

	return {
		uid: evt.uid ?? "",
		summary,
		description,
		location,
		url,
		dtstart,
		dtstartTzid,
		dtstartIsDate,
		dtend,
		dtendTzid,
		duration,
		rrule,
		exdate,
		rdate,
		recurrenceId,
		recurrenceIdTzid,
		status,
		transp,
		organizer,
		attendees,
		sequence,
		created,
		lastModified,
		geoLat: geo?.latitude ?? null,
		geoLon: geo?.longitude ?? null,
		raw,
	};
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse a full VCALENDAR text into an ICalObject.
 * Gracefully ignores unknown components.
 */
export function parseICS(text: string): ICalObject {
	const calendars = libParseAll(text);

	const obj: ICalObject = {
		prodid: "",
		version: "2.0",
		calscale: "GREGORIAN",
		method: null,
		events: [],
		timezones: [],
	};

	for (const cal of calendars) {
		if (!obj.prodid && cal.prodid) obj.prodid = cal.prodid;
		if (!obj.method && cal.method) obj.method = cal.method;
		if (cal.calscale) obj.calscale = cal.calscale;

		// Preserve raw VTIMEZONE blocks
		for (const tz of cal.timezones) {
			obj.timezones.push(tz.toString());
		}

		// Convert events
		for (const evt of cal.events) {
			const event = toICalEvent(evt);
			if (event.uid) obj.events.push(event);
		}
	}

	return obj;
}

// ── VTIMEZONE generation ───────────────────────────────────────────────────────

const vtimezoneCache = new Map<string, string>();

/**
 * Fetch a VTIMEZONE block for the given IANA timezone ID.
 * Tries tzurl.org first (same source OX/mailbox.org uses), falls back to a
 * Temporal-generated minimal VTIMEZONE if the network request fails.
 */
export async function getVTimezone(tzid: string): Promise<string> {
	const cached = vtimezoneCache.get(tzid);
	if (cached) return cached;

	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 4000);
		const res = await fetch(
			`https://www.tzurl.org/zoneinfo-outlook/${encodeURIComponent(tzid)}`,
			{ signal: controller.signal },
		);
		clearTimeout(timer);
		if (res.ok) {
			const text = await res.text();
			// The response is a full VCALENDAR — extract just the VTIMEZONE block
			const match = text.match(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE/);
			if (match) {
				const block = match[0];
				vtimezoneCache.set(tzid, block);
				return block;
			}
		}
	} catch {
		// network error or timeout → fall through to Temporal fallback
	}

	const fallback = generateVTimezone(tzid);
	vtimezoneCache.set(tzid, fallback);
	return fallback;
}

/** Generate a minimal VTIMEZONE using Temporal (used when tzurl.org is unreachable). */
function generateVTimezone(tzid: string): string {
	try {
		const tz = Temporal.TimeZone.from(tzid);
		const now = Temporal.Now.instant();
		const offsetNs = tz.getOffsetNanosecondsFor(now);
		const offsetMin = Math.round(offsetNs / 60_000_000_000);
		const sign = offsetMin >= 0 ? "+" : "-";
		const abs = Math.abs(offsetMin);
		const h = String(Math.floor(abs / 60)).padStart(2, "0");
		const m = String(abs % 60).padStart(2, "0");
		const offset = `${sign}${h}${m}`;
		return [
			"BEGIN:VTIMEZONE",
			`TZID:${tzid}`,
			"BEGIN:STANDARD",
			"DTSTART:19700101T000000",
			`TZOFFSETFROM:${offset}`,
			`TZOFFSETTO:${offset}`,
			`TZNAME:${tzid}`,
			"END:STANDARD",
			"END:VTIMEZONE",
		].join("\r\n");
	} catch {
		return ["BEGIN:VTIMEZONE", `TZID:${tzid}`, "END:VTIMEZONE"].join("\r\n");
	}
}

/** Generate a new UID */
export function generateUID(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}@euorg`;
}

// ── Serialization helpers ─────────────────────────────────────────────────────

/**
 * Format an ISO or iCal datetime string for use in an ICS property value.
 * Same semantics as before — kept because VEventInput uses these raw strings.
 */
function formatDateTime(iso: string, isDate: boolean, tzid?: string): string {
	if (isDate) {
		return iso.replace(/-/g, "").slice(0, 8);
	}
	if (tzid) {
		if (/^\d{8}T\d{6}$/.test(iso)) return iso;
		if (iso.endsWith("Z")) {
			try {
				const inst = Temporal.Instant.from(iso);
				const zdt = inst.toZonedDateTimeISO(tzid);
				return (
					String(zdt.year).padStart(4, "0") +
					String(zdt.month).padStart(2, "0") +
					String(zdt.day).padStart(2, "0") +
					"T" +
					String(zdt.hour).padStart(2, "0") +
					String(zdt.minute).padStart(2, "0") +
					String(zdt.second).padStart(2, "0")
				);
			} catch {
				// fall through
			}
		}
		return iso.replace(/-/g, "").replace(/:/g, "").replace(/\.\d+/, "").slice(0, 15);
	}
	if (/^\d{8}T\d{6}Z$/.test(iso)) return iso;
	const d = new Date(iso);
	if (isNaN(d.getTime())) return iso;
	return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// ── Serialization ─────────────────────────────────────────────────────────────

/**
 * Serialize a VEventInput into a VCALENDAR ICS string.
 *
 * Pass a pre-fetched VTIMEZONE block string as `vtimezone` when the event
 * has a TZID. OX / mailbox.org requires a matching VTIMEZONE component.
 * Use getVTimezone(tzid) to obtain it before calling this function.
 */
export function serializeICS(input: VEventInput, vtimezone?: string): string {
	const cal = LibCalendar.create("-//euorg//Calendar//EN");
	if (input.method) cal.method = input.method;

	// Add VTIMEZONE component if provided
	if (vtimezone) {
		try {
			// Wrap in VCALENDAR for the library's parser
			const wrapped = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:tmp\r\n${vtimezone}\r\nEND:VCALENDAR`;
			const tzCal = libParse(wrapped);
			for (const tz of tzCal.timezones) {
				cal.addTimezone(tz);
			}
		} catch {
			// ignore parse errors — calendar still valid without VTIMEZONE
		}
	}

	const uid = input.uid ?? generateUID();
	const now = new Date();

	const evt = new LibEvent();
	evt.uid = uid;
	evt.dtstamp = now;
	evt.created = now;
	evt.lastModified = now;
	evt.sequence = input.sequence ?? 0;
	evt.summary = input.summary;
	if (input.description) evt.description = input.description;
	if (input.location) evt.location = input.location;
	if (input.url) evt.url = input.url;
	if (input.geoLat != null && input.geoLon != null) {
		evt.geo = { type: "geo", latitude: input.geoLat, longitude: input.geoLon };
	}

	// RECURRENCE-ID
	if (input.recurrenceId) {
		const ridParams = input.isAllDay ? { VALUE: "DATE" } : {};
		evt.addProperty(
			libParseProperty("RECURRENCE-ID", input.recurrenceId, ridParams),
		);
	}

	// DTSTART / DTEND
	if (input.isAllDay) {
		const startDate = formatDateTime(input.startISO, true);
		const endDate = formatDateTime(input.endISO, true);
		evt.addProperty(
			libParseProperty("DTSTART", startDate, { VALUE: "DATE" }),
		);
		evt.addProperty(
			libParseProperty("DTEND", endDate, { VALUE: "DATE" }),
		);
	} else {
		const start = formatDateTime(input.startISO, false, input.tzid);
		const end = formatDateTime(input.endISO, false, input.tzid);
		const params = input.tzid ? { TZID: input.tzid } : {};
		evt.addProperty(
			libParseProperty("DTSTART", start, params),
		);
		evt.addProperty(
			libParseProperty("DTEND", end, params),
		);
	}

	if (input.rrule) {
		evt.addProperty(
			libParseProperty("RRULE", input.rrule, {}),
		);
	}

	if (input.organizer) evt.organizer = `mailto:${input.organizer}`;

	for (const att of input.attendees ?? []) {
		evt.addAttendee(`mailto:${att.email}`, {
			ROLE: att.role ?? "REQ-PARTICIPANT",
			RSVP: "TRUE",
			PARTSTAT: "NEEDS-ACTION",
			...(att.cn ? { CN: att.cn } : {}),
		});
	}

	for (const att of input.existingAttendees ?? []) {
		evt.addAttendee(`mailto:${att.email}`, {
			PARTSTAT: att.partstat,
			ROLE: att.role,
			...(att.cn ? { CN: att.cn } : {}),
		});
	}

	cal.addEvent(evt);
	return cal.toString();
}

/** Update an existing ICS string to modify a specific VEVENT (matched by UID) */
export function updateEventInICS(
	originalICS: string,
	uid: string,
	updates: Partial<VEventInput>,
): string {
	const obj = parseICS(originalICS);
	const idx = obj.events.findIndex((e) => e.uid === uid);
	if (idx === -1) throw new Error(`Event ${uid} not found in ICS`);

	const ev = obj.events[idx]!;
	const input: VEventInput = {
		uid,
		summary: updates.summary ?? ev.summary,
		description: updates.description ?? ev.description,
		location: updates.location ?? ev.location,
		geoLat: updates.geoLat !== undefined ? updates.geoLat : ev.geoLat ?? undefined,
		geoLon: updates.geoLon !== undefined ? updates.geoLon : ev.geoLon ?? undefined,
		url: updates.url ?? ev.url,
		startISO: updates.startISO ?? ev.dtstart,
		endISO: updates.endISO ?? ev.dtend ?? ev.dtstart,
		isAllDay: updates.isAllDay ?? ev.dtstartIsDate,
		tzid: updates.tzid ?? ev.dtstartTzid ?? undefined,
		rrule: updates.rrule !== undefined ? updates.rrule : ev.rrule ?? undefined,
		attendees: updates.attendees,
		organizer: updates.organizer ?? ev.organizer,
		sequence: (ev.sequence ?? 0) + 1,
		method: updates.method,
	};
	return serializeICS(input);
}

// ── Utility functions (used by db.ts, rrule.ts, instances.ts) ─────────────────

/**
 * Parse DTSTART/DTEND into a UTC ISO string for DB storage.
 * Returns null for all-day events (store date string as-is).
 */
export function toUtcISO(rawValue: string, tzid: string | null, isDate: boolean): string {
	if (isDate) return rawValue.slice(0, 8);

	if (rawValue.endsWith("Z")) {
		return parseICalDateTime(rawValue).toISOString();
	}

	if (!tzid) {
		return parseICalDateTime(rawValue).toISOString();
	}
	return `${rawValue}[${tzid}]`;
}

/** Parse an iCalendar datetime string (YYYYMMDDTHHMMSSZ or YYYYMMDDTHHMMSS) to a JS Date */
export function parseICalDateTime(s: string): Date {
	const isUtc = s.endsWith("Z");
	const clean = s.replace("Z", "");
	const yr = clean.slice(0, 4);
	const mo = clean.slice(4, 6);
	const dy = clean.slice(6, 8);
	const hr = clean.slice(9, 11) || "00";
	const mn = clean.slice(11, 13) || "00";
	const sc = clean.slice(13, 15) || "00";
	const iso = `${yr}-${mo}-${dy}T${hr}:${mn}:${sc}${isUtc ? "Z" : ""}`;
	return new Date(iso);
}

/** Parse iCalendar duration string (e.g. "PT1H30M") to total seconds */
export function parseDuration(s: string): number {
	const m = s.match(/^(-?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
	if (!m) return 0;
	const sign = m[1] === "-" ? -1 : 1;
	const weeks = parseInt(m[2] ?? "0") * 7 * 86400;
	const days = parseInt(m[3] ?? "0") * 86400;
	const hours = parseInt(m[4] ?? "0") * 3600;
	const mins = parseInt(m[5] ?? "0") * 60;
	const secs = parseInt(m[6] ?? "0");
	return sign * (weeks + days + hours + mins + secs);
}
