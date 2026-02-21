/**
 * vCard v4.0 parser and serializer.
 * Handles the subset of fields used by this app.
 * Spec: RFC 6350
 */

export interface VCardEmail {
	value: string;
	type: string; // "work" | "home" | ""
}

export interface VCardPhone {
	value: string;
	type: string; // "cell" | "work" | "home" | "voice" | ""
}

export interface VCardAddress {
	street: string;
	city: string;
	region: string;
	postcode: string;
	country: string;
	type: string; // "home" | "work" | ""
}

export interface VCard {
	uid: string;
	fn: string; // formatted/display name
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
	rev: string; // revision timestamp
	raw: string; // original raw vCard text
}

// ── Parser ────────────────────────────────────────────────────────────────────

/** Unfold continuation lines (RFC 6350 §3.2) */
function unfold(text: string): string {
	return text.replace(/\r?\n[ \t]/g, "");
}

/** Split a property line into name+params and value */
function splitLine(line: string): { name: string; params: string[]; value: string } {
	const colonIdx = line.indexOf(":");
	if (colonIdx < 0) return { name: line, params: [], value: "" };

	const left = line.slice(0, colonIdx);
	const value = line.slice(colonIdx + 1);

	const parts = left.split(";");
	const name = parts[0].toUpperCase();
	const params = parts.slice(1).map((p) => p.toUpperCase());

	return { name, params, value };
}

/** Extract a TYPE parameter value from the params array */
function getType(params: string[]): string {
	for (const p of params) {
		if (p.startsWith("TYPE=")) {
			// May be TYPE=work or TYPE=WORK or TYPE=work,cell
			const types = p.slice(5).toLowerCase().split(",");
			// Return first recognizable type
			for (const t of types) {
				if (["work", "home", "cell", "voice", "text", "fax", "pager"].includes(t)) {
					return t;
				}
			}
		}
	}
	return "";
}

/** Decode a vCard value: unescape \n \, \; \: */
function decodeValue(v: string): string {
	return v
		.replace(/\\n/gi, "\n")
		.replace(/\\,/g, ",")
		.replace(/\\;/g, ";")
		.replace(/\\:/g, ":");
}

/** Parse N property: Last;First;Middle;Prefix;Suffix */
function parseN(value: string): {
	lastName: string;
	firstName: string;
	middleName: string;
	prefix: string;
	suffix: string;
} {
	const parts = value.split(";").map((p) => decodeValue(p.trim()));
	return {
		lastName: parts[0] ?? "",
		firstName: parts[1] ?? "",
		middleName: parts[2] ?? "",
		prefix: parts[3] ?? "",
		suffix: parts[4] ?? "",
	};
}

/** Parse ADR property: POBox;Extended;Street;City;Region;Postcode;Country */
function parseADR(value: string, params: string[]): VCardAddress {
	const parts = value.split(";").map((p) => decodeValue(p.trim()));
	return {
		street: parts[2] ?? "",
		city: parts[3] ?? "",
		region: parts[4] ?? "",
		postcode: parts[5] ?? "",
		country: parts[6] ?? "",
		type: getType(params),
	};
}

/** Decode BDAY: 19800101 or 1980-01-01 → YYYY-MM-DD */
function parseBday(value: string): string {
	const v = value.trim();
	if (/^\d{8}$/.test(v)) {
		return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
	}
	if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
		return v.slice(0, 10);
	}
	return v;
}

export function parseVCard(raw: string): VCard {
	const text = unfold(raw);
	const lines = text.split(/\r?\n/).filter((l) => l.trim());

	const card: VCard = {
		uid: "",
		fn: "",
		firstName: "",
		lastName: "",
		middleName: "",
		prefix: "",
		suffix: "",
		emails: [],
		phones: [],
		addresses: [],
		org: "",
		title: "",
		birthday: "",
		note: "",
		photo: "",
		rev: "",
		raw,
	};

	for (const line of lines) {
		if (line === "BEGIN:VCARD" || line === "END:VCARD") continue;

		const { name, params, value } = splitLine(line);

		switch (name) {
			case "UID":
				card.uid = decodeValue(value).trim();
				break;
			case "FN":
				card.fn = decodeValue(value).trim();
				break;
			case "N": {
				const n = parseN(value);
				card.lastName = n.lastName;
				card.firstName = n.firstName;
				card.middleName = n.middleName;
				card.prefix = n.prefix;
				card.suffix = n.suffix;
				if (!card.fn && (card.firstName || card.lastName)) {
					card.fn = [card.firstName, card.lastName].filter(Boolean).join(" ");
				}
				break;
			}
			case "EMAIL":
				if (value.trim()) {
					card.emails.push({ value: decodeValue(value).trim(), type: getType(params) });
				}
				break;
			case "TEL":
				if (value.trim()) {
					card.phones.push({ value: decodeValue(value).trim(), type: getType(params) });
				}
				break;
			case "ADR":
				card.addresses.push(parseADR(value, params));
				break;
			case "ORG":
				// ORG can be multi-component: OrgName;Unit
				card.org = decodeValue(value.split(";")[0]).trim();
				break;
			case "TITLE":
				card.title = decodeValue(value).trim();
				break;
			case "BDAY":
				card.birthday = parseBday(value);
				break;
			case "NOTE":
				card.note = decodeValue(value).trim();
				break;
			case "PHOTO": {
				const rawVal = value.trim();
				if (!rawVal) break;
				// vCard 4.0: value is already a data URI (data:image/...) or URL — use as-is
				// vCard 3.0: PHOTO;ENCODING=b;TYPE=JPEG:<raw-base64> — must build data URI
				const isBase64Encoded = params.some((p) => p === "ENCODING=B" || p === "ENCODING=BASE64");
				if (isBase64Encoded) {
					const typeParam = params.find((p) => p.startsWith("TYPE="));
					const ext = typeParam ? typeParam.slice(5).toLowerCase() : "jpeg";
					const mimeMap: Record<string, string> = {
						jpeg: "image/jpeg",
						jpg: "image/jpeg",
						png: "image/png",
						gif: "image/gif",
						webp: "image/webp",
					};
					const mimeType = mimeMap[ext] ?? `image/${ext}`;
					// Strip any whitespace that may have survived unfolding
					card.photo = `data:${mimeType};base64,${rawVal.replace(/\s/g, "")}`;
				} else {
					card.photo = rawVal;
				}
				break;
			}
			case "REV":
				card.rev = value.trim();
				break;
		}
	}

	// Ensure UID
	if (!card.uid) {
		card.uid = `urn:uuid:${crypto.randomUUID()}`;
	}

	return card;
}

// ── Serializer ────────────────────────────────────────────────────────────────

/** Encode a vCard value: escape special chars */
function encodeValue(v: string): string {
	return v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** Fold long lines at 75 octets (RFC 6350 §3.2) */
function fold(line: string): string {
	if (line.length <= 75) return line;
	const chunks: string[] = [];
	chunks.push(line.slice(0, 75));
	let pos = 75;
	while (pos < line.length) {
		chunks.push(" " + line.slice(pos, pos + 74));
		pos += 74;
	}
	return chunks.join("\r\n");
}

export interface VCardInput {
	uid?: string;
	firstName?: string;
	lastName?: string;
	middleName?: string;
	prefix?: string;
	suffix?: string;
	fn?: string; // if provided, used as-is; otherwise built from name parts
	emails?: VCardEmail[];
	phones?: VCardPhone[];
	addresses?: VCardAddress[];
	org?: string;
	title?: string;
	birthday?: string; // YYYY-MM-DD
	note?: string;
	photo?: string; // data URI or URL
}

export function serializeVCard(input: VCardInput): string {
	const uid = input.uid ?? `urn:uuid:${crypto.randomUUID()}`;
	const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

	const fn =
		input.fn ||
		[input.prefix, input.firstName, input.middleName, input.lastName, input.suffix]
			.filter(Boolean)
			.join(" ") ||
		"";

	const nParts = [
		input.lastName ?? "",
		input.firstName ?? "",
		input.middleName ?? "",
		input.prefix ?? "",
		input.suffix ?? "",
	].map(encodeValue);

	const lines: string[] = [
		"BEGIN:VCARD",
		"VERSION:4.0",
		`UID:${uid}`,
		fold(`FN:${encodeValue(fn)}`),
		fold(`N:${nParts.join(";")}`),
	];

	for (const email of input.emails ?? []) {
		if (!email.value) continue;
		const typeStr = email.type ? `;TYPE=${email.type}` : "";
		lines.push(fold(`EMAIL${typeStr}:${encodeValue(email.value)}`));
	}

	for (const phone of input.phones ?? []) {
		if (!phone.value) continue;
		const typeStr = phone.type ? `;TYPE=${phone.type}` : "";
		lines.push(fold(`TEL${typeStr}:${encodeValue(phone.value)}`));
	}

	for (const adr of input.addresses ?? []) {
		const typeStr = adr.type ? `;TYPE=${adr.type}` : "";
		const adrValue = [
			"", // POBox
			"", // Extended
			encodeValue(adr.street),
			encodeValue(adr.city),
			encodeValue(adr.region),
			encodeValue(adr.postcode),
			encodeValue(adr.country),
		].join(";");
		lines.push(fold(`ADR${typeStr}:${adrValue}`));
	}

	if (input.org) lines.push(fold(`ORG:${encodeValue(input.org)}`));
	if (input.title) lines.push(fold(`TITLE:${encodeValue(input.title)}`));
	if (input.birthday) lines.push(`BDAY:${input.birthday.replace(/-/g, "")}`);
	if (input.note) lines.push(fold(`NOTE:${encodeValue(input.note)}`));
	if (input.photo) lines.push(fold(`PHOTO:${input.photo}`));

	lines.push(`REV:${now}Z`);
	lines.push("END:VCARD");

	return lines.join("\r\n") + "\r\n";
}

/** Build display name from VCard fields (for DB indexing) */
export function displayName(card: VCard): string {
	return card.fn || [card.firstName, card.lastName].filter(Boolean).join(" ") || card.emails[0]?.value || card.uid;
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

	// phones: union by digits-only key (deduplicate different formatting of same number)
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
