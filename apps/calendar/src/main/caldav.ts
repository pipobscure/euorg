/**
 * CalDAV HTTP client.
 * Implements service discovery, ETag listing, event fetch, and write operations.
 * All HTTP via Bun's built-in fetch. Basic auth only.
 *
 * Differences from CardDAV:
 *  - Discovery uses calendar-home-set (urn:ietf:params:xml:ns:caldav)
 *  - Collection detection: <C:calendar/> in resourcetype
 *  - ETag listing uses REPORT with calendar-query body
 *  - /.well-known/caldav discovery with manual redirect handling
 */

import {
	parse,
	descendants,
	descendant,
	child,
	children,
	textContent,
	attr,
	type Element,
} from "@pipobscure/xml";

// ── Namespaces ────────────────────────────────────────────────────────────────

const DAV = "DAV:";
const CALDAV = "urn:ietf:params:xml:ns:caldav";
const APPLE = "http://apple.com/ns/ical/";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CalDAVCredentials {
	serverUrl: string;
	username: string;
	password: string;
}

export interface RemoteCalendar {
	/** Stable identifier: btoa(url) with padding stripped */
	id: string;
	/** Full URL to the calendar collection */
	url: string;
	name: string;
	/** Hex color without alpha, e.g. "#3b82f6"; null if server doesn't report color */
	color: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function basicAuth(username: string, password: string): string {
	return "Basic " + btoa(`${username}:${password}`);
}

function resolveUrl(base: string, href: string): string {
	if (href.startsWith("http://") || href.startsWith("https://")) return href;
	const u = new URL(base);
	if (href.startsWith("/")) return `${u.protocol}//${u.host}${href}`;
	return new URL(href, base).toString();
}

// ── XML Parsing Helpers ───────────────────────────────────────────────────────

/** Parse a 207 Multi-Status response and return all <response> elements */
function parseResponses(xml: string): Element[] {
	return descendants(parse(xml), "response", DAV);
}

function getHref(response: Element): string {
	return decodeURIComponent(textContent(child(response, "href", DAV)));
}

function getEtag(response: Element): string {
	return textContent(descendant(response, "getetag", DAV)).replace(/^"|"$/g, "");
}

function getDisplayName(response: Element): string {
	return textContent(descendant(response, "displayname", DAV));
}

/** Check if resourcetype contains a <calendar> element */
function isCalendar(response: Element): boolean {
	return !!descendant(response, "calendar", CALDAV);
}

function isICSResource(response: Element): boolean {
	const ct = textContent(descendant(response, "getcontenttype", DAV));
	const href = getHref(response);
	return ct.includes("text/calendar") || href.endsWith(".ics");
}

/** Extract calendar color from Apple/Nextcloud extension properties */
function extractCalendarColor(response: Element): string | null {
	// Nextcloud/Apple: <apple:calendar-color>#3b82f6FF</apple:calendar-color>
	const raw =
		textContent(descendant(response, "calendar-color", APPLE)) ||
		textContent(descendant(response, "calendar-color", CALDAV)) ||
		textContent(descendant(response, "calendar-order", APPLE));
	if (!raw || !raw.startsWith("#")) return null;
	// Strip alpha suffix if 9 chars (#RRGGBBAA)
	return raw.slice(0, 7);
}

/** Extract calendar-data (ICS content) from a response element.
 *  textContent handles both CDATA sections and XML-encoded text automatically. */
function extractCalendarData(response: Element): string | null {
	const data = textContent(descendant(response, "calendar-data", CALDAV));
	return data || null;
}

/** Find the current-user-principal URL from a PROPFIND response */
function findPrincipalUrl(xml: string, base: string): string | null {
	const doc = parse(xml);
	const el =
		descendant(doc, "current-user-principal", DAV) ?? descendant(doc, "principal-URL", DAV);
	if (!el) return null;
	const href = textContent(child(el, "href", DAV));
	return href ? resolveUrl(base, href) : null;
}

function findCalendarHomeSetUrl(xml: string, base: string): string | null {
	const doc = parse(xml);
	const el = descendant(doc, "calendar-home-set", CALDAV);
	if (!el) return null;
	const href = textContent(child(el, "href", DAV));
	return href ? resolveUrl(base, href) : null;
}

// ── PROPFIND helper ───────────────────────────────────────────────────────────

async function propfind(
	url: string,
	body: string,
	auth: string,
	depth: "0" | "1" | "infinity" = "0",
): Promise<{ xml: string; status: number }> {
	const res = await fetch(url, {
		method: "PROPFIND",
		headers: {
			Authorization: auth,
			"Content-Type": "application/xml; charset=utf-8",
			Depth: depth,
		},
		body,
		redirect: "follow",
	});
	const xml = await res.text();
	return { xml, status: res.status };
}

// ── Discovery XML bodies ──────────────────────────────────────────────────────

const PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:current-user-principal/>
    <d:principal-URL/>
  </d:prop>
</d:propfind>`;

const PROPFIND_HOME_SET = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-home-set/>
  </d:prop>
</d:propfind>`;

const PROPFIND_CALENDARS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:apple="http://apple.com/ns/ical/">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:getctag/>
    <c:supported-calendar-component-set/>
    <apple:calendar-color/>
  </d:prop>
</d:propfind>`;

// ── Service Discovery ─────────────────────────────────────────────────────────

/**
 * Discover all CalDAV calendar collections for the given credentials.
 * Follows the well-known URI and principal-based discovery chain.
 */
export async function discoverCalendars(creds: CalDAVCredentials): Promise<RemoteCalendar[]> {
	const auth = basicAuth(creds.username, creds.password);
	const baseUrl = creds.serverUrl.replace(/\/$/, "");

	// Step 1: Find principal URL
	let principalUrl: string | null = null;
	const discoveryUrls = [
		baseUrl,
		`${baseUrl}/.well-known/caldav`,
		`${baseUrl}/dav`,
		`${baseUrl}/remote.php/dav`, // Nextcloud
	];

	for (const url of discoveryUrls) {
		try {
			const { xml, status } = await propfind(url, PROPFIND_PRINCIPAL, auth, "0");
			if (status === 207 || status === 200) {
				principalUrl = findPrincipalUrl(xml, baseUrl);
				if (principalUrl) break;
			}
		} catch {
			// try next
		}
	}

	if (!principalUrl) principalUrl = baseUrl;

	// Step 2: Find calendar home set
	let homeSetUrl: string | null = null;
	try {
		const { xml } = await propfind(principalUrl, PROPFIND_HOME_SET, auth, "0");
		homeSetUrl = findCalendarHomeSetUrl(xml, baseUrl);
	} catch {}

	if (!homeSetUrl) homeSetUrl = principalUrl;

	// Step 3: List calendar collections under home set
	const { xml } = await propfind(homeSetUrl, PROPFIND_CALENDARS, auth, "1");
	const calendars: RemoteCalendar[] = [];

	for (const response of parseResponses(xml)) {
		if (!isCalendar(response)) continue;
		const href = getHref(response);
		if (!href) continue;
		const url = resolveUrl(baseUrl, href);
		if (url === homeSetUrl) continue; // skip home set itself

		// Only include calendars that support VEVENT
		const supportedEl = descendant(response, "supported-calendar-component-set", CALDAV);
		if (supportedEl) {
			const comps = children(supportedEl, "comp", CALDAV);
			if (!comps.some((c) => attr(c, "name")?.toUpperCase() === "VEVENT")) continue;
		}

		const name = getDisplayName(response) || url.split("/").filter(Boolean).pop() || "Calendar";
		const id = btoa(url).replace(/=/g, "");
		const color = extractCalendarColor(response);
		calendars.push({ id, url, name, color });
	}

	return calendars;
}

// ── ETag Listing ──────────────────────────────────────────────────────────────

const REPORT_ETAGS = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <d:getcontenttype/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT"/>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

/** List all event hrefs + ETags in a calendar without downloading ICS data */
export async function listEtags(
	calendarUrl: string,
	creds: CalDAVCredentials,
): Promise<Map<string, string>> {
	const auth = basicAuth(creds.username, creds.password);
	const res = await fetch(calendarUrl, {
		method: "REPORT",
		headers: {
			Authorization: auth,
			"Content-Type": "application/xml; charset=utf-8",
			Depth: "1",
		},
		body: REPORT_ETAGS,
	});
	const xml = await res.text();
	const map = new Map<string, string>();
	for (const response of parseResponses(xml)) {
		const href = getHref(response);
		const etag = getEtag(response);
		if (href && (etag || isICSResource(response))) {
			map.set(href, etag);
		}
	}
	return map;
}

/**
 * Fetch all events within a UTC time range, including full ICS content.
 * Uses a single calendar-query REPORT with calendar-data, which is much faster
 * than fetching each event individually. Used for the "near-term first" sync phase.
 */
export async function fetchEventsInRange(
	calendarUrl: string,
	creds: CalDAVCredentials,
	rangeStartZ: string, // "20260122T000000Z"
	rangeEndZ: string,
): Promise<Array<{ href: string; etag: string; ics: string }>> {
	const auth = basicAuth(creds.username, creds.password);
	const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${rangeStartZ}" end="${rangeEndZ}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

	let res: Response;
	try {
		res = await fetch(calendarUrl, {
			method: "REPORT",
			headers: {
				Authorization: auth,
				"Content-Type": "application/xml; charset=utf-8",
				Depth: "1",
			},
			body,
		});
	} catch {
		return [];
	}

	if (!res.ok) return [];
	const xml = await res.text();
	const results: Array<{ href: string; etag: string; ics: string }> = [];
	for (const response of parseResponses(xml)) {
		const href = getHref(response);
		const etag = getEtag(response);
		const ics = extractCalendarData(response);
		if (href && ics) results.push({ href, etag, ics });
	}
	return results;
}

// ── Fetch ICS ─────────────────────────────────────────────────────────────────

/** Fetch a single event ICS by its href */
export async function fetchEvent(
	href: string,
	baseUrl: string,
	creds: CalDAVCredentials,
): Promise<{ ics: string; etag: string }> {
	const auth = basicAuth(creds.username, creds.password);
	const url = resolveUrl(baseUrl, href);
	const res = await fetch(url, {
		headers: { Authorization: auth, Accept: "text/calendar, */*" },
	});
	if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
	const ics = await res.text();
	const etag = (res.headers.get("ETag") ?? "").replace(/^"|"$/g, "");
	return { ics, etag };
}

// ── Write Operations ──────────────────────────────────────────────────────────

/** Create a new event. Returns the server-assigned href and ETag. */
export async function createEvent(
	calendarUrl: string,
	uid: string,
	ics: string,
	creds: CalDAVCredentials,
): Promise<{ href: string; etag: string }> {
	const auth = basicAuth(creds.username, creds.password);
	const filename = `${encodeURIComponent(uid)}.ics`;
	const url = calendarUrl.replace(/\/$/, "") + "/" + filename;

	const res = await fetch(url, {
		method: "PUT",
		headers: {
			Authorization: auth,
			"Content-Type": "text/calendar; charset=utf-8",
			"If-None-Match": "*", // ensure it's a create, not update
		},
		body: ics,
	});

	if (!res.ok && res.status !== 201 && res.status !== 204) {
		throw new Error(`PUT ${url} → ${res.status} ${await res.text()}`);
	}

	const locationHdr = res.headers.get("Location");
	let href: string;
	if (locationHdr) {
		// Location header may be absolute ("https://...") or relative ("/caldav/...")
		try { href = new URL(locationHdr).pathname; }
		catch { href = locationHdr; } // already a path
	} else {
		href = new URL(url).pathname;
	}
	const etag = (res.headers.get("ETag") ?? "").replace(/^"|"$/g, "");
	return { href, etag };
}

/** Update an existing event. If-Match enforces optimistic concurrency. */
export async function updateEvent(
	href: string,
	baseUrl: string,
	ics: string,
	etag: string,
	creds: CalDAVCredentials,
): Promise<string> {
	const auth = basicAuth(creds.username, creds.password);
	const url = resolveUrl(baseUrl, href);

	const res = await fetch(url, {
		method: "PUT",
		headers: {
			Authorization: auth,
			"Content-Type": "text/calendar; charset=utf-8",
			"If-Match": etag ? `"${etag}"` : "*",
		},
		body: ics,
	});

	if (res.status === 412) throw new Error("CONFLICT: Event was modified on server");
	if (!res.ok && res.status !== 204) {
		const body = await res.text();
		console.log(`[caldavUpdate] PUT ${url} → ${res.status}, body=${body.slice(0, 300)}`);
		// CalDAV no-uid-conflict (RFC 4791 §5.3.2): UID exists at a different href.
		// Extract the conflicting href so the caller can retry to the correct location.
		if (body.includes("no-uid-conflict")) {
			const match = body.match(/<[^:>]*:?href[^>]*>([^<]+)<\/[^:>]*:?href>/i);
			const conflictHref = match ? decodeURIComponent(match[1].trim()) : "";
			console.log(`[caldavUpdate] UIDCONFLICT detected, conflictHref=${conflictHref || "(empty)"}`);
			throw new Error(`UIDCONFLICT:${conflictHref}`);
		}
		throw new Error(`PUT ${url} → ${res.status} ${body}`);
	}

	return (res.headers.get("ETag") ?? "").replace(/^"|"$/g, "");
}

/** Delete an event. */
export async function deleteEvent(
	href: string,
	baseUrl: string,
	etag: string,
	creds: CalDAVCredentials,
): Promise<void> {
	const auth = basicAuth(creds.username, creds.password);
	const url = resolveUrl(baseUrl, href);

	const res = await fetch(url, {
		method: "DELETE",
		headers: {
			Authorization: auth,
			...(etag ? { "If-Match": `"${etag}"` } : {}),
		},
	});

	if (res.status === 412) throw new Error("CONFLICT: ETag mismatch on delete");
	if (!res.ok && res.status !== 204 && res.status !== 404) {
		throw new Error(`DELETE ${url} → ${res.status}`);
	}
}

/** Test connectivity and credentials. Returns null on success, error message on failure. */
export async function testConnection(creds: CalDAVCredentials): Promise<string | null> {
	try {
		const calendars = await discoverCalendars(creds);
		if (calendars.length === 0) return "Connected but no calendar collections found";
		return null;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}
