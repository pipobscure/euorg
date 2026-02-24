/**
 * Calendar app main process entry point.
 *
 * Defines the full CalDAV RPC schema, handles all bun-side request handlers,
 * and sets up the BrowserWindow.
 */

import { BrowserView, BrowserWindow, type ElectrobunRPCSchema, type RPCSchema } from "electrobun/bun";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { Database } from "bun:sqlite";
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
	isNetworkError,
	saveCreateLocally,
	saveUpdateLocally,
	saveDeleteLocally,
	saveRescheduleLocally,
	rediscoverCalendars,
	addCalendarToAccount,
	removeCalendarFromAccount,
	loadIgnoredSyncErrors,
	saveIgnoredSyncErrors,
	type RecurringEditScope,
	type SyncProgress,
	type SyncResult,
	type SyncError,
} from "./sync.ts";
import { testConnection, deleteEvent as caldavDelete } from "./caldav.ts";
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
}

function getCalendarPrefs(): CalendarPrefs {
	const cfg = readConfig();
	return {
		// Return "locale" sentinel when not explicitly saved so the view can substitute
		startOfWeek: (cfg.calendarStartOfWeek as "monday" | "sunday") ?? "locale",
		defaultView: (cfg.calendarDefaultView as "day" | "week" | "month") ?? "week",
		dayStart: (cfg.calendarDayStart as number) ?? 7,
		dayEnd: (cfg.calendarDayEnd as number) ?? 22,
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
	writeFileSync(
		EUORG_CONFIG_PATH,
		JSON.stringify(updated, null, 2) + "\n",
		"utf8",
	);
}

// ── View types ────────────────────────────────────────────────────────────────

interface AccountView {
	id: string;
	accountType: "dav" | "smtp" | "subscription";
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
	/** true for ICS subscription calendars — no write operations allowed */
	readonly: boolean;
}

interface EventInput {
	uid?: string;
	calendarId: string;
	summary: string;
	description?: string;
	location?: string;
	url?: string;
	startISO: string;
	endISO: string;
	isAllDay: boolean;
	tzid?: string;
	rrule?: string;
	attendees?: Array<{ email: string; cn?: string; role?: string }>;
	geoLat?: number;
	geoLon?: number;
}

interface LocationSuggestion {
	type: "place" | "contact";
	text: string;
	geoLat?: number;
	geoLon?: number;
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
	return {
		id: cal.id,
		accountId,
		name: cal.name,
		color: cal.color,
		enabled: cal.enabled,
		readonly: cal.sourceType === "ics-subscription",
	};
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
				response: {
					description: string;
					location: string;
					url: string;
					organizer: string;
					attendees: Array<{ email: string; cn: string; partstat: string; role: string }>;
				} | null;
			};
			openExternal: { params: { url: string }; response: void };
			getTravelInfo: {
				params: { address: string };
				response: { minutes: number; originLat: number; originLon: number; destLat: number; destLon: number } | null;
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
			addCalendar: { params: { accountId: string; name: string; color: string }; response: CalendarView };
			deleteCalendar: { params: { accountId: string; calendarId: string }; response: void };
			addSubscription: { params: { url: string; name: string; color: string }; response: { account: AccountView; calendar: CalendarView } };
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
			searchContacts: { params: { query: string }; response: Array<{ email: string; cn: string }> };
			searchLocations: { params: { query: string }; response: LocationSuggestion[] };
			geocodeLocation: { params: { text: string }; response: { lat: number; lon: number } | null };
			searchEvents: {
				params: { query: string };
				response: Array<{ uid: string; recurrenceId: string | null; summary: string; dtstartUtc: string; calendarId: string; color: string; calendarName: string }>;
			};
			acknowledgeSyncError: {
				params: { href: string; shouldDelete: boolean; shouldIgnore: boolean; accountId: string };
				response: void;
			};
			getPendingCount: { params: void; response: number };
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

			async openExternal({ url }) {
				const cmd =
					process.platform === "win32" ? ["cmd", "/c", "start", url]
					: process.platform === "darwin" ? ["open", url]
					: ["xdg-open", url];
				Bun.spawn(cmd);
			},

			async getTravelInfo({ address }) {
				try {
					// Geocode destination via Nominatim
					const geoRes = await fetch(
						`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`,
						{ headers: { "User-Agent": "euorg-calendar/1.0 (contact: pip@pipobscure.com)" } },
					);
					const geoData = await geoRes.json() as Array<{ lat: string; lon: string }>;
					if (!geoData.length) return null;
					const destLat = parseFloat(geoData[0].lat);
					const destLon = parseFloat(geoData[0].lon);

					// Approximate user location via IP geolocation
					const ipRes = await fetch("https://ip-api.com/json/");
					const ipData = await ipRes.json() as { lat: number; lon: number; status: string };
					if (ipData.status !== "success") return null;
					const originLat = ipData.lat;
					const originLon = ipData.lon;

					// Driving route via OSRM public API
					const routeRes = await fetch(
						`https://router.project-osrm.org/route/v1/driving/${originLon},${originLat};${destLon},${destLat}?overview=false`,
						{ headers: { "User-Agent": "euorg-calendar/1.0" } },
					);
					const routeData = await routeRes.json() as { routes: Array<{ duration: number }>; code: string };
					if (routeData.code !== "Ok" || !routeData.routes.length) return null;

					const minutes = Math.round(routeData.routes[0].duration / 60);
					return { minutes, originLat, originLon, destLat, destLon };
				} catch {
					return null;
				}
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
				const vInput = {
					...input,
					description: input.description,
					location: input.location,
					url: input.url,
					rrule: input.rrule,
					attendees: input.attendees,
				};
				let uid: string;
				try {
					uid = await writeCreate(db, vInput, input.calendarId, accountId);
				} catch (e) {
					if (!isNetworkError(e)) { console.error("[calendar] createEvent failed:", e instanceof Error ? e.message : e); throw e; }
					console.log("[calendar] createEvent offline — queuing locally");
					uid = await saveCreateLocally(db, vInput, input.calendarId, accountId);
				}
				rpc.send("eventChanged", { uid, action: "created" });
				return { uid };
			},

			async updateEvent({ uid, input, scope, instanceStartISO }) {
				const vInput = {
					...input,
					description: input.description,
					location: input.location,
					url: input.url,
					rrule: input.rrule,
					attendees: input.attendees,
				};
				try {
					await writeUpdate(db, uid, vInput, scope, instanceStartISO);
				} catch (e) {
					if (!isNetworkError(e)) { console.error("[calendar] updateEvent failed:", e instanceof Error ? e.message : e); throw e; }
					console.log("[calendar] updateEvent offline — queuing locally");
					await saveUpdateLocally(db, uid, vInput, scope, instanceStartISO);
				}
				rpc.send("eventChanged", { uid, action: "updated" });
			},

			async deleteEvent({ uid, scope, instanceStartISO }) {
				try {
					await writeDelete(db, uid, scope, instanceStartISO);
				} catch (e) {
					if (!isNetworkError(e)) { console.error("[calendar] deleteEvent failed:", e instanceof Error ? e.message : e); throw e; }
					console.log("[calendar] deleteEvent offline — queuing locally");
					await saveDeleteLocally(db, uid, scope, instanceStartISO);
				}
				rpc.send("eventChanged", { uid, action: "deleted" });
			},

			async rescheduleEvent({ uid, instanceStartISO, newStartISO, scope }) {
				try {
					await writeReschedule(db, uid, instanceStartISO, newStartISO, scope);
				} catch (e) {
					if (!isNetworkError(e)) { console.error("[calendar] rescheduleEvent failed:", e instanceof Error ? e.message : e); throw e; }
					console.log("[calendar] rescheduleEvent offline — queuing locally");
					await saveRescheduleLocally(db, uid, instanceStartISO, newStartISO, scope);
				}
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
				if (account?.accountType === "dav" || account?.accountType === "subscription") {
					db.deleteEventsByAccount(id);
				}
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

			async addCalendar({ accountId, name, color }) {
				const cal = await addCalendarToAccount(db, accountId, name, color);
				return toCalendarView(cal, accountId);
			},

			async deleteCalendar({ accountId, calendarId }) {
				await removeCalendarFromAccount(db, accountId, calendarId);
			},

			async addSubscription({ url, name, color }) {
				const cfg = readAccounts();
				const id = generateUID();
				const calId = btoa(url).replace(/=/g, "");
				const calendar: CalDavCalendar = {
					id: calId,
					url,
					name,
					color,
					enabled: true,
					sourceType: "ics-subscription",
					subscriptionEtag: null,
				};
				const account: EuorgAccount = {
					id,
					accountType: "subscription",
					name,
					serverUrl: url,
					username: "",
					password: "",
					enabled: true,
					caldav: { homeUrl: null, defaultCalendarId: null, calendars: [calendar] },
				};
				writeAccounts(upsertAccount(cfg, account));
				// Immediately sync the new subscription feed so events appear without manual sync
				setTimeout(() => {
					syncAll(
						db,
						(p) => rpc.send("syncProgress", p),
						() => rpc.send("eventChanged", { uid: "", action: "updated" }),
					)
						.then((r) => rpc.send("syncComplete", r))
						.catch(() => {});
				}, 200);
				return { account: toAccountView(account), calendar: toCalendarView(calendar, id) };
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
			async searchContacts({ query }) {
				const dbPath = join(homedir(), ".euorg", "contacts", "contacts.db");
				if (!existsSync(dbPath)) return [];
				let cdb: Database | null = null;
				try {
					cdb = new Database(dbPath, { readonly: true });
					const q = `%${query.toLowerCase()}%`;
					const rows = cdb.query(
						`SELECT display_name, emails FROM contacts WHERE lower(display_name) LIKE ? OR lower(emails) LIKE ? ORDER BY display_name COLLATE NOCASE LIMIT 20`
					).all(q, q) as Array<{ display_name: string; emails: string }>;
					const results: Array<{ email: string; cn: string }> = [];
					for (const row of rows) {
						let emails: Array<{ value: string }> = [];
						try { emails = JSON.parse(row.emails); } catch {}
						for (const e of emails) {
							if (e.value) results.push({ email: e.value, cn: row.display_name });
						}
					}
					return results;
				} catch { return []; }
				finally { cdb?.close(); }
			},
			async searchLocations({ query }) {
				const placeResults: LocationSuggestion[] = [];
				const contactResults: LocationSuggestion[] = [];

				// 1. Photon (OSM) — place name + address search
				try {
					const res = await fetch(
						`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5`,
						{ headers: { "User-Agent": "euorg-calendar/1.0" }, signal: AbortSignal.timeout(3000) },
					);
					const data = await res.json() as {
						features: Array<{
							geometry: { coordinates: [number, number] };
							properties: {
								name?: string; street?: string; housenumber?: string;
								city?: string; state?: string; country?: string; postcode?: string;
							};
						}>;
					};
					for (const f of data.features ?? []) {
						const p = f.properties;
						const street = p.housenumber ? `${p.street ?? ""} ${p.housenumber}`.trim() : p.street;
						const parts = [p.name, street, p.city, p.state, p.country].filter(Boolean);
						const text = parts.join(", ");
						if (!text) continue;
						const [lon, lat] = f.geometry.coordinates; // GeoJSON is [lon, lat]
						placeResults.push({ type: "place", text, geoLat: lat, geoLon: lon });
					}
				} catch {}

				// 2. Contacts address book — last step
				const contactsDbPath = join(homedir(), ".euorg", "contacts", "contacts.db");
				if (existsSync(contactsDbPath)) {
					let cdb: Database | null = null;
					try {
						cdb = new Database(contactsDbPath, { readonly: true });
						const q = `%${query.toLowerCase()}%`;
						const rows = cdb.query(
							`SELECT display_name, addresses FROM contacts
							 WHERE lower(display_name) LIKE ? OR lower(addresses) LIKE ?
							 ORDER BY display_name COLLATE NOCASE LIMIT 10`,
						).all(q, q) as Array<{ display_name: string; addresses: string }>;
						for (const row of rows) {
							let addrs: Array<{ street?: string; city?: string; region?: string; postcode?: string; country?: string }> = [];
							try { addrs = JSON.parse(row.addresses); } catch {}
							if (addrs.length === 0) {
								// Contact matched by name but has no stored address — show name as freeform location
								contactResults.push({ type: "contact", text: row.display_name });
							} else {
								for (const a of addrs) {
									const parts = [a.street, a.city, a.region, a.postcode, a.country].filter(Boolean);
									if (!parts.length) continue;
									const text = `${row.display_name}, ${parts.join(", ")}`;
									contactResults.push({ type: "contact", text });
								}
							}
						}
					} catch (e) { console.error('[searchLocations] contacts DB error:', e); } finally { cdb?.close(); }
				}

				return [...contactResults, ...placeResults];
			},

			async geocodeLocation({ text }) {
				try {
					const res = await fetch(
						`https://photon.komoot.io/api/?q=${encodeURIComponent(text)}&limit=1`,
						{ headers: { "User-Agent": "euorg-calendar/1.0" }, signal: AbortSignal.timeout(3000) },
					);
					const data = await res.json() as { features: Array<{ geometry: { coordinates: [number, number] } }> };
					if (!data.features?.length) return null;
					const [lon, lat] = data.features[0].geometry.coordinates;
					return { lat, lon };
				} catch {
					return null;
				}
			},

			async searchEvents({ query }) {
				const calMap = buildCalendarMap();
				const rows = db.searchEvents(query);
				return rows.map((r) => {
					const cal = calMap.get(r.calendarId);
					return {
						uid: r.uid,
						recurrenceId: r.recurrenceId,
						summary: r.summary,
						dtstartUtc: r.dtstartUtc,
						calendarId: r.calendarId,
						color: cal?.color ?? '#6366f1',
						calendarName: cal?.name ?? '',
					};
				});
			},

			async getPendingCount() {
				return db.getPendingCount();
			},

			async acknowledgeSyncError({ href, shouldDelete, shouldIgnore, accountId }) {
				if (shouldIgnore) {
					const ignored = loadIgnoredSyncErrors();
					ignored.add(href);
					saveIgnoredSyncErrors(ignored);
				}
				if (shouldDelete) {
					try {
						const cfg = readAccounts();
						const account = cfg.accounts.find((a) => a.id === accountId);
						if (account) {
							const row = (db as any).db
								.prepare("SELECT etag FROM events WHERE href = ? LIMIT 1")
								.get(href);
							const etag = row?.etag ?? "";
							await caldavDelete(href, account.serverUrl, etag, {
								serverUrl: account.serverUrl,
								username: account.username,
								password: account.password,
							});
						}
					} catch {
						// Server delete failed (e.g. already gone) — still clean up locally
					}
					db.deleteEventByHref(href);
				}
			},
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
