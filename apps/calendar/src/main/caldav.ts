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

/** Extract text content of the first tag matching name in XML string */
function extractTag(xml: string, tag: string): string | null {
	const re = new RegExp(`<[^>]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[^>]*:?${tag}>`, "i");
	const m = xml.match(re);
	return m ? m[1].trim() : null;
}

/** Extract all occurrences of a tag, return array of inner text */
function extractAllTags(xml: string, tag: string): string[] {
	const re = new RegExp(`<[^>]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[^>]*:?${tag}>`, "gi");
	const results: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml)) !== null) {
		results.push(m[1].trim());
	}
	return results;
}

/** Split a 207 Multi-Status response into individual <response> blocks */
function splitResponses(xml: string): string[] {
	return extractAllTags(xml, "response");
}

function extractHref(block: string): string {
	return decodeURIComponent(extractTag(block, "href") ?? "");
}

function extractEtag(block: string): string {
	const raw = extractTag(block, "getetag") ?? "";
	return raw.replace(/^"|"$/g, "");
}

function extractDisplayName(block: string): string {
	return extractTag(block, "displayname") ?? "";
}

function isCalendar(block: string): boolean {
	// Match <X:calendar/>, <X:calendar>, or <calendar/> in resourcetype block.
	// Self-closing <cal:calendar/> is the most common form — the old regex missed it.
	return /<[a-zA-Z]+:calendar[\s/>]/.test(block) || /<calendar[\s/>]/.test(block);
}

function isICSResource(block: string): boolean {
	const ct = extractTag(block, "getcontenttype") ?? "";
	const href = extractHref(block);
	return ct.includes("text/calendar") || href.endsWith(".ics");
}

/** Extract calendar color from Apple/Nextcloud extension properties */
function extractCalendarColor(block: string): string | null {
	// Nextcloud/Apple: <apple:calendar-color>#3b82f6FF</apple:calendar-color>
	// Some servers: <cal:calendar-color>#3b82f6</cal:calendar-color>
	const raw =
		extractTag(block, "calendar-color") ??
		extractTag(block, "calendar-order"); // fallback to order if no color
	if (!raw || !raw.startsWith("#")) return null;
	// Strip alpha suffix if 9 chars (#RRGGBBAA)
	return raw.length === 9 ? raw.slice(0, 7) : raw.slice(0, 7);
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

// ── Principal URL discovery ───────────────────────────────────────────────────

function findPrincipalUrl(xml: string, base: string): string | null {
	const inner =
		extractTag(xml, "current-user-principal") ?? extractTag(xml, "principal-URL") ?? "";
	const href = extractTag(inner, "href");
	return href ? resolveUrl(base, href) : null;
}

function findCalendarHomeSetUrl(xml: string, base: string): string | null {
	const inner = extractTag(xml, "calendar-home-set") ?? "";
	const href = extractTag(inner, "href");
	return href ? resolveUrl(base, href) : null;
}

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
	const blocks = splitResponses(xml);
	const calendars: RemoteCalendar[] = [];

	for (const block of blocks) {
		if (!isCalendar(block)) continue;
		const href = extractHref(block);
		if (!href) continue;
		const url = resolveUrl(baseUrl, href);
		if (url === homeSetUrl) continue; // skip home set itself

		// Only include calendars that support VEVENT
		const supported = extractTag(block, "supported-calendar-component-set") ?? "";
		if (supported && !supported.toLowerCase().includes("vevent")) continue;

		const name =
			extractDisplayName(block) || url.split("/").filter(Boolean).pop() || "Calendar";
		const id = btoa(url).replace(/=/g, "");
		const color = extractCalendarColor(block);
		calendars.push({ id, url, name, color });
	}

	return calendars;
}

/** Extract calendar-data (ICS content) from a response block; handles CDATA and XML-encoding */
function extractCalendarData(block: string): string | null {
	// CDATA section: <c:calendar-data><![CDATA[BEGIN:VCALENDAR...]]></c:calendar-data>
	const cdataMatch = block.match(/<[^>]*:?calendar-data[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>/i);
	if (cdataMatch) return cdataMatch[1].trim();
	// Regular XML-encoded content
	const raw = extractTag(block, "calendar-data");
	if (!raw) return null;
	return raw
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

/** Format a Date as a CalDAV UTC datetime string: "20260122T000000Z" */
function toCalDAVDateTime(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
		`T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
	);
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
	for (const block of splitResponses(xml)) {
		const href = extractHref(block);
		const etag = extractEtag(block);
		if (href && (etag || isICSResource(block))) {
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
	for (const block of splitResponses(xml)) {
		const href = extractHref(block);
		const etag = extractEtag(block);
		const ics = extractCalendarData(block);
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

	const location = res.headers.get("Location");
	const href = location ? new URL(location).pathname : new URL(url).pathname;
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

	if (res.status === 412) throw new Error("CONFLICT: ETag mismatch — event was modified on server");
	if (!res.ok && res.status !== 204) {
		throw new Error(`PUT ${url} → ${res.status} ${await res.text()}`);
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
