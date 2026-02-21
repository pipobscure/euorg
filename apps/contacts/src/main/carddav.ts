/**
 * CardDAV HTTP client.
 * Implements service discovery, ETag listing, vCard fetch, and write operations.
 * All HTTP via Bun's built-in fetch. Basic auth only.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CardDAVCredentials {
	serverUrl: string;
	username: string;
	password: string;
}

export interface RemoteCollection {
	id: string; // stable: base64 of URL
	url: string; // full URL to the collection
	name: string;
}

export interface RemoteContactMeta {
	href: string; // relative or absolute URL
	etag: string;
	vcfData?: string; // present if address-data was requested
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
	// handles namespaced tags: <d:tagname> or <tagname>
	const re = new RegExp(`<[^>]*:?${tag}[^>]*>([\\s\\S]*?)<\/[^>]*:?${tag}>`, "i");
	const m = xml.match(re);
	return m ? m[1].trim() : null;
}

/** Extract all occurrences of a tag, return array of inner text */
function extractAllTags(xml: string, tag: string): string[] {
	const re = new RegExp(`<[^>]*:?${tag}[^>]*>([\\s\\S]*?)<\/[^>]*:?${tag}>`, "gi");
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

/** Extract href from a response block */
function extractHref(block: string): string {
	return extractTag(block, "href") ?? "";
}

/** Extract ETag (strip quotes) */
function extractEtag(block: string): string {
	const raw = extractTag(block, "getetag") ?? "";
	return raw.replace(/^"|"$/g, "");
}

/** Extract display name */
function extractDisplayName(block: string): string {
	return extractTag(block, "displayname") ?? "";
}

/** Extract address-data (vCard text) */
function extractAddressData(block: string): string {
	return extractTag(block, "address-data") ?? "";
}

/** Check if a response block has resourcetype containing addressbook */
function isAddressbook(block: string): boolean {
	return block.toLowerCase().includes("addressbook");
}

/** Check if a response block represents a vCard (not a collection) */
function isVCard(block: string): boolean {
	const ct = extractTag(block, "getcontenttype") ?? "";
	return ct.includes("vcard") || (extractHref(block).endsWith(".vcf") && !isAddressbook(block));
}

// ── Service Discovery ─────────────────────────────────────────────────────────

const PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:current-user-principal/>
    <d:principal-URL/>
  </d:prop>
</d:propfind>`;

const PROPFIND_HOME_SET = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <card:addressbook-home-set/>
  </d:prop>
</d:propfind>`;

const PROPFIND_COLLECTIONS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:getctag/>
  </d:prop>
</d:propfind>`;

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
	});
	const xml = await res.text();
	return { xml, status: res.status };
}

/** Find the current-user-principal URL from a PROPFIND response */
function findPrincipalUrl(xml: string, base: string): string | null {
	// <d:current-user-principal><d:href>/principals/user/</d:href></d:current-user-principal>
	const inner = extractTag(xml, "current-user-principal") ?? extractTag(xml, "principal-URL") ?? "";
	const href = extractTag(inner, "href");
	return href ? resolveUrl(base, href) : null;
}

/** Find the addressbook-home-set URL */
function findHomeSetUrl(xml: string, base: string): string | null {
	const inner = extractTag(xml, "addressbook-home-set") ?? "";
	const href = extractTag(inner, "href");
	return href ? resolveUrl(base, href) : null;
}

export async function discoverCollections(creds: CardDAVCredentials): Promise<RemoteCollection[]> {
	const auth = basicAuth(creds.username, creds.password);
	const baseUrl = creds.serverUrl.replace(/\/$/, "");

	// Step 1: Find principal URL (try server root first, then /.well-known/carddav)
	let principalUrl: string | null = null;
	for (const url of [baseUrl, baseUrl + "/.well-known/carddav"]) {
		try {
			const { xml } = await propfind(url, PROPFIND_PRINCIPAL, auth, "0");
			principalUrl = findPrincipalUrl(xml, baseUrl);
			if (principalUrl) break;
		} catch {
			// try next
		}
	}

	if (!principalUrl) {
		// Fallback: assume the server URL itself is the home set
		principalUrl = baseUrl;
	}

	// Step 2: Find addressbook home set
	let homeSetUrl: string | null = null;
	try {
		const { xml } = await propfind(principalUrl, PROPFIND_HOME_SET, auth, "0");
		homeSetUrl = findHomeSetUrl(xml, baseUrl);
	} catch {
		// ignore
	}

	if (!homeSetUrl) {
		homeSetUrl = principalUrl;
	}

	// Step 3: List collections under home set
	const { xml } = await propfind(homeSetUrl, PROPFIND_COLLECTIONS, auth, "1");
	const blocks = splitResponses(xml);
	const collections: RemoteCollection[] = [];

	for (const block of blocks) {
		if (!isAddressbook(block)) continue;
		const href = extractHref(block);
		if (!href) continue;
		const url = resolveUrl(baseUrl, href);
		// Skip if the URL equals the home set itself (it reports itself as addressbook-home-set)
		if (url === homeSetUrl) continue;
		const name = extractDisplayName(block) || url.split("/").filter(Boolean).pop() || "Addressbook";
		const id = btoa(url).replace(/=/g, "");
		collections.push({ id, url, name });
	}

	return collections;
}

// ── ETag Listing (for sync) ───────────────────────────────────────────────────

const REPORT_ETAGS = `<?xml version="1.0" encoding="utf-8"?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:getetag/>
    <d:getcontenttype/>
  </d:prop>
</card:addressbook-query>`;

/** List all contact hrefs + ETags in a collection without downloading vCard data */
export async function listEtags(
	collectionUrl: string,
	creds: CardDAVCredentials,
): Promise<Map<string, string>> {
	const auth = basicAuth(creds.username, creds.password);
	const res = await fetch(collectionUrl, {
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
		// Only include actual vCards (skip collection itself)
		if (href && (etag || isVCard(block))) {
			map.set(href, etag);
		}
	}
	return map;
}

// ── Fetch vCard ───────────────────────────────────────────────────────────────

export async function fetchVCard(
	href: string,
	baseUrl: string,
	creds: CardDAVCredentials,
): Promise<{ vcf: string; etag: string }> {
	const auth = basicAuth(creds.username, creds.password);
	const url = resolveUrl(baseUrl, href);
	const res = await fetch(url, {
		headers: { Authorization: auth, Accept: "text/vcard, */*" },
	});
	if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
	const vcf = await res.text();
	const etag = (res.headers.get("ETag") ?? "").replace(/^"|"$/g, "");
	return { vcf, etag };
}

// ── Write Operations ──────────────────────────────────────────────────────────

/** Create a new contact. Returns the server-assigned href and ETag. */
export async function createContact(
	collectionUrl: string,
	uid: string,
	vcf: string,
	creds: CardDAVCredentials,
): Promise<{ href: string; etag: string }> {
	const auth = basicAuth(creds.username, creds.password);
	const filename = `${encodeURIComponent(uid)}.vcf`;
	const url = collectionUrl.replace(/\/$/, "") + "/" + filename;

	const res = await fetch(url, {
		method: "PUT",
		headers: {
			Authorization: auth,
			"Content-Type": "text/vcard; charset=utf-8",
		},
		body: vcf,
	});

	if (!res.ok && res.status !== 201 && res.status !== 204) {
		throw new Error(`PUT ${url} → ${res.status} ${await res.text()}`);
	}

	const location = res.headers.get("Location");
	const href = location ? new URL(location).pathname : new URL(url).pathname;
	const etag = (res.headers.get("ETag") ?? "").replace(/^"|"$/g, "");
	return { href, etag };
}

/** Update an existing contact. If-Match enforces optimistic concurrency. */
export async function updateContact(
	href: string,
	baseUrl: string,
	vcf: string,
	etag: string,
	creds: CardDAVCredentials,
): Promise<string> {
	const auth = basicAuth(creds.username, creds.password);
	const url = resolveUrl(baseUrl, href);

	const res = await fetch(url, {
		method: "PUT",
		headers: {
			Authorization: auth,
			"Content-Type": "text/vcard; charset=utf-8",
			"If-Match": etag ? `"${etag}"` : "*",
		},
		body: vcf,
	});

	if (res.status === 412) throw new Error("CONFLICT: ETag mismatch — contact was modified on server");
	if (!res.ok && res.status !== 204) {
		throw new Error(`PUT ${url} → ${res.status} ${await res.text()}`);
	}

	return (res.headers.get("ETag") ?? "").replace(/^"|"$/g, "");
}

/** Delete a contact. */
export async function deleteContact(
	href: string,
	baseUrl: string,
	etag: string,
	creds: CardDAVCredentials,
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
export async function testConnection(creds: CardDAVCredentials): Promise<string | null> {
	try {
		const collections = await discoverCollections(creds);
		if (collections.length === 0) return "Connected but no addressbook collections found";
		return null;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}
