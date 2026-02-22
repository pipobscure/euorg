/**
 * RRULE expansion engine using Temporal API.
 *
 * Supports: FREQ (DAILY/WEEKLY/MONTHLY/YEARLY), INTERVAL, COUNT, UNTIL,
 * BYDAY (with ordinal prefix e.g. -1FR), BYMONTHDAY, BYMONTH, WKST.
 *
 * All arithmetic via ZonedDateTime.add() to correctly handle DST transitions.
 * CRITICAL: Never use toInstant().add(seconds) for calendar-based advancement.
 *
 * Named import used (NOT side-effect import) to avoid globalThis patching issues.
 */

import { Temporal } from "@js-temporal/polyfill";

// ── Types ─────────────────────────────────────────────────────────────────────

const DAY_NAMES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
type DayName = (typeof DAY_NAMES)[number];

// Day of week index: SU=0, MO=1, TU=2, WE=3, TH=4, FR=5, SA=6
const DAY_INDEX: Record<DayName, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

interface ParsedByday {
	ordinal: number | null; // null = every occurrence; 1 = first, -1 = last, etc.
	day: DayName;
}

interface ParsedRRule {
	freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
	interval: number;
	count: number | null;
	until: Temporal.ZonedDateTime | Temporal.PlainDate | null;
	byday: ParsedByday[];
	bymonthday: number[];
	bymonth: number[];
	wkst: DayName;
}

// ── Parser ────────────────────────────────────────────────────────────────────

function parseRRule(rruleStr: string, dtstartTzid: string): ParsedRRule {
	const parts: Record<string, string> = {};
	for (const part of rruleStr.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		parts[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
	}

	const freq = (parts.FREQ ?? "DAILY").toUpperCase() as ParsedRRule["freq"];
	const interval = parseInt(parts.INTERVAL ?? "1", 10) || 1;
	const count = parts.COUNT ? parseInt(parts.COUNT, 10) : null;

	let until: ParsedRRule["until"] = null;
	if (parts.UNTIL) {
		const u = parts.UNTIL;
		if (u.length === 8) {
			// DATE: YYYYMMDD
			until = Temporal.PlainDate.from(`${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`);
		} else {
			// DATETIME
			const iso = parseICalToISO(u, dtstartTzid);
			until = Temporal.ZonedDateTime.from(iso);
		}
	}

	const byday: ParsedByday[] = [];
	if (parts.BYDAY) {
		for (const spec of parts.BYDAY.split(",")) {
			const m = spec.trim().match(/^(-?\d+)?([A-Z]{2})$/i);
			if (!m) continue;
			byday.push({
				ordinal: m[1] ? parseInt(m[1], 10) : null,
				day: m[2].toUpperCase() as DayName,
			});
		}
	}

	const bymonthday = (parts.BYMONTHDAY ?? "")
		.split(",")
		.filter(Boolean)
		.map((v) => parseInt(v, 10));

	const bymonth = (parts.BYMONTH ?? "")
		.split(",")
		.filter(Boolean)
		.map((v) => parseInt(v, 10));

	const wkst = ((parts.WKST ?? "MO").toUpperCase() as DayName) ?? "MO";

	return { freq, interval, count, until, byday, bymonthday, bymonth, wkst };
}

/** Convert iCal datetime string to ISO with timezone */
function parseICalToISO(s: string, tzid: string): string {
	const isUtc = s.endsWith("Z");
	const clean = s.replace("Z", "");
	const yr = clean.slice(0, 4);
	const mo = clean.slice(4, 6);
	const dy = clean.slice(6, 8);
	const hr = clean.slice(9, 11) || clean.slice(8, 10) || "00";
	const mn = clean.slice(11, 13) || clean.slice(10, 12) || "00";
	const sc = clean.slice(13, 15) || clean.slice(12, 14) || "00";
	const timepart = `T${hr}:${mn}:${sc}`;
	if (isUtc) return `${yr}-${mo}-${dy}${timepart}[UTC]`;
	return `${yr}-${mo}-${dy}${timepart}[${tzid}]`;
}

// ── BYDAY matching ────────────────────────────────────────────────────────────

/** Temporal day-of-week mapping: 1=Monday … 7=Sunday */
const TEMPORAL_DOW: Record<DayName, number> = {
	MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7,
};

function dayOfWeekMatches(zdt: Temporal.ZonedDateTime, specs: ParsedByday[]): boolean {
	if (specs.length === 0) return true;
	const dow = zdt.dayOfWeek; // 1=Mon ... 7=Sun
	return specs.some((s) => {
		if (TEMPORAL_DOW[s.day] !== dow) return false;
		if (s.ordinal === null) return true;
		// Ordinal: e.g. 1MO = first Monday, -1FR = last Friday
		if (s.ordinal > 0) {
			// nth occurrence in month: day must be in the right week
			const firstOfMonth = zdt.with({ day: 1 });
			const firstOccurrence = firstOfMonth.add({
				days: ((TEMPORAL_DOW[s.day] - firstOfMonth.dayOfWeek + 7) % 7),
			});
			const nthDay = firstOccurrence.add({ weeks: s.ordinal - 1 });
			return zdt.day === nthDay.day;
		} else {
			// Negative ordinal: nth from end
			const daysInMonth = zdt.daysInMonth;
			const lastOfMonth = zdt.with({ day: daysInMonth });
			const lastOccurrence = lastOfMonth.subtract({
				days: ((lastOfMonth.dayOfWeek - TEMPORAL_DOW[s.day] + 7) % 7),
			});
			const nthFromEnd = lastOccurrence.subtract({ weeks: Math.abs(s.ordinal) - 1 });
			return zdt.day === nthFromEnd.day;
		}
	});
}

function monthDayMatches(zdt: Temporal.ZonedDateTime, bymonthday: number[]): boolean {
	if (bymonthday.length === 0) return true;
	const day = zdt.day;
	const daysInMonth = zdt.daysInMonth;
	return bymonthday.some((d) => {
		if (d > 0) return day === d;
		return day === daysInMonth + d + 1; // negative: from end
	});
}

function monthMatches(zdt: Temporal.ZonedDateTime, bymonth: number[]): boolean {
	if (bymonth.length === 0) return true;
	return bymonth.includes(zdt.month);
}

// ── EXDATE matching ───────────────────────────────────────────────────────────

/** Normalize an exdate string to a comparable key */
function normalizeExdate(s: string, tzid: string): string {
	// Strip timezone param syntax, normalize to date or UTC datetime
	const clean = s.replace("Z", "").replace(/:/g, "").replace(/-/g, "");
	if (clean.length === 8) return clean; // date
	return clean.slice(0, 8) + "T" + clean.slice(9, 15);
}

function zdtToExdateKey(zdt: Temporal.ZonedDateTime): string {
	const p = zdt.toPlainDateTime();
	const pad = (n: number, len = 2) => String(n).padStart(len, "0");
	return (
		`${pad(p.year, 4)}${pad(p.month)}${pad(p.day)}` +
		`T${pad(p.hour)}${pad(p.minute)}${pad(p.second)}`
	);
}

function plainDateToExdateKey(pd: Temporal.PlainDate): string {
	const pad = (n: number, len = 2) => String(n).padStart(len, "0");
	return `${pad(pd.year, 4)}${pad(pd.month)}${pad(pd.day)}`;
}

// ── Main Expansion Function ───────────────────────────────────────────────────

/**
 * Expand a recurring event's RRULE into concrete ZonedDateTime instances
 * within [rangeStart, rangeEnd].
 *
 * @param rruleStr - Raw RRULE value string from ICS
 * @param dtstart  - Event's DTSTART as ZonedDateTime or PlainDate
 * @param rangeStart - Inclusive range start (PlainDate in display timezone)
 * @param rangeEnd   - Exclusive range end (PlainDate)
 * @param rawExdates - Raw EXDATE strings from ICS
 * @param tzid       - TZID of the event (for RRULE parsing and expansion)
 */
export function expandRRule(
	rruleStr: string,
	dtstart: Temporal.ZonedDateTime | Temporal.PlainDate,
	rangeStart: Temporal.PlainDate,
	rangeEnd: Temporal.PlainDate,
	rawExdates: string[],
	tzid: string,
): Temporal.ZonedDateTime[] {
	const rule = parseRRule(rruleStr, tzid);
	const results: Temporal.ZonedDateTime[] = [];

	// Build exdate set for O(1) lookup
	const exdateKeys = new Set<string>(rawExdates.map((e) => normalizeExdate(e, tzid)));

	// Convert dtstart to ZonedDateTime
	let cursor: Temporal.ZonedDateTime;
	if (dtstart instanceof Temporal.PlainDate) {
		cursor = dtstart.toZonedDateTime({ timeZone: tzid, plainTime: Temporal.PlainTime.from("00:00:00") });
	} else {
		cursor = dtstart;
	}

	let count = 0;
	const maxIterations = 10000; // safety limit
	let iterations = 0;

	// For WEEKLY with BYDAY, we iterate day-by-day within a week window
	if (rule.freq === "WEEKLY" && rule.byday.length > 0) {
		return expandWeekly(cursor, rule, rangeStart, rangeEnd, exdateKeys, tzid);
	}

	while (iterations++ < maxIterations) {
		// Check UNTIL
		if (rule.until) {
			if (rule.until instanceof Temporal.PlainDate) {
				if (Temporal.PlainDate.compare(cursor.toPlainDate(), rule.until) > 0) break;
			} else {
				if (Temporal.ZonedDateTime.compare(cursor, rule.until) > 0) break;
			}
		}

		// Check COUNT
		if (rule.count !== null && count >= rule.count) break;

		// Check if cursor matches all BY* constraints
		const matches =
			dayOfWeekMatches(cursor, rule.byday) &&
			monthDayMatches(cursor, rule.bymonthday) &&
			monthMatches(cursor, rule.bymonth);

		if (matches) {
			const key = zdtToExdateKey(cursor);
			const inRange =
				Temporal.PlainDate.compare(cursor.toPlainDate(), rangeStart) >= 0 &&
				Temporal.PlainDate.compare(cursor.toPlainDate(), rangeEnd) < 0;

			if (!exdateKeys.has(key)) {
				count++;
				if (inRange) results.push(cursor);
			}

			// If past rangeEnd and no COUNT/UNTIL remaining, we could break early
			// but only if this event can't wrap around (MONTHLY/YEARLY with BYMONTH)
			if (Temporal.PlainDate.compare(cursor.toPlainDate(), rangeEnd) >= 0 && rule.count === null && !rule.until) {
				break;
			}
		}

		// Advance cursor by FREQ × INTERVAL
		cursor = advanceCursor(cursor, rule);
	}

	return results;
}

/** Expand WEEKLY rules (with BYDAY listing specific days in the week) */
function expandWeekly(
	dtstart: Temporal.ZonedDateTime,
	rule: ParsedRRule,
	rangeStart: Temporal.PlainDate,
	rangeEnd: Temporal.PlainDate,
	exdateKeys: Set<string>,
	tzid: string,
): Temporal.ZonedDateTime[] {
	const results: Temporal.ZonedDateTime[] = [];
	let count = 0;
	const maxIterations = 10000;
	let iterations = 0;

	// Sort byday by day index per wkst
	const wkstIdx = DAY_INDEX[rule.wkst];
	const sortedByday = [...rule.byday].sort((a, b) => {
		const ai = (DAY_INDEX[a.day] - wkstIdx + 7) % 7;
		const bi = (DAY_INDEX[b.day] - wkstIdx + 7) % 7;
		return ai - bi;
	});

	// Find the start of the week containing dtstart
	const dtstartDow = dtstart.dayOfWeek; // 1=Mon...7=Sun
	const wkstDow = TEMPORAL_DOW[rule.wkst];
	const daysToWeekStart = ((dtstartDow - wkstDow + 7) % 7);
	let weekStart = dtstart.subtract({ days: daysToWeekStart });

	while (iterations++ < maxIterations) {
		// Check if we've gone too far
		if (rule.until) {
			if (rule.until instanceof Temporal.PlainDate) {
				if (Temporal.PlainDate.compare(weekStart.toPlainDate(), rule.until) > 0) break;
			} else {
				if (Temporal.ZonedDateTime.compare(weekStart, rule.until) > 0) break;
			}
		}
		if (Temporal.PlainDate.compare(weekStart.toPlainDate(), rangeEnd) >= 0) break;

		for (const spec of sortedByday) {
			if (rule.count !== null && count >= rule.count) break;

			// Compute candidate day within this week
			const targetDow = TEMPORAL_DOW[spec.day]; // 1=Mon...7=Sun
			const offset = ((targetDow - wkstDow + 7) % 7);
			const candidate = weekStart.add({ days: offset }).with({
				hour: dtstart.hour,
				minute: dtstart.minute,
				second: dtstart.second,
			});

			// Candidate must be on or after dtstart
			if (Temporal.ZonedDateTime.compare(candidate, dtstart) < 0) continue;

			// Check UNTIL
			if (rule.until) {
				if (rule.until instanceof Temporal.PlainDate) {
					if (Temporal.PlainDate.compare(candidate.toPlainDate(), rule.until) > 0) continue;
				} else {
					if (Temporal.ZonedDateTime.compare(candidate, rule.until) > 0) continue;
				}
			}

			const key = zdtToExdateKey(candidate);
			const inRange =
				Temporal.PlainDate.compare(candidate.toPlainDate(), rangeStart) >= 0 &&
				Temporal.PlainDate.compare(candidate.toPlainDate(), rangeEnd) < 0;

			if (!exdateKeys.has(key)) {
				count++;
				if (inRange) results.push(candidate);
			}
		}

		if (rule.count !== null && count >= rule.count) break;

		// Advance to next week occurrence
		weekStart = weekStart.add({ weeks: rule.interval });
	}

	return results;
}

function advanceCursor(
	cursor: Temporal.ZonedDateTime,
	rule: ParsedRRule,
): Temporal.ZonedDateTime {
	switch (rule.freq) {
		case "DAILY":
			return cursor.add({ days: rule.interval });
		case "WEEKLY":
			return cursor.add({ weeks: rule.interval });
		case "MONTHLY":
			return cursor.add({ months: rule.interval });
		case "YEARLY":
			return cursor.add({ years: rule.interval });
	}
}

// ── Utility: parse iCal dtstart to Temporal ───────────────────────────────────

/**
 * Parse a raw ICS dtstart string + tzid into a Temporal.ZonedDateTime.
 * Handles: UTC (Z suffix), TZID param, VALUE=DATE (all-day).
 */
export function parseDtstart(
	rawValue: string,
	tzid: string | null,
	isDate: boolean,
): Temporal.ZonedDateTime | Temporal.PlainDate {
	if (isDate) {
		const yr = rawValue.slice(0, 4);
		const mo = rawValue.slice(4, 6);
		const dy = rawValue.slice(6, 8);
		return Temporal.PlainDate.from(`${yr}-${mo}-${dy}`);
	}

	const isUtc = rawValue.endsWith("Z");
	const clean = rawValue.replace("Z", "");
	const yr = clean.slice(0, 4);
	const mo = clean.slice(4, 6);
	const dy = clean.slice(6, 8);
	const hr = clean.slice(9, 11) || clean.slice(8, 10) || "00";
	const mn = clean.slice(11, 13) || clean.slice(10, 12) || "00";
	const sc = clean.slice(13, 15) || clean.slice(12, 14) || "00";
	const iso = `${yr}-${mo}-${dy}T${hr}:${mn}:${sc}`;

	const tz = isUtc ? "UTC" : (tzid ?? "UTC");
	try {
		return Temporal.ZonedDateTime.from(`${iso}[${tz}]`);
	} catch {
		// Fallback: treat as UTC
		return Temporal.ZonedDateTime.from(`${iso}[UTC]`);
	}
}

/**
 * Convert a Temporal.ZonedDateTime to an ISO string in the given display timezone.
 */
export function zdtToDisplayISO(zdt: Temporal.ZonedDateTime, displayTzid: string): string {
	try {
		const inDisplay = zdt.withTimeZone(displayTzid);
		// timeZoneName: "never" omits the [TZID] bracket annotation, keeping only the +HH:MM offset.
		// This produces standard ISO 8601 (e.g. "2026-02-17T12:15:00+00:00") parseable by new Date().
		return inDisplay.toString({ smallestUnit: "second", timeZoneName: "never" });
	} catch {
		return zdt.toInstant().toString(); // fallback: UTC "Z" format
	}
}

/**
 * Convert a Temporal.ZonedDateTime to an ISO string in the given display timezone.
 * Returns HH:MM format.
 */
export function zdtToTimeString(zdt: Temporal.ZonedDateTime, displayTzid: string): string {
	try {
		const inDisplay = zdt.withTimeZone(displayTzid);
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${pad(inDisplay.hour)}:${pad(inDisplay.minute)}`;
	} catch {
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${pad(zdt.hour)}:${pad(zdt.minute)}`;
	}
}
