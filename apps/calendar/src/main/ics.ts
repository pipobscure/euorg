/**
 * ICS (iCalendar, RFC 5545) parser and serializer.
 *
 * Supports: VCALENDAR, VEVENT, VTIMEZONE components.
 * Handles RRULE, EXDATE, RDATE, RECURRENCE-ID, attendees, organizer.
 *
 * Only import from Bun (main-process) code.
 */

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
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/** Unfold RFC 5545 lines (CRLF + whitespace continuation → single line) */
function unfoldLines(text: string): string {
	// Normalize CRLF → LF, then CR → LF, then unfold
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}

/** Parse a single content-line into { name, params, value } */
function parseLine(line: string): { name: string; params: Record<string, string>; value: string } {
	const colonIdx = line.indexOf(":");
	if (colonIdx === -1) return { name: line.toUpperCase(), params: {}, value: "" };

	const left = line.slice(0, colonIdx);
	const value = line.slice(colonIdx + 1);

	const parts = splitParams(left);
	const name = parts[0].toUpperCase();
	const params: Record<string, string> = {};
	for (let i = 1; i < parts.length; i++) {
		const eq = parts[i].indexOf("=");
		if (eq === -1) continue;
		const k = parts[i].slice(0, eq).toUpperCase();
		// Strip surrounding quotes from param values
		let v = parts[i].slice(eq + 1);
		if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
		params[k] = v;
	}
	return { name, params, value };
}

/** Split "PROPNAME;PARAM1=V1;PARAM2=V2" respecting quoted strings */
function splitParams(s: string): string[] {
	const parts: string[] = [];
	let cur = "";
	let inQuote = false;
	for (const ch of s) {
		if (ch === '"') {
			inQuote = !inQuote;
			cur += ch;
		} else if (ch === ";" && !inQuote) {
			parts.push(cur);
			cur = "";
		} else {
			cur += ch;
		}
	}
	parts.push(cur);
	return parts;
}

/** Decode iCalendar text escapes (\n → newline, \\ → \, \; → ;, \, → ,) */
function decodeText(s: string): string {
	return s.replace(/\\n/gi, "\n").replace(/\\;/g, ";").replace(/\\,/g, ",").replace(/\\\\/g, "\\");
}

/** Extract component blocks between BEGIN:X and END:X */
function extractBlocks(lines: string[], componentName: string): string[][] {
	const blocks: string[][] = [];
	let depth = 0;
	let current: string[] | null = null;
	for (const line of lines) {
		if (line === `BEGIN:${componentName}`) {
			if (depth === 0) current = [];
			depth++;
		}
		if (current !== null) current.push(line);
		if (line === `END:${componentName}`) {
			depth--;
			if (depth === 0 && current !== null) {
				blocks.push(current);
				current = null;
			}
		}
	}
	return blocks;
}

function parseVEvent(lines: string[]): ICalEvent {
	const raw = lines.join("\r\n");
	const event: ICalEvent = {
		uid: "",
		summary: "",
		description: "",
		location: "",
		dtstart: "",
		dtstartTzid: null,
		dtstartIsDate: false,
		dtend: null,
		dtendTzid: null,
		duration: null,
		rrule: null,
		exdate: [],
		rdate: [],
		recurrenceId: null,
		recurrenceIdTzid: null,
		status: "",
		transp: "OPAQUE",
		organizer: "",
		attendees: [],
		sequence: 0,
		created: "",
		lastModified: "",
		raw,
	};

	// Skip BEGIN/END lines
	const content = lines.slice(1, -1);

	for (const line of content) {
		if (!line.trim()) continue;
		const { name, params, value } = parseLine(line);

		switch (name) {
			case "UID":
				event.uid = value;
				break;
			case "SUMMARY":
				event.summary = decodeText(value);
				break;
			case "DESCRIPTION":
				event.description = decodeText(value);
				break;
			case "LOCATION":
				event.location = decodeText(value);
				break;
			case "DTSTART":
				event.dtstart = value;
				event.dtstartTzid = params.TZID ?? null;
				event.dtstartIsDate = params.VALUE === "DATE";
				break;
			case "DTEND":
				event.dtend = value;
				event.dtendTzid = params.TZID ?? null;
				break;
			case "DURATION":
				event.duration = value;
				break;
			case "RRULE":
				event.rrule = value;
				break;
			case "EXDATE": {
				// May have multiple values separated by commas
				const vals = value.split(",").map((v) => v.trim()).filter(Boolean);
				event.exdate.push(...vals);
				break;
			}
			case "RDATE": {
				const vals = value.split(",").map((v) => v.trim()).filter(Boolean);
				event.rdate.push(...vals);
				break;
			}
			case "RECURRENCE-ID":
				event.recurrenceId = value;
				event.recurrenceIdTzid = params.TZID ?? null;
				break;
			case "STATUS":
				event.status = value as ICalEvent["status"];
				break;
			case "TRANSP":
				event.transp = value === "TRANSPARENT" ? "TRANSPARENT" : "OPAQUE";
				break;
			case "ORGANIZER":
				event.organizer = value.replace(/^mailto:/i, "");
				break;
			case "ATTENDEE":
				event.attendees.push({
					email: value.replace(/^mailto:/i, ""),
					cn: params.CN ?? "",
					partstat: params.PARTSTAT ?? "NEEDS-ACTION",
					role: params.ROLE ?? "REQ-PARTICIPANT",
					rsvp: (params.RSVP ?? "").toUpperCase() === "TRUE",
				});
				break;
			case "SEQUENCE":
				event.sequence = parseInt(value, 10) || 0;
				break;
			case "CREATED":
				event.created = value;
				break;
			case "LAST-MODIFIED":
				event.lastModified = value;
				break;
		}
	}

	return event;
}

/**
 * Parse a full VCALENDAR text into an ICalObject.
 * Gracefully ignores unknown components.
 */
export function parseICS(text: string): ICalObject {
	const unfolded = unfoldLines(text);
	const lines = unfolded.split("\n").map((l) => l.trimEnd());

	const obj: ICalObject = {
		prodid: "",
		version: "2.0",
		calscale: "GREGORIAN",
		method: null,
		events: [],
		timezones: [],
	};

	// Parse top-level VCALENDAR properties
	let inVCalendar = false;
	for (const line of lines) {
		if (line === "BEGIN:VCALENDAR") { inVCalendar = true; continue; }
		if (line === "END:VCALENDAR") { inVCalendar = false; continue; }
		if (!inVCalendar || line.startsWith("BEGIN:") || line.startsWith("END:")) continue;
		const { name, value } = parseLine(line);
		if (name === "PRODID") obj.prodid = value;
		else if (name === "VERSION") obj.version = value;
		else if (name === "CALSCALE") obj.calscale = value;
		else if (name === "METHOD") obj.method = value;
	}

	// Extract VEVENT blocks
	const veventBlocks = extractBlocks(lines, "VEVENT");
	for (const block of veventBlocks) {
		const event = parseVEvent(block);
		if (event.uid) obj.events.push(event);
	}

	// Extract raw VTIMEZONE blocks (preserve verbatim)
	const tzBlocks = extractBlocks(lines, "VTIMEZONE");
	for (const block of tzBlocks) {
		obj.timezones.push(block.join("\r\n"));
	}

	return obj;
}

// ── Serialization ─────────────────────────────────────────────────────────────

/** Fold a content line to 75 octets per RFC 5545 */
function foldLine(line: string): string {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(line);
	if (bytes.length <= 75) return line;

	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let offset = 0;
	let isFirst = true;
	while (offset < bytes.length) {
		const limit = isFirst ? 75 : 74; // continuation lines start with a space
		let end = offset + limit;
		// Don't split in the middle of a multi-byte UTF-8 sequence
		while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
		chunks.push((isFirst ? "" : " ") + decoder.decode(bytes.slice(offset, end)));
		offset = end;
		isFirst = false;
	}
	return chunks.join("\r\n");
}

/** Encode text for ICS property values */
function encodeText(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** Format a Date/ISO string to iCalendar datetime format */
function formatDateTime(iso: string, isDate: boolean, tzid?: string): string {
	if (isDate) {
		// VALUE=DATE: YYYYMMDD
		return iso.replace(/-/g, "").slice(0, 8);
	}
	// Parse ISO to iCal format YYYYMMDDTHHMMSS[Z]
	const d = new Date(iso);
	if (isNaN(d.getTime())) {
		// Already in iCal format
		return iso;
	}
	if (!tzid || iso.endsWith("Z")) {
		// UTC
		return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
	}
	// Local time with TZID — format without Z
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Generate a new UID */
export function generateUID(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}@euorg`;
}

/** Serialize a VEventInput into a VCALENDAR ICS string */
export function serializeICS(input: VEventInput, existingEvents?: ICalEvent[]): string {
	const uid = input.uid ?? generateUID();
	const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

	const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//euorg//Calendar//EN", "CALSCALE:GREGORIAN"];

	if (input.method) lines.push(`METHOD:${input.method}`);

	lines.push("BEGIN:VEVENT");
	lines.push(`UID:${uid}`);
	lines.push(`DTSTAMP:${now}`);
	lines.push(`CREATED:${now}`);
	lines.push(`LAST-MODIFIED:${now}`);
	lines.push(`SEQUENCE:${input.sequence ?? 0}`);
	lines.push(`SUMMARY:${encodeText(input.summary)}`);

	if (input.description) lines.push(`DESCRIPTION:${encodeText(input.description)}`);
	if (input.location) lines.push(`LOCATION:${encodeText(input.location)}`);

	if (input.isAllDay) {
		const startDate = formatDateTime(input.startISO, true);
		const endDate = formatDateTime(input.endISO, true);
		lines.push(`DTSTART;VALUE=DATE:${startDate}`);
		lines.push(`DTEND;VALUE=DATE:${endDate}`);
	} else if (input.tzid) {
		const start = formatDateTime(input.startISO, false, input.tzid);
		const end = formatDateTime(input.endISO, false, input.tzid);
		lines.push(`DTSTART;TZID=${input.tzid}:${start}`);
		lines.push(`DTEND;TZID=${input.tzid}:${end}`);
	} else {
		// UTC
		lines.push(`DTSTART:${formatDateTime(input.startISO, false)}`);
		lines.push(`DTEND:${formatDateTime(input.endISO, false)}`);
	}

	if (input.rrule) lines.push(`RRULE:${input.rrule}`);

	if (input.organizer) lines.push(`ORGANIZER:mailto:${input.organizer}`);

	for (const att of input.attendees ?? []) {
		const parts = [`ATTENDEE`];
		if (att.cn) parts[0] += `;CN="${att.cn}"`;
		parts[0] += `;ROLE=${att.role ?? "REQ-PARTICIPANT"}`;
		parts[0] += `;RSVP=TRUE`;
		parts[0] += `;PARTSTAT=NEEDS-ACTION`;
		lines.push(`${parts[0]}:mailto:${att.email}`);
	}

	// Carry over existing attendee statuses for REPLY
	for (const att of input.existingAttendees ?? []) {
		let attLine = `ATTENDEE;PARTSTAT=${att.partstat}`;
		if (att.cn) attLine += `;CN="${att.cn}"`;
		attLine += `;ROLE=${att.role}`;
		attLine += `:mailto:${att.email}`;
		lines.push(attLine);
	}

	lines.push("END:VEVENT");
	lines.push("END:VCALENDAR");

	return lines.map(foldLine).join("\r\n") + "\r\n";
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

	const ev = obj.events[idx];
	const input: VEventInput = {
		uid,
		summary: updates.summary ?? ev.summary,
		description: updates.description ?? ev.description,
		location: updates.location ?? ev.location,
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

/**
 * Parse DTSTART/DTEND into a UTC ISO string for DB storage.
 * Returns null for all-day events (store date string as-is).
 */
export function toUtcISO(rawValue: string, tzid: string | null, isDate: boolean): string {
	if (isDate) return rawValue.slice(0, 8); // YYYYMMDD → keep as date string

	// Already UTC (ends with Z)
	if (rawValue.endsWith("Z")) {
		return parseICalDateTime(rawValue).toISOString();
	}

	// Has TZID — we store the raw value plus tzid info; caller handles conversion
	// For DB normalization we return a UTC representation by using the TZID if we can
	// For now: return as UTC if no TZID (assume UTC), otherwise return raw for later processing
	if (!tzid) {
		return parseICalDateTime(rawValue).toISOString();
	}
	// Return a placeholder — actual UTC conversion happens in instances.ts using Temporal
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
