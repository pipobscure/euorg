/**
 * IMAP notes sync.
 *
 * Each note is stored as an email in the IMAP Notes folder with:
 *   X-Uniform-Type-Identifier: com.apple.mail-note  (Apple Notes compatible)
 *   X-Universally-Unique-Identifier: <uuid>          (our stable local UID)
 *
 * Strategy:
 *   1. fetchAll headers → diff against DB
 *   2. Download bodies for new messages only
 *   3. Push pending creates (APPEND) / updates (DELETE+APPEND) / deletes
 *
 * Bun compatibility: use fetchAll() not fetch() — avoids async iterator bug (#18492).
 */

import { ImapFlow } from "imapflow";
import type { NotesDB, NoteRow } from "./db.ts";
import type { EuorgAccount } from "@euorg/shared/euorg-accounts.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SyncProgress {
	phase: string;
	done: number;
	total: number;
	accountName?: string;
}

export interface SyncResult {
	added: number;
	updated: number;
	deleted: number;
	errors: string[];
}

// ── Network error detection ───────────────────────────────────────────────────

export function isNetworkError(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	const msg = e.message.toLowerCase();
	return (
		msg.includes("econnrefused") ||
		msg.includes("econnreset") ||
		msg.includes("etimedout") ||
		msg.includes("enotfound") ||
		msg.includes("network") ||
		msg.includes("connect") ||
		msg.includes("socket") ||
		msg.includes("timeout") ||
		(e as any).code === "ECONNREFUSED" ||
		(e as any).code === "ECONNRESET" ||
		(e as any).code === "ETIMEDOUT" ||
		(e as any).code === "ENOTFOUND"
	);
}

// ── Main sync entrypoint ──────────────────────────────────────────────────────

export async function syncAll(
	db: NotesDB,
	accounts: EuorgAccount[],
	onProgress: (p: SyncProgress) => void,
): Promise<SyncResult> {
	const result: SyncResult = { added: 0, updated: 0, deleted: 0, errors: [] };

	const imapAccounts = accounts.filter((a) => a.enabled && a.accountType === "imap");
	if (imapAccounts.length === 0) return result;

	for (const account of imapAccounts) {
		onProgress({ phase: "Connecting", done: 0, total: 1, accountName: account.name });
		try {
			const r = await syncAccount(db, account, onProgress);
			result.added += r.added;
			result.updated += r.updated;
			result.deleted += r.deleted;
			result.errors.push(...r.errors);
		} catch (e) {
			const msg = String(e instanceof Error ? e.message : e);
			console.error(`[sync] Account ${account.name} failed:`, e);
			result.errors.push(`${account.name}: ${msg}`);
		}
	}

	return result;
}

// ── Per-account sync ──────────────────────────────────────────────────────────

async function syncAccount(
	db: NotesDB,
	account: EuorgAccount,
	onProgress: (p: SyncProgress) => void,
): Promise<SyncResult> {
	const result: SyncResult = { added: 0, updated: 0, deleted: 0, errors: [] };
	const folder = account.imap?.notesFolder ?? "Notes";
	const port = account.imap?.port ?? 993;
	const secure = account.imap?.secure ?? true;

	const client = new ImapFlow({
		host: account.serverUrl,
		port,
		secure,
		auth: { user: account.username, pass: account.password },
		logger: false,
	});

	await client.connect();
	const lock = await client.getMailboxLock(folder);

	try {
		const mailbox = client.mailbox as any;
		const serverValidity = Number(mailbox?.uidValidity ?? 0);

		// Detect UIDVALIDITY reset — if changed, local UIDs are stale
		const storedValidity = db.getUidValidity(account.id, folder);
		if (storedValidity !== null && storedValidity !== serverValidity) {
			db.clearImapUids(account.id, folder);
			console.log(`[sync] UIDVALIDITY changed for ${account.name}/${folder}, resetting UIDs`);
		}
		if (serverValidity) db.setUidValidity(account.id, folder, serverValidity);

		// ── 1. Push pending changes first ─────────────────────────────────────

		const pendingCreates = db.getPendingNotes(account.id, "create");
		const pendingUpdates = db.getPendingNotes(account.id, "update");
		const pendingDeletes = db.getPendingNotes(account.id, "delete");
		const pendingTotal = pendingCreates.length + pendingUpdates.length + pendingDeletes.length;

		if (pendingTotal > 0) {
			onProgress({ phase: "Pushing changes", done: 0, total: pendingTotal, accountName: account.name });
		}

		let pushed = 0;
		for (const note of pendingCreates) {
			const raw = buildNoteMessage(note);
			const appendResult = await client.append(folder, raw, ["\\Seen"], new Date(note.modifiedAt));
			const newUid = (appendResult as any)?.uid ?? null;
			db.setImapUid(note.uid, newUid ? Number(newUid) : null);
			db.setPendingSync(note.uid, null);
			result.added++;
			onProgress({ phase: "Pushing changes", done: ++pushed, total: pendingTotal, accountName: account.name });
		}

		for (const note of pendingUpdates) {
			// Delete old message, append new version
			if (note.imapUid !== null) {
				await client.messageDelete(`${note.imapUid}`, { uid: true });
			}
			const raw = buildNoteMessage(note);
			const appendResult = await client.append(folder, raw, ["\\Seen"], new Date(note.modifiedAt));
			const newUid = (appendResult as any)?.uid ?? null;
			db.setImapUid(note.uid, newUid ? Number(newUid) : null);
			db.setPendingSync(note.uid, null);
			result.updated++;
			onProgress({ phase: "Pushing changes", done: ++pushed, total: pendingTotal, accountName: account.name });
		}

		for (const note of pendingDeletes) {
			if (note.imapUid !== null) {
				await client.messageDelete(`${note.imapUid}`, { uid: true });
			}
			db.deleteNote(note.uid);
			result.deleted++;
			onProgress({ phase: "Pushing changes", done: ++pushed, total: pendingTotal, accountName: account.name });
		}

		// ── 2. Fetch server headers ────────────────────────────────────────────

		const exists = (mailbox?.exists as number) ?? 0;
		if (exists === 0) return result;

		onProgress({ phase: "Fetching note list", done: 0, total: 1, accountName: account.name });

		// fetchAll avoids the Bun async iterator bug (imapflow issue #18492)
		const serverMsgs = await client.fetchAll("1:*", {
			uid: true,
			envelope: true,
			flags: true,
		});

		// Build map: imapUid → server message
		const serverByUid = new Map(serverMsgs.map((m) => [m.uid, m]));

		// DB notes for this account/folder (includes pending ones we just pushed)
		const dbNotes = db.getNotesByAccount(account.id, folder);
		const dbByImapUid = new Map(
			dbNotes.filter((n) => n.imapUid !== null).map((n) => [n.imapUid!, n]),
		);

		// UIDs on server that are not in our DB
		const newUids = [...serverByUid.keys()].filter((uid) => !dbByImapUid.has(uid));

		// DB notes with imapUid that no longer exist on server
		const deletedLocally = [...dbByImapUid.entries()]
			.filter(([uid]) => !serverByUid.has(uid))
			.map(([, note]) => note);

		// ── 3. Delete locally what server no longer has ────────────────────────

		for (const note of deletedLocally) {
			if (note.pendingSync === null) {
				db.deleteNote(note.uid);
				result.deleted++;
			}
		}

		// ── 4. Download new messages ───────────────────────────────────────────

		if (newUids.length > 0) {
			onProgress({ phase: "Downloading notes", done: 0, total: newUids.length, accountName: account.name });

			let done = 0;
			for (const imapUid of newUids) {
				try {
					const [fullMsg] = await client.fetchAll(`${imapUid}`, { uid: true, source: true }, { uid: true });
					if (!fullMsg?.source) continue;

					const raw = fullMsg.source.toString("utf8");
					const parsed = parseNoteMessage(raw);
					const now = new Date().toISOString();
					const noteUid = parsed.uuid || crypto.randomUUID();

					// Duplicate detection: if we already have a note with this UUID but a
					// different IMAP UID, one of them is an orphan left by a concurrent push.
					// Keep the higher IMAP UID (most recently appended), delete the other.
					if (parsed.uuid) {
						const existingNote = db.getNote(parsed.uuid);
						if (existingNote && existingNote.imapUid !== null && existingNote.imapUid !== imapUid) {
							if (imapUid > existingNote.imapUid) {
								// This server message is newer — delete the old orphan
								console.log(`[sync] Removing duplicate note IMAP UID ${existingNote.imapUid} (orphan, keeping ${imapUid})`);
								try { await client.messageDelete(`${existingNote.imapUid}`, { uid: true }); } catch {}
								db.setImapUid(existingNote.uid, imapUid);
							} else {
								// Existing is newer — delete this orphan from server
								console.log(`[sync] Removing duplicate note IMAP UID ${imapUid} (orphan, keeping ${existingNote.imapUid})`);
								try { await client.messageDelete(`${imapUid}`, { uid: true }); } catch {}
							}
							onProgress({ phase: "Downloading notes", done: ++done, total: newUids.length, accountName: account.name });
							continue;
						}
					}

					db.upsertNote({
						uid: noteUid,
						accountId: account.id,
						folder,
						imapUid,
						subject: parsed.subject || "Untitled",
						bodyHtml: parsed.bodyHtml || "",
						createdAt: parsed.date || now,
						modifiedAt: parsed.date || now,
						pendingSync: null,
						lastSynced: Date.now(),
						tags: [],
					});
					result.added++;
				} catch (e) {
					result.errors.push(`UID ${imapUid}: ${String(e instanceof Error ? e.message : e)}`);
				}
				onProgress({ phase: "Downloading notes", done: ++done, total: newUids.length, accountName: account.name });
			}
		}
	} finally {
		lock.release();
		await client.logout();
	}

	return result;
}

// ── MIME building ─────────────────────────────────────────────────────────────

export function buildNoteMessage(note: NoteRow): string {
	const date = formatRFC2822(new Date(note.modifiedAt));
	const subject = encodeSubject(note.subject || "Untitled");
	const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>${note.bodyHtml}</body></html>`;

	return [
		"MIME-Version: 1.0",
		`Date: ${date}`,
		`Subject: ${subject}`,
		"Content-Type: text/html; charset=UTF-8",
		"X-Uniform-Type-Identifier: com.apple.mail-note",
		`X-Universally-Unique-Identifier: ${note.uid}`,
		"",
		html,
	].join("\r\n");
}

// ── MIME parsing ──────────────────────────────────────────────────────────────

/** Decode a quoted-printable encoded string to UTF-8 text. */
function decodeQuotedPrintable(input: string): string {
	// Remove soft line breaks (= followed by CRLF or LF)
	const noSoftBreaks = input.replace(/=\r?\n/g, "");
	// Collect decoded bytes then interpret as UTF-8
	const bytes: number[] = [];
	let i = 0;
	while (i < noSoftBreaks.length) {
		if (noSoftBreaks[i] === "=" && i + 2 < noSoftBreaks.length) {
			const hex = noSoftBreaks.slice(i + 1, i + 3);
			if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
				bytes.push(parseInt(hex, 16));
				i += 3;
				continue;
			}
		}
		bytes.push(noSoftBreaks.charCodeAt(i));
		i++;
	}
	return Buffer.from(bytes).toString("utf8");
}

/** Split raw MIME text at the first blank line into headers + body. */
function splitHeadersBody(text: string): { headers: Record<string, string>; body: string } {
	const normalized = text.replace(/\r\n/g, "\n");
	const sepIdx = normalized.indexOf("\n\n");
	const headersRaw = sepIdx >= 0 ? normalized.slice(0, sepIdx) : normalized;
	const body = sepIdx >= 0 ? normalized.slice(sepIdx + 2) : "";

	const headers: Record<string, string> = {};
	let currentKey = "";
	for (const line of headersRaw.split("\n")) {
		if (/^[ \t]/.test(line)) {
			if (currentKey) headers[currentKey] += " " + line.trim();
		} else {
			const colon = line.indexOf(":");
			if (colon >= 0) {
				currentKey = line.slice(0, colon).toLowerCase();
				headers[currentKey] = line.slice(colon + 1).trim();
			}
		}
	}
	return { headers, body };
}

/** Decode a MIME body part based on its Content-Transfer-Encoding. */
function decodeBodyPart(body: string, encoding: string): string {
	const enc = encoding.toLowerCase().trim();
	if (enc === "quoted-printable") return decodeQuotedPrintable(body);
	if (enc === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
	return body;
}

/** Extract HTML from a raw MIME message — handles multipart/alternative and single-part. */
function extractHtmlFromMime(raw: string): string {
	const { headers, body } = splitHeadersBody(raw);
	const contentType = headers["content-type"] ?? "text/plain";
	const transferEncoding = headers["content-transfer-encoding"] ?? "7bit";

	if (/multipart\//i.test(contentType)) {
		const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
		if (!boundaryMatch) return extractBodyContent(body);
		const boundary = "--" + boundaryMatch[1].trim();

		// Walk lines, collecting each MIME part between boundary markers
		const lines = body.split(/\r?\n/);
		const parts: string[] = [];
		let current: string[] = [];
		let inPart = false;

		for (const line of lines) {
			if (line === boundary || line === boundary + "--") {
				if (inPart) parts.push(current.join("\n"));
				current = [];
				inPart = line !== boundary + "--";
			} else if (inPart) {
				current.push(line);
			}
		}

		let htmlContent: string | null = null;
		let textContent: string | null = null;

		for (const part of parts) {
			const { headers: ph, body: pb } = splitHeadersBody(part);
			const pt = ph["content-type"] ?? "text/plain";
			const pe = ph["content-transfer-encoding"] ?? "7bit";
			const decoded = decodeBodyPart(pb, pe);
			if (/text\/html/i.test(pt) && htmlContent === null) htmlContent = decoded;
			else if (/text\/plain/i.test(pt) && textContent === null) textContent = decoded;
		}

		if (htmlContent) return extractBodyContent(htmlContent);
		if (textContent) return textToHtml(textContent);
		return "";
	}

	// Single-part message
	const decoded = decodeBodyPart(body, transferEncoding);
	if (/text\/html/i.test(contentType)) return extractBodyContent(decoded);
	if (/text\/plain/i.test(contentType)) return textToHtml(decoded);
	return decoded;
}

function textToHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.split("\n")
		.map((line) => `<p>${line || "\u00a0"}</p>`)
		.join("");
}

export function parseNoteMessage(raw: string): {
	uuid: string;
	subject: string;
	date: string;
	bodyHtml: string;
} {
	const { headers } = splitHeadersBody(raw);

	const subject = decodeEncodedWords(headers["subject"] ?? "Untitled");
	const uuid = headers["x-universally-unique-identifier"] ?? "";
	const dateStr = headers["date"] ?? "";

	let date = new Date().toISOString();
	if (dateStr) {
		const d = new Date(dateStr);
		if (!isNaN(d.getTime())) date = d.toISOString();
	}

	const bodyHtml = extractHtmlFromMime(raw);

	return { uuid, subject, date, bodyHtml };
}

function extractBodyContent(html: string): string {
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (bodyMatch) return bodyMatch[1].trim();
	const stripped = html
		.replace(/<!DOCTYPE[^>]*>/i, "")
		.replace(/<html[^>]*>/i, "")
		.replace(/<\/html>/i, "")
		.replace(/<head[^>]*>[\s\S]*?<\/head>/i, "")
		.trim();
	return stripped || html;
}

function decodeEncodedWords(value: string): string {
	return value.replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, _charset, encoding, encoded) => {
		try {
			if (encoding.toUpperCase() === "B") {
				return Buffer.from(encoded, "base64").toString("utf8");
			} else {
				const qp = encoded.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
					String.fromCharCode(parseInt(hex, 16)),
				);
				return Buffer.from(qp, "binary").toString("utf8");
			}
		} catch {
			return encoded;
		}
	});
}

function encodeSubject(subject: string): string {
	// Encode non-ASCII characters as UTF-8 base64 encoded word
	if (!/[^\x20-\x7E]/.test(subject)) return subject;
	const encoded = Buffer.from(subject, "utf8").toString("base64");
	return `=?UTF-8?B?${encoded}?=`;
}

function formatRFC2822(date: Date): string {
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	const d = date.getUTCDate().toString().padStart(2, "0");
	const day = days[date.getUTCDay()];
	const month = months[date.getUTCMonth()];
	const year = date.getUTCFullYear();
	const hh = date.getUTCHours().toString().padStart(2, "0");
	const mm = date.getUTCMinutes().toString().padStart(2, "0");
	const ss = date.getUTCSeconds().toString().padStart(2, "0");
	return `${day}, ${d} ${month} ${year} ${hh}:${mm}:${ss} +0000`;
}

// ── IMAP connection test ──────────────────────────────────────────────────────

export async function testImapConnection(account: {
	serverUrl: string;
	port: number;
	secure: boolean;
	username: string;
	password: string;
}): Promise<string | null> {
	const client = new ImapFlow({
		host: account.serverUrl,
		port: account.port,
		secure: account.secure,
		auth: { user: account.username, pass: account.password },
		logger: false,
	});
	try {
		await client.connect();
		await client.logout();
		return null;
	} catch (e) {
		return String(e instanceof Error ? e.message : e);
	}
}
