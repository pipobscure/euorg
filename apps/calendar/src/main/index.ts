/**
 * Calendar app main process entry point.
 *
 * Defines the full CalDAV RPC schema, handles all bun-side request handlers,
 * and sets up the BrowserWindow.
 */

import { BrowserView, BrowserWindow, type ElectrobunRPCSchema, type RPCSchema } from "electrobun/bun";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Temporal } from "@js-temporal/polyfill";

import {
	readAccounts,
	writeAccounts,
	getAccount,
	upsertAccount,
	removeAccount,
	allEnabledCalendars,
	type EuorgAccount,
	type CalDavCalendar,
} from "@euorg/shared/euorg-accounts.ts";
import { getKeystoreType, setKeystoreType, type KeystoreType } from "@euorg/shared/keystore.ts";

import { CalendarDB } from "./db.ts";
import { readICS } from "./db.ts";
import { parseICS, serializeICS, generateUID, type ICalEvent } from "./ics.ts";
import { getInstancesInRange, getEventDetail, type EventInstance } from "./instances.ts";
import {
	syncAll,
	writeCreate,
	writeUpdate,
	writeDelete,
	writeReschedule,
	rediscoverCalendars,
	type RecurringEditScope,
	type SyncProgress,
	type SyncResult,
} from "./sync.ts";
import { testConnection } from "./caldav.ts";
import { sendInvitation, testSmtp } from "./smtp.ts";

// ── Config helpers ────────────────────────────────────────────────────────────

const EUORG_CONFIG_PATH = join(homedir(), ".euorg", "config.json");

function readConfig(): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(EUORG_CONFIG_PATH, "utf8"));
	} catch {
		return {};
	}
}

function getDisplayTimezone(): string {
	const cfg = readConfig();
	return (cfg.calendarDisplayTz as string) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function saveDisplayTimezone(tzid: string): void {
	mkdirSync(join(homedir(), ".euorg"), { recursive: true });
	const cfg = readConfig();
	writeFileSync(
		EUORG_CONFIG_PATH,
		JSON.stringify({ ...cfg, calendarDisplayTz: tzid }, null, 2) + "\n",
		"utf8",
	);
}

interface CalendarPrefs {
	startOfWeek: "monday" | "sunday" | "locale"; // "locale" = use browser locale (not saved)
	defaultView: "day" | "week" | "month";
	dayStart: number;
	dayEnd: number;
	showWeekNumbers: boolean;
}

function getCalendarPrefs(): CalendarPrefs {
	const cfg = readConfig();
	return {
		// Return "locale" sentinel when not explicitly saved so the view can substitute
		startOfWeek: (cfg.calendarStartOfWeek as "monday" | "sunday") ?? "locale",
		defaultView: (cfg.calendarDefaultView as "day" | "week" | "month") ?? "week",
		dayStart: (cfg.calendarDayStart as number) ?? 7,
		dayEnd: (cfg.calendarDayEnd as number) ?? 22,
		showWeekNumbers: (cfg.calendarShowWeekNumbers as boolean) ?? false,
	};
}

function saveCalendarPrefs(prefs: Partial<CalendarPrefs>): void {
	mkdirSync(join(homedir(), ".euorg"), { recursive: true });
	const cfg = readConfig();
	const updated = { ...cfg };
	if (prefs.startOfWeek !== undefined) {
		if (prefs.startOfWeek === "locale") {
			// Remove the key so the locale default is used on next load
			delete updated.calendarStartOfWeek;
		} else {
			updated.calendarStartOfWeek = prefs.startOfWeek;
		}
	}
	if (prefs.defaultView !== undefined) updated.calendarDefaultView = prefs.defaultView;
	if (prefs.dayStart !== undefined) updated.calendarDayStart = prefs.dayStart;
	if (prefs.dayEnd !== undefined) updated.calendarDayEnd = prefs.dayEnd;
	if (prefs.showWeekNumbers !== undefined) updated.calendarShowWeekNumbers = prefs.showWeekNumbers;
	writeFileSync(
		EUORG_CONFIG_PATH,
		JSON.stringify(updated, null, 2) + "\n",
		"utf8",
	);
}

// ── View types ────────────────────────────────────────────────────────────────

interface AccountView {
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

interface CalendarView {
	id: string;
	accountId: string;
	name: string;
	color: string;
	enabled: boolean;
}

interface EventInput {
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

function toAccountView(a: EuorgAccount): AccountView {
	return {
		id: a.id,
		accountType: a.accountType,
		name: a.name,
		serverUrl: a.serverUrl,
		username: a.username,
		enabled: a.enabled,
		defaultCalendarId: a.caldav?.defaultCalendarId ?? null,
		smtpHost: a.smtp?.host ?? "",
		smtpPort: a.smtp?.port ?? 587,
		smtpSecure: a.smtp?.secure ?? false,
		smtpFromName: a.smtp?.fromName ?? "",
		smtpFromEmail: a.smtp?.fromEmail ?? "",
	};
}

function toCalendarView(cal: CalDavCalendar, accountId: string): CalendarView {
	return { id: cal.id, accountId, name: cal.name, color: cal.color, enabled: cal.enabled };
}

function buildCalendarMap(): Map<string, CalDavCalendar> {
	const cfg = readAccounts();
	const map = new Map<string, CalDavCalendar>();
	for (const { account, calendar } of allEnabledCalendars(cfg)) {
		map.set(calendar.id, calendar);
	}
	return map;
}

// ── RPC Schema ────────────────────────────────────────────────────────────────

interface CalendarRPCSchema extends ElectrobunRPCSchema {
	bun: RPCSchema<{
		requests: {
			getInstances: {
				params: { startISO: string; endISO: string; displayTzid: string };
				response: EventInstance[];
			};
			getEventIcs: { params: { uid: string }; response: string | null };
			getEventDetail: {
				params: { uid: string };
				response: { description: string; location: string } | null;
			};
			createEvent: { params: { input: EventInput }; response: { uid: string } };
			updateEvent: {
				params: { uid: string; input: EventInput; scope: RecurringEditScope; instanceStartISO?: string };
				response: void;
			};
			deleteEvent: {
				params: { uid: string; scope: RecurringEditScope; instanceStartISO?: string };
				response: void;
			};
			rescheduleEvent: {
				params: { uid: string; instanceStartISO: string; newStartISO: string; scope: RecurringEditScope };
				response: void;
			};
			getAccounts: { params: void; response: AccountView[] };
			addAccount: {
				params: { name: string; serverUrl: string; username: string; password: string };
				response: AccountView;
			};
			updateAccount: {
				params: { id: string; name?: string; serverUrl?: string; username?: string; password?: string; enabled?: boolean };
				response: AccountView;
			};
			deleteAccount: { params: { id: string }; response: void };
			testAccount: {
				params: { serverUrl: string; username: string; password: string };
				response: { ok: boolean; error?: string };
			};
			addSmtpAccount: {
				params: { name: string; host: string; port: number; secure: boolean; username: string; password: string; fromName: string; fromEmail: string };
				response: AccountView;
			};
			updateSmtpAccount: {
				params: { id: string; name?: string; host?: string; port?: number; secure?: boolean; username?: string; password?: string; fromName?: string; fromEmail?: string };
				response: AccountView;
			};
			testSmtpConfig: { params: { accountId: string }; response: { ok: boolean; error?: string } };
			testSmtpCredentials: {
				/** Test using explicit form values. If password is omitted, loads from keystore via accountId. */
				params: { host: string; port: number; secure: boolean; username: string; password?: string; accountId?: string };
				response: { ok: boolean; error?: string };
			};
			sendInvitation: { params: { uid: string }; response: { ok: boolean; error?: string } };
			getCalendars: { params: { accountId: string }; response: CalendarView[] };
			getAllCalendars: { params: void; response: CalendarView[] };
			rediscoverCalendars: { params: { accountId: string }; response: CalendarView[] };
			setCalendarEnabled: { params: { accountId: string; calendarId: string; enabled: boolean }; response: void };
			setCalendarColor: { params: { accountId: string; calendarId: string; color: string }; response: void };
			setDefaultCalendar: { params: { accountId: string; calendarId: string }; response: void };
			triggerSync: { params: void; response: void };
			importIcs: {
				params: { icsText: string; calendarId: string; accountId: string };
				response: { imported: number; errors: string[] };
			};
			getDisplayTimezone: { params: void; response: string };
			setDisplayTimezone: { params: { tzid: string }; response: void };
			getCalendarPrefs: { params: void; response: CalendarPrefs };
			setCalendarPrefs: { params: Partial<CalendarPrefs>; response: void };
			getKeystoreType: { params: void; response: KeystoreType };
			setKeystoreType: { params: { type: KeystoreType }; response: void };
		};
		messages: {};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			syncProgress: SyncProgress;
			syncComplete: SyncResult;
			eventChanged: { uid: string; action: "created" | "updated" | "deleted" };
			openImport: { icsText: string };
		};
	}>;
}

// ── Database ──────────────────────────────────────────────────────────────────

const db = new CalendarDB();

// ── RPC handlers ──────────────────────────────────────────────────────────────

const rpc = BrowserView.defineRPC<CalendarRPCSchema>({
	maxRequestTime: Infinity,
	handlers: {
		requests: {
			async getInstances({ startISO, endISO, displayTzid }) {
				const calMap = buildCalendarMap();
				const rangeStart = Temporal.PlainDate.from(startISO.slice(0, 10));
				const rangeEnd = Temporal.PlainDate.from(endISO.slice(0, 10));
				return getInstancesInRange(db, calMap, rangeStart, rangeEnd, displayTzid);
			},

			async getEventIcs({ uid }) {
				const row = db.getEvent(uid);
				if (!row) return null;
				return readICS(row.icsPath);
			},

			async getEventDetail({ uid }) {
				const row = db.getEvent(uid);
				if (!row) return null;
				return getEventDetail(row);
			},

			async createEvent({ input }) {
				const cfg = readAccounts();
				let accountId = "";
				for (const a of cfg.accounts) {
					if (a.caldav?.calendars.some((c) => c.id === input.calendarId)) {
						accountId = a.id;
						break;
					}
				}
				if (!accountId) throw new Error(`No account found for calendar ${input.calendarId}`);
				const uid = await writeCreate(db, {
					...input,
					description: input.description,
					location: input.location,
					rrule: input.rrule,
					attendees: input.attendees,
				}, input.calendarId, accountId);
				rpc.send("eventChanged", { uid, action: "created" });
				return { uid };
			},

			async updateEvent({ uid, input, scope, instanceStartISO }) {
				await writeUpdate(db, uid, {
					...input,
					description: input.description,
					location: input.location,
					rrule: input.rrule,
					attendees: input.attendees,
				}, scope, instanceStartISO);
				rpc.send("eventChanged", { uid, action: "updated" });
			},

			async deleteEvent({ uid, scope, instanceStartISO }) {
				await writeDelete(db, uid, scope, instanceStartISO);
				rpc.send("eventChanged", { uid, action: "deleted" });
			},

			async rescheduleEvent({ uid, instanceStartISO, newStartISO, scope }) {
				await writeReschedule(db, uid, instanceStartISO, newStartISO, scope);
				rpc.send("eventChanged", { uid, action: "updated" });
			},

			async getAccounts() {
				// Return dav accounts (that have caldav) + smtp accounts; skip carddav-only accounts
				return readAccounts().accounts
					.filter((a) => a.accountType === "smtp" || a.caldav)
					.map(toAccountView);
			},

			async addAccount({ name, serverUrl, username, password }) {
				const cfg = readAccounts();
				const id = generateUID();
				const account: EuorgAccount = {
					id,
					accountType: "dav",
					name,
					serverUrl,
					username,
					password,
					enabled: true,
					caldav: { homeUrl: null, defaultCalendarId: null, calendars: [] },
				};
				writeAccounts(upsertAccount(cfg, account));
				// Auto-discover calendars
				try { await rediscoverCalendars(id); } catch {}
				return toAccountView(readAccounts().accounts.find((a) => a.id === id) ?? account);
			},

			async updateAccount({ id, name, serverUrl, username, password, enabled }) {
				const cfg = readAccounts();
				const account = getAccount(cfg, id);
				if (!account) throw new Error(`Account ${id} not found`);
				const updated: EuorgAccount = {
					...account,
					name: name ?? account.name,
					serverUrl: serverUrl ?? account.serverUrl,
					username: username ?? account.username,
					password: password ?? account.password,
					enabled: enabled ?? account.enabled,
				};
				writeAccounts(upsertAccount(cfg, updated));
				return toAccountView(updated);
			},

			async deleteAccount({ id }) {
				const cfg = readAccounts();
				const account = getAccount(cfg, id);
				if (account?.accountType === "dav") db.deleteEventsByAccount(id);
				writeAccounts(removeAccount(cfg, id));
			},

			async testAccount({ serverUrl, username, password }) {
				const error = await testConnection({ serverUrl, username, password });
				return error ? { ok: false, error } : { ok: true };
			},

			async addSmtpAccount({ name, host, port, secure, username, password, fromName, fromEmail }) {
				const cfg = readAccounts();
				const id = generateUID();
				const account: EuorgAccount = {
					id,
					accountType: "smtp",
					name,
					serverUrl: "",
					username,
					password,
					enabled: true,
					smtp: { host, port, secure, username, fromName, fromEmail },
				};
				writeAccounts(upsertAccount(cfg, account));
				return toAccountView(account);
			},

			async updateSmtpAccount({ id, name, host, port, secure, username, password, fromName, fromEmail }) {
				const cfg = readAccounts();
				const account = getAccount(cfg, id);
				if (!account || account.accountType !== "smtp") throw new Error(`SMTP account ${id} not found`);
				const updated: EuorgAccount = {
					...account,
					name: name ?? account.name,
					username: username ?? account.username,
					password: password ?? account.password,
					smtp: {
						host: host ?? account.smtp!.host,
						port: port ?? account.smtp!.port,
						secure: secure ?? account.smtp!.secure,
						username: username ?? account.smtp!.username,
						fromName: fromName ?? account.smtp!.fromName,
						fromEmail: fromEmail ?? account.smtp!.fromEmail,
					},
				};
				writeAccounts(upsertAccount(cfg, updated));
				return toAccountView(updated);
			},

			async testSmtpConfig({ accountId }) {
				const cfg = readAccounts();
				const account = getAccount(cfg, accountId);
				if (!account?.smtp) return { ok: false, error: "SMTP not configured" };
				const error = await testSmtp({ ...account.smtp, password: account.password });
				return error ? { ok: false, error } : { ok: true };
			},

			async testSmtpCredentials({ host, port, secure, username, password, accountId }) {
				let resolvedPassword = password ?? "";
				if (!resolvedPassword && accountId) {
					const cfg = readAccounts();
					resolvedPassword = getAccount(cfg, accountId)?.password ?? "";
				}
				if (!resolvedPassword) return { ok: false, error: "No password provided" };
				const error = await testSmtp({
					host, port, secure, username, password: resolvedPassword,
					fromName: "", fromEmail: "",
				});
				return error ? { ok: false, error } : { ok: true };
			},

			async sendInvitation({ uid }) {
				const row = db.getEvent(uid);
				if (!row) return { ok: false, error: "Event not found" };
				const cfg = readAccounts();
				// Use first enabled smtp account
				const smtpAccount = cfg.accounts.find((a) => a.accountType === "smtp" && a.enabled && a.smtp);
				if (!smtpAccount?.smtp) return { ok: false, error: "No SMTP account configured" };
				const icsText = readICS(row.icsPath);
				if (!icsText) return { ok: false, error: "Cannot read event ICS" };
				const parsed = parseICS(icsText);
				const event = parsed.events[0];
				if (!event) return { ok: false, error: "Cannot parse event" };
				try {
					await sendInvitation({ ...smtpAccount.smtp, password: smtpAccount.password }, event, smtpAccount.name);
					return { ok: true };
				} catch (e) {
					return { ok: false, error: e instanceof Error ? e.message : String(e) };
				}
			},

			async getCalendars({ accountId }) {
				const cfg = readAccounts();
				const account = getAccount(cfg, accountId);
				if (!account) return [];
				return (account.caldav?.calendars ?? []).map((c) => toCalendarView(c, accountId));
			},

			async getAllCalendars() {
				const cfg = readAccounts();
				const result: CalendarView[] = [];
				for (const a of cfg.accounts) {
					for (const c of a.caldav?.calendars ?? []) {
						result.push(toCalendarView(c, a.id));
					}
				}
				return result;
			},

			async rediscoverCalendars({ accountId }) {
				const calendars = await rediscoverCalendars(accountId);
				return calendars.map((c) => toCalendarView(c, accountId));
			},

			async setCalendarEnabled({ accountId, calendarId, enabled }) {
				const cfg = readAccounts();
				const account = getAccount(cfg, accountId);
				if (!account?.caldav) return;
				account.caldav.calendars = account.caldav.calendars.map((c) =>
					c.id === calendarId ? { ...c, enabled } : c,
				);
				writeAccounts(upsertAccount(cfg, account));
			},

			async setCalendarColor({ accountId, calendarId, color }) {
				const cfg = readAccounts();
				const account = getAccount(cfg, accountId);
				if (!account?.caldav) return;
				account.caldav.calendars = account.caldav.calendars.map((c) =>
					c.id === calendarId ? { ...c, color } : c,
				);
				writeAccounts(upsertAccount(cfg, account));
			},

			async setDefaultCalendar({ accountId, calendarId }) {
				const cfg = readAccounts();
				const account = getAccount(cfg, accountId);
				if (!account?.caldav) return;
				account.caldav.defaultCalendarId = calendarId;
				writeAccounts(upsertAccount(cfg, account));
			},

			async triggerSync() {
				syncAll(
					db,
					(progress) => rpc.send("syncProgress", progress),
					() => rpc.send("eventChanged", { uid: "", action: "updated" }),
				)
					.then((result) => rpc.send("syncComplete", result))
					.catch((e) => {
						rpc.send("syncComplete", {
							added: 0, updated: 0, deleted: 0,
							errors: [e instanceof Error ? e.message : String(e)],
						});
					});
			},

			async importIcs({ icsText, calendarId, accountId }) {
				const parsed = parseICS(icsText);
				let imported = 0;
				const errors: string[] = [];
				for (const event of parsed.events) {
					try {
						const existing = db.getEvent(event.uid);
						if (existing) { errors.push(`Skipped duplicate UID: ${event.uid}`); continue; }
						await writeCreate(db, {
							uid: event.uid,
							summary: event.summary,
							description: event.description,
							location: event.location,
							startISO: event.dtstart,
							endISO: event.dtend ?? event.dtstart,
							isAllDay: event.dtstartIsDate,
							tzid: event.dtstartTzid ?? undefined,
							rrule: event.rrule ?? undefined,
							calendarId,
						}, calendarId, accountId);
						imported++;
					} catch (e) {
						errors.push(`${event.uid}: ${e instanceof Error ? e.message : String(e)}`);
					}
				}
				return { imported, errors };
			},

			async getDisplayTimezone() { return getDisplayTimezone(); },
			async setDisplayTimezone({ tzid }) { saveDisplayTimezone(tzid); },
			async getCalendarPrefs() { return getCalendarPrefs(); },
			async setCalendarPrefs(prefs) { saveCalendarPrefs(prefs); },
			async getKeystoreType() { return getKeystoreType(); },
			async setKeystoreType({ type }) { setKeystoreType(type); },
		},
		messages: {},
	},
});

// ── Window ────────────────────────────────────────────────────────────────────

const win = new BrowserWindow({
	title: "Calendar",
	url: "views://calendar/index.html",
	frame: { width: 1200, height: 820, x: 80, y: 80 },
	rpc,
});

// ── ICS file association ──────────────────────────────────────────────────────

const icsArg = process.argv.find((a) => a.endsWith(".ics") && !a.startsWith("-"));
if (icsArg) {
	try {
		const icsText = readFileSync(icsArg, "utf8");
		setTimeout(() => rpc.send("openImport", { icsText }), 1500);
	} catch (e) {
		console.error("[calendar] Failed to read ICS file:", e);
	}
}

// Startup sync is triggered by the webview via triggerSync after onMount,
// ensuring the RPC connection is established before sync messages are sent.
