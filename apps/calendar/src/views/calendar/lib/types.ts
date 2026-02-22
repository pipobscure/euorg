/**
 * Shared types for the calendar webview.
 * Mirrors main-process structures; kept in sync manually.
 */

export type ViewMode = "day" | "week" | "month";
export type RecurringEditScope = "this" | "thisAndFollowing" | "all";

export interface CalendarPrefs {
	startOfWeek: "monday" | "sunday";
	defaultView: ViewMode;
	dayStart: number; // 0-23, hour the time grid scrolls to on open
	dayEnd: number;   // 0-23, informational (reserved for future use)
	showWeekNumbers: boolean;
}

/** Detect the locale's preferred first day of the week via Intl.Locale.weekInfo. */
export function getLocaleWeekStart(): "monday" | "sunday" {
	try {
		const locale = new Intl.Locale(navigator.language);
		// weekInfo available in modern engines; getWeekInfo() in newer spec drafts
		const info =
			typeof (locale as any).getWeekInfo === "function"
				? (locale as any).getWeekInfo()
				: (locale as any).weekInfo;
		// firstDay: 1 = Monday … 7 = Sunday
		return info?.firstDay === 7 ? "sunday" : "monday";
	} catch {
		return "monday";
	}
}

/** Get the ISO 8601 week number for a given date. Week 1 contains the first Thursday. */
export function getISOWeekNumber(date: Date): number {
	const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
	const dayOfWeek = d.getUTCDay() || 7; // Mon=1 … Sun=7
	d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek); // shift to Thursday of the same week
	const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
	return Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + 1) / 7);
}

export interface EventInstance {
	instanceId: string;
	uid: string;
	calendarId: string;
	accountId: string;
	summary: string;
	description: string;
	location: string;
	organizer: string;
	/** ISO 8601 in display timezone */
	startISO: string;
	endISO: string;
	isAllDay: boolean;
	color: string;
	hasRRule: boolean;
	recurrenceId: string | null;
	etag: string | null;
	href: string;
	icsPath: string;
	status: string;
}

export interface CalendarView {
	id: string;
	accountId: string;
	name: string;
	color: string;
	enabled: boolean;
}

export interface AccountView {
	id: string;
	accountType: "dav" | "smtp";
	name: string;
	serverUrl: string;
	username: string;
	enabled: boolean;
	// dav-only:
	defaultCalendarId: string | null;
	// smtp-only:
	smtpHost: string;
	smtpPort: number;
	smtpSecure: boolean;
	smtpFromName: string;
	smtpFromEmail: string;
}

export interface EventInput {
	uid?: string;
	calendarId: string;
	summary: string;
	description?: string;
	location?: string;
	startISO: string;
	endISO: string;
	isAllDay: boolean;
	tzid?: string;
	rrule?: string;
	attendees?: Array<{ email: string; cn?: string; role?: string }>;
}

export interface SyncProgress {
	phase: "discovering" | "syncing" | "done";
	done: number;
	total: number;
	accountName?: string;
	calendarName?: string;
	eventsDone?: number;
	eventsTotal?: number;
}

export interface SyncResult {
	added: number;
	updated: number;
	deleted: number;
	errors: string[];
}

// ── Date utilities (view-side) ────────────────────────────────────────────────

/** Get the ISO date string (YYYY-MM-DD) for a Date object */
export function toDateStr(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Format a date for display: "February 2026" */
export function formatMonth(d: Date): string {
	return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** Format a date as "Feb 21" */
export function formatShortDate(d: Date): string {
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Format a date as "Feb 21, 2026" */
export function formatLongDate(d: Date): string {
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Get Monday on or before a given date */
export function getMondayOf(d: Date): Date {
	const day = d.getDay(); // 0=Sun, 1=Mon, ...
	const diff = (day === 0 ? -6 : 1 - day);
	const monday = new Date(d);
	monday.setDate(d.getDate() + diff);
	monday.setHours(0, 0, 0, 0);
	return monday;
}

/** Get the start of the week (Mon or Sun) on or before a given date */
export function getWeekStart(d: Date, startOfWeek: "monday" | "sunday" = "monday"): Date {
	const day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
	const diff = startOfWeek === "monday" ? (day === 0 ? -6 : 1 - day) : -day;
	const result = new Date(d);
	result.setDate(d.getDate() + diff);
	result.setHours(0, 0, 0, 0);
	return result;
}

/** Get the first day of a given month */
export function getFirstOfMonth(year: number, month: number): Date {
	return new Date(year, month, 1);
}

/** Add days to a date */
export function addDays(d: Date, n: number): Date {
	const result = new Date(d);
	result.setDate(d.getDate() + n);
	return result;
}

/** Add weeks to a date */
export function addWeeks(d: Date, n: number): Date {
	return addDays(d, n * 7);
}

/** Add months to a date */
export function addMonths(d: Date, n: number): Date {
	const result = new Date(d);
	result.setMonth(d.getMonth() + n);
	return result;
}

/** Get start of day */
export function startOfDay(d: Date): Date {
	const result = new Date(d);
	result.setHours(0, 0, 0, 0);
	return result;
}

/**
 * Parse an ISO datetime string to a Date.
 * Handles both date-only (YYYY-MM-DD) and full datetime.
 */
export function parseISO(s: string): Date {
	if (s.length === 10) {
		// Date-only: treat as local midnight
		const [y, m, d] = s.split("-").map(Number);
		return new Date(y, m - 1, d);
	}
	// Strip Temporal bracket annotation "[TZID]" if present — new Date() can't parse it
	return new Date(s.replace(/\[.*\]$/, ""));
}

/** Get minutes from midnight for a datetime string */
export function minutesFromMidnight(s: string): number {
	const d = parseISO(s);
	return d.getHours() * 60 + d.getMinutes();
}

/** Format time as "09:30" */
export function formatTime(s: string): string {
	const d = parseISO(s);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Format event time range: "9:00 – 10:30" */
export function formatTimeRange(startISO: string, endISO: string): string {
	return `${formatTime(startISO)} – ${formatTime(endISO)}`;
}

/** Get date string of an ISO datetime */
export function getDateOf(s: string): string {
	if (s.length === 10) return s;
	return s.slice(0, 10);
}

/** Check if a date string falls within [startISO, endISO) */
export function isInDateRange(dateStr: string, startISO: string, endISO: string): boolean {
	return dateStr >= startISO.slice(0, 10) && dateStr < endISO.slice(0, 10);
}

/** Get an event's duration in minutes */
export function eventDurationMinutes(instance: EventInstance): number {
	const start = parseISO(instance.startISO);
	const end = parseISO(instance.endISO);
	return Math.max(30, (end.getTime() - start.getTime()) / 60_000);
}

/** IANA timezone list (common ones first) */
export const COMMON_TIMEZONES = [
	"UTC",
	"America/New_York",
	"America/Chicago",
	"America/Denver",
	"America/Los_Angeles",
	"America/Sao_Paulo",
	"Europe/London",
	"Europe/Paris",
	"Europe/Berlin",
	"Europe/Rome",
	"Europe/Helsinki",
	"Europe/Moscow",
	"Asia/Jerusalem",
	"Asia/Dubai",
	"Asia/Kolkata",
	"Asia/Bangkok",
	"Asia/Shanghai",
	"Asia/Tokyo",
	"Asia/Seoul",
	"Australia/Sydney",
	"Pacific/Auckland",
];
