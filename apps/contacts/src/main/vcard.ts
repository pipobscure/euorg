/**
 * vCard adapter — wraps @pipobscure/vcard for use within this app.
 *
 * Exposes the same interface as before (VCard, VCardInput, parseVCard,
 * serializeVCard, displayName, mergeVCards) so callers need no changes.
 */

import {
	VCard as LibVCard,
	FNProperty,
	NProperty,
	EmailProperty,
	TelProperty,
	AdrProperty,
	OrgProperty,
	TitleProperty,
	BDayProperty,
	NoteProperty,
	PhotoProperty,
	UIDProperty,
	RevProperty,
	GeoProperty,
} from "@pipobscure/vcard";

// ── App-internal types ─────────────────────────────────────────────────────

export interface VCardEmail {
	value: string;
	type: string;
}

export interface VCardPhone {
	value: string;
	type: string;
}

export interface VCardAddress {
	street: string;
	city: string;
	region: string;
	postcode: string;
	country: string;
	type: string;
	geoLat?: number;
	geoLon?: number;
}

export interface VCard {
	uid: string;
	fn: string;
	firstName: string;
	lastName: string;
	middleName: string;
	prefix: string;
	suffix: string;
	emails: VCardEmail[];
	phones: VCardPhone[];
	addresses: VCardAddress[];
	org: string;
	title: string;
	birthday: string; // ISO date YYYY-MM-DD or ""
	note: string;
	photo: string; // data URI or URL or ""
	rev: string;
	raw: string;
}

export interface VCardInput {
	uid?: string;
	firstName?: string;
	lastName?: string;
	middleName?: string;
	prefix?: string;
	suffix?: string;
	fn?: string;
	emails?: VCardEmail[];
	phones?: VCardPhone[];
	addresses?: VCardAddress[];
	org?: string;
	title?: string;
	birthday?: string;
	note?: string;
	photo?: string;
}

// ── Parser ─────────────────────────────────────────────────────────────────

export function parseVCard(raw: string): VCard {
	const vcards = LibVCard.parse(raw);
	const vc = vcards[0] ?? new LibVCard();

	// UID
	const uid = vc.uid?.value || `urn:uuid:${crypto.randomUUID()}`;

	// FN
	const fn = vc.displayName;

	// N
	const n = vc.n?.value;
	const firstName = n?.givenNames[0] ?? "";
	const lastName = n?.familyNames[0] ?? "";
	const middleName = n?.additionalNames[0] ?? "";
	const prefix = n?.honorificPrefixes[0] ?? "";
	const suffix = n?.honorificSuffixes[0] ?? "";

	// Emails
	const emails: VCardEmail[] = vc.email.map((e) => ({
		value: e.value,
		type: e.type[0] ?? "",
	}));

	// Phones — strip tel: URI prefix for display
	const phones: VCardPhone[] = vc.tel.map((p) => ({
		value: p.value.startsWith("tel:") ? p.value.slice(4) : p.value,
		type: p.type[0] ?? "",
	}));

	// Addresses
	const addresses: VCardAddress[] = vc.adr.map((a) => ({
		street: a.value.streetAddress,
		city: a.value.locality,
		region: a.value.region,
		postcode: a.value.postalCode,
		country: a.value.countryName,
		type: a.type[0] ?? "",
	}));

	// GEO — assign first geo property to first address
	const geo = vc.geo[0]?.coordinates;
	if (geo && addresses.length > 0) {
		addresses[0]!.geoLat = geo.latitude;
		addresses[0]!.geoLon = geo.longitude;
	}

	// Org
	const org = vc.org[0]?.value.name ?? "";

	// Title
	const title = vc.title[0]?.value ?? "";

	// Birthday → YYYY-MM-DD
	let birthday = "";
	const bday = vc.bday;
	if (bday?.dateValue) {
		const d = bday.dateValue;
		if (d.year != null && d.month != null && d.day != null) {
			birthday = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
		}
	} else if (bday?.textValue) {
		birthday = bday.textValue;
	}

	// Note
	const note = vc.note[0]?.value ?? "";

	// Photo — handle vCard 3.0 ENCODING=B base64 photos
	let photo = "";
	if (vc.photo.length > 0) {
		const p = vc.photo[0]!;
		const encoding = p.params.get("ENCODING");
		const encodingStr = (Array.isArray(encoding) ? encoding[0] : encoding)?.toUpperCase();
		if (encodingStr === "B" || encodingStr === "BASE64") {
			const typeParam = p.params.get("TYPE");
			const ext = ((Array.isArray(typeParam) ? typeParam[0] : typeParam) ?? "jpeg").toLowerCase();
			const mimeMap: Record<string, string> = {
				jpeg: "image/jpeg",
				jpg: "image/jpeg",
				png: "image/png",
				gif: "image/gif",
				webp: "image/webp",
			};
			const mimeType = mimeMap[ext] ?? `image/${ext}`;
			photo = `data:${mimeType};base64,${p.value.replace(/\s/g, "")}`;
		} else {
			photo = p.value;
		}
	}

	// Rev
	const rev = vc.rev ? vc.rev.toContentLine() : "";

	return {
		uid,
		fn,
		firstName,
		lastName,
		middleName,
		prefix,
		suffix,
		emails,
		phones,
		addresses,
		org,
		title,
		birthday,
		note,
		photo,
		rev,
		raw,
	};
}

// ── Serializer ─────────────────────────────────────────────────────────────

export function serializeVCard(input: VCardInput): string {
	const vc = new LibVCard();

	// UID
	const uid = input.uid ?? `urn:uuid:${crypto.randomUUID()}`;
	vc.uid = new UIDProperty(uid);

	// FN — build from name parts if not provided directly
	const fn =
		input.fn ||
		[input.prefix, input.firstName, input.middleName, input.lastName, input.suffix]
			.filter(Boolean)
			.join(" ") ||
		"";
	vc.fn.push(new FNProperty(fn));

	// N
	vc.n = new NProperty({
		familyNames: input.lastName ? [input.lastName] : [],
		givenNames: input.firstName ? [input.firstName] : [],
		additionalNames: input.middleName ? [input.middleName] : [],
		honorificPrefixes: input.prefix ? [input.prefix] : [],
		honorificSuffixes: input.suffix ? [input.suffix] : [],
	});

	// Emails
	for (const e of input.emails ?? []) {
		if (!e.value) continue;
		const p = new EmailProperty(e.value);
		if (e.type) p.type = [e.type];
		vc.email.push(p);
	}

	// Phones
	for (const t of input.phones ?? []) {
		if (!t.value) continue;
		const p = new TelProperty(t.value);
		if (t.type) p.type = [t.type];
		vc.tel.push(p);
	}

	// Addresses
	for (const a of input.addresses ?? []) {
		const p = new AdrProperty({
			postOfficeBox: "",
			extendedAddress: "",
			streetAddress: a.street,
			locality: a.city,
			region: a.region,
			postalCode: a.postcode,
			countryName: a.country,
		});
		if (a.type) p.type = [a.type];
		vc.adr.push(p);
	}

	// Org
	if (input.org) {
		vc.org.push(new OrgProperty({ name: input.org, units: [] }));
	}

	// Title
	if (input.title) {
		vc.title.push(new TitleProperty(input.title));
	}

	// Birthday — parse YYYY-MM-DD → DateAndOrTime
	if (input.birthday) {
		const parts = input.birthday.split("-").map(Number);
		if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
			vc.bday = new BDayProperty({
				year: parts[0],
				month: parts[1],
				day: parts[2],
				hasTime: false,
			});
		}
	}

	// Note
	if (input.note) {
		vc.note.push(new NoteProperty(input.note));
	}

	// Photo
	if (input.photo) {
		vc.photo.push(new PhotoProperty(input.photo));
	}

	// GEO — from first geocoded address
	const geocodedAdr = (input.addresses ?? []).find(
		(a) => a.geoLat != null && a.geoLon != null,
	);
	if (geocodedAdr) {
		vc.geo.push(GeoProperty.fromCoordinates(geocodedAdr.geoLat!, geocodedAdr.geoLon!));
	}

	// REV
	vc.rev = new RevProperty(new Date());

	return vc.toString();
}

// ── Utilities ──────────────────────────────────────────────────────────────

/** Build display name from VCard fields (for DB indexing) */
export function displayName(card: VCard): string {
	return (
		card.fn ||
		[card.firstName, card.lastName].filter(Boolean).join(" ") ||
		card.emails[0]?.value ||
		card.uid
	);
}

/**
 * Merge two VCards into a single VCardInput, using primary as the base.
 * Multi-value fields (emails, phones, addresses) are unioned (deduplicated).
 * Scalar fields prefer primary, falling back to secondary.
 * Notes are concatenated with a separator when both are non-empty and differ.
 * The merged result keeps the primary's UID.
 */
export function mergeVCards(primary: VCard, secondary: VCard): VCardInput {
	// emails: union by lowercase value
	const emailMap = new Map<string, VCardEmail>();
	for (const e of [...primary.emails, ...secondary.emails]) {
		const key = e.value.toLowerCase().trim();
		if (key && !emailMap.has(key)) emailMap.set(key, e);
	}

	// phones: union by digits-only key
	const phoneMap = new Map<string, VCardPhone>();
	for (const p of [...primary.phones, ...secondary.phones]) {
		const key = p.value.replace(/\D/g, "");
		if (key.length >= 4 && !phoneMap.has(key)) phoneMap.set(key, p);
	}

	// addresses: union by street+city+postcode
	const adrMap = new Map<string, VCardAddress>();
	for (const a of [...primary.addresses, ...secondary.addresses]) {
		const key = `${a.street}|${a.city}|${a.postcode}`.toLowerCase().trim();
		if (!adrMap.has(key)) adrMap.set(key, a);
	}

	// notes: concatenate if both present and different
	let note = primary.note || "";
	if (secondary.note && secondary.note !== primary.note) {
		note = note ? `${note}\n---\n${secondary.note}` : secondary.note;
	}

	return {
		uid: primary.uid,
		firstName: primary.firstName || secondary.firstName || undefined,
		lastName: primary.lastName || secondary.lastName || undefined,
		middleName: primary.middleName || secondary.middleName || undefined,
		prefix: primary.prefix || secondary.prefix || undefined,
		suffix: primary.suffix || secondary.suffix || undefined,
		fn: primary.fn || secondary.fn || undefined,
		emails: [...emailMap.values()],
		phones: [...phoneMap.values()],
		addresses: [...adrMap.values()],
		org: primary.org || secondary.org || undefined,
		title: primary.title || secondary.title || undefined,
		birthday: primary.birthday || secondary.birthday || undefined,
		note: note || undefined,
		photo: primary.photo || secondary.photo || undefined,
	};
}
