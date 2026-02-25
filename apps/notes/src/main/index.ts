import { BrowserWindow, BrowserView, type ElectrobunRPCSchema, type RPCSchema } from "electrobun/bun";
import {
	readAccounts,
	writeAccounts,
	getAccount,
	upsertAccount,
	removeAccount,
	type EuorgAccount,
	type ImapConfig,
} from "@euorg/shared/euorg-accounts.ts";
import { getKeystoreType, setKeystoreType, type KeystoreType } from "@euorg/shared/keystore.ts";
import { NotesDB, type NoteRow, ATTACHMENTS_DIR } from "./db.ts";
import { syncAll, buildNoteMessage, testImapConnection, isNetworkError, type SyncProgress, type SyncResult } from "./sync.ts";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, copyFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── View types (password omitted) ─────────────────────────────────────────────

interface AccountView {
	id: string;
	name: string;
	host: string;
	port: number;
	secure: boolean;
	username: string;
	enabled: boolean;
	notesFolder: string;
}

// ── RPC schema ────────────────────────────────────────────────────────────────

interface NotesRPCSchema extends ElectrobunRPCSchema {
	bun: RPCSchema<{
		requests: {
			getNotes: { params: void; response: NoteRow[] };
			searchNotes: { params: { query: string }; response: NoteRow[] };
			getNote: { params: { uid: string }; response: NoteRow | null };
			createNote: { params: { subject: string; bodyHtml: string; accountId: string }; response: NoteRow | null };
			updateNote: { params: { uid: string; subject?: string; bodyHtml?: string }; response: NoteRow | null };
			deleteNote: { params: { uid: string }; response: void };
			getAccounts: { params: void; response: AccountView[] };
			addAccount: {
				params: { name: string; host: string; port: number; secure: boolean; username: string; password: string; notesFolder: string };
				response: AccountView;
			};
			updateAccount: {
				params: { id: string; name?: string; host?: string; port?: number; secure?: boolean; username?: string; password?: string; enabled?: boolean; notesFolder?: string };
				response: AccountView;
			};
			deleteAccount: { params: { id: string }; response: void };
			testAccount: {
				params: { host: string; port: number; secure: boolean; username: string; password: string };
				response: { ok: boolean; error?: string };
			};
			triggerSync: { params: void; response: void };
			getNoteCount: { params: void; response: number };
			getKeystoreType: { params: void; response: KeystoreType };
			setKeystoreType: { params: { type: KeystoreType }; response: void };
			setNoteTags: { params: { uid: string; tags: string[] }; response: NoteRow | null };
			logError: { params: { message: string; source?: string; lineno?: number }; response: void };
			addAttachment: { params: { uid: string; filename: string; mimeType: string; data: string }; response: NoteRow | null };
			removeAttachment: { params: { uid: string; attachmentId: string }; response: NoteRow | null };
			openAttachment: { params: { attachmentId: string }; response: void };
			getAttachmentData: { params: { attachmentId: string }; response: { data: string; mimeType: string; filename: string } | null };
			openUrl: { params: { url: string }; response: void };
			saveAttachment: { params: { attachmentId: string }; response: string | null };
		};
		messages: {};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			syncProgress: SyncProgress;
			syncComplete: SyncResult;
			noteChanged: { uid: string; action: "created" | "updated" | "deleted" };
		};
	}>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function accountToView(a: EuorgAccount): AccountView {
	return {
		id: a.id,
		name: a.name,
		host: a.serverUrl,
		port: a.imap?.port ?? 993,
		secure: a.imap?.secure ?? true,
		username: a.username,
		enabled: a.enabled,
		notesFolder: a.imap?.notesFolder ?? "Notes",
	};
}

function enabledImapAccountIds(accounts: EuorgAccount[]): string[] {
	return accounts.filter((a) => a.enabled && a.accountType === "imap").map((a) => a.id);
}

// ── Database ──────────────────────────────────────────────────────────────────

const db = new NotesDB();

// ── File helpers ──────────────────────────────────────────────────────────────

function openWithSystemApp(filePath: string) {
	const cmd =
		process.platform === "darwin" ? "open"
		: process.platform === "win32" ? "explorer"
		: "xdg-open";
	Bun.spawn([cmd, filePath], { stdout: "ignore", stderr: "ignore" });
}

/** Returns the user's Downloads directory, cross-platform. */
function getDownloadsDir(): string {
	if (process.platform === "win32") {
		return join(process.env.USERPROFILE ?? homedir(), "Downloads");
	}
	const xdg = process.env.XDG_DOWNLOAD_DIR;
	if (xdg) return xdg;
	return join(homedir(), "Downloads");
}

/** Push a note's current state (with attachments) to IMAP. Caller holds the pendingPushes lock. */
async function pushNoteToImap(uid: string) {
	const current = db.getNote(uid);
	if (!current || current.pendingSync !== "update") return;
	const account = readAccounts().accounts.find((a) => a.id === current.accountId);
	if (!account) return;
	const { ImapFlow } = await import("imapflow");
	const client = new ImapFlow({
		host: account.serverUrl,
		port: account.imap?.port ?? 993,
		secure: account.imap?.secure ?? true,
		auth: { user: account.username, pass: account.password },
		logger: false,
	});
	await client.connect();
	const lock = await client.getMailboxLock(current.folder);
	try {
		if (current.imapUid !== null) {
			await client.messageDelete(`${current.imapUid}`, { uid: true });
		}
		const raw = buildNoteMessage(current);
		const appendResult = await client.append(current.folder, raw, ["\\Seen"], new Date(current.modifiedAt));
		const newUid = (appendResult as any)?.uid ?? null;
		db.setImapUid(uid, newUid ? Number(newUid) : null);
		db.setPendingSync(uid, null);
	} finally {
		lock.release();
		await client.logout();
	}
}

// ── Per-note IMAP push lock ────────────────────────────────────────────────────
// Prevents concurrent immediate-push operations for the same note, which would
// cause the same UID to be deleted by both, then two orphaned messages appended.
const pendingPushes = new Set<string>();

// ── RPC ───────────────────────────────────────────────────────────────────────

const rpc = BrowserView.defineRPC<NotesRPCSchema>({
	handlers: {
		requests: {
			// ── Notes ───────────────────────────────────────────────────────────
			async getNotes() {
				const ids = enabledImapAccountIds(readAccounts().accounts);
				return db.getNotes(ids);
			},

			async searchNotes({ query }) {
				const ids = enabledImapAccountIds(readAccounts().accounts);
				return db.searchNotes(query, ids);
			},

			async getNote({ uid }) {
				return db.getNote(uid);
			},

			async createNote({ subject, bodyHtml, accountId }) {
				const uid = crypto.randomUUID();
				const now = new Date().toISOString();
				const note: NoteRow = {
					uid,
					accountId,
					folder: readAccounts().accounts.find((a) => a.id === accountId)?.imap?.notesFolder ?? "Notes",
					imapUid: null,
					subject,
					bodyHtml,
					createdAt: now,
					modifiedAt: now,
					pendingSync: "create",
					lastSynced: null,
				};
				db.upsertNote(note);

				// Try to push immediately
				try {
					const accounts = readAccounts().accounts;
					const account = accounts.find((a) => a.id === accountId);
					if (account) {
						const { ImapFlow } = await import("imapflow");
						const client = new ImapFlow({
							host: account.serverUrl,
							port: account.imap?.port ?? 993,
							secure: account.imap?.secure ?? true,
							auth: { user: account.username, pass: account.password },
							logger: false,
						});
						await client.connect();
						const lock = await client.getMailboxLock(note.folder);
						try {
							const raw = buildNoteMessage(note);
							const appendResult = await client.append(note.folder, raw, ["\\Seen"], new Date(now));
							const newUid = (appendResult as any)?.uid ?? null;
							db.setImapUid(uid, newUid ? Number(newUid) : null);
							db.setPendingSync(uid, null);
						} finally {
							lock.release();
							await client.logout();
						}
					}
				} catch (e) {
					if (!isNetworkError(e)) throw e;
					console.log(`[offline] createNote: network error, will sync later`);
				}

				rpc.send("noteChanged", { uid, action: "created" });
				return db.getNote(uid);
			},

			async updateNote({ uid, subject, bodyHtml }) {
				const existing = db.getNote(uid);
				if (!existing) throw new Error(`Note ${uid} not found`);

				const updated: NoteRow = {
					...existing,
					subject: subject !== undefined ? subject : existing.subject,
					bodyHtml: bodyHtml !== undefined ? bodyHtml : existing.bodyHtml,
					modifiedAt: new Date().toISOString(),
					pendingSync: existing.pendingSync === "create" ? "create" : "update",
				};
				db.upsertNote(updated);

				// Try to push immediately if not already queued as create and no push in flight.
				// The lock prevents concurrent IMAP pushes for the same note, which would cause
				// both calls to see the same old imapUid, both DELETE it (second is a no-op),
				// then both APPEND — leaving an orphaned duplicate on the server.
				if (updated.pendingSync === "update" && !pendingPushes.has(uid)) {
					pendingPushes.add(uid);
					try {
						// Re-read fresh state and push via shared helper (includes attachments)
						await pushNoteToImap(uid);
					} catch (e) {
						if (!isNetworkError(e)) throw e;
						console.log(`[offline] updateNote ${uid}: network error, will sync later`);
					} finally {
						pendingPushes.delete(uid);
					}
				}

				rpc.send("noteChanged", { uid, action: "updated" });
				return db.getNote(uid);
			},

			async deleteNote({ uid }) {
				const existing = db.getNote(uid);
				if (!existing) return;

				if (existing.pendingSync === "create") {
					// Never pushed to server — delete locally
					db.deleteNote(uid);
				} else {
					// Mark for server deletion
					db.setPendingSync(uid, "delete");

					try {
						const accounts = readAccounts().accounts;
						const account = accounts.find((a) => a.id === existing.accountId);
						if (account && existing.imapUid !== null) {
							const { ImapFlow } = await import("imapflow");
							const client = new ImapFlow({
								host: account.serverUrl,
								port: account.imap?.port ?? 993,
								secure: account.imap?.secure ?? true,
								auth: { user: account.username, pass: account.password },
								logger: false,
							});
							await client.connect();
							const lock = await client.getMailboxLock(existing.folder);
							try {
								await client.messageDelete(`${existing.imapUid}`, { uid: true });
								db.deleteNote(uid);
							} finally {
								lock.release();
								await client.logout();
							}
						}
					} catch (e) {
						if (!isNetworkError(e)) throw e;
						console.log(`[offline] deleteNote ${uid}: network error, will sync later`);
					}
				}

				rpc.send("noteChanged", { uid, action: "deleted" });
			},

			// ── Accounts ────────────────────────────────────────────────────────
			async getAccounts() {
				return readAccounts()
					.accounts.filter((a) => a.accountType === "imap")
					.map(accountToView);
			},

			async addAccount({ name, host, port, secure, username, password, notesFolder }) {
				const id = crypto.randomUUID();
				const newAccount: EuorgAccount = {
					id,
					accountType: "imap",
					name,
					serverUrl: host,
					username,
					password,
					enabled: true,
					imap: { port, secure, notesFolder: notesFolder || "Notes" },
				};
				const cfg = readAccounts();
				writeAccounts(upsertAccount(cfg, newAccount));
				return accountToView(newAccount);
			},

			async updateAccount({ id, name, host, port, secure, username, password, enabled, notesFolder }) {
				const cfg = readAccounts();
				const existing = getAccount(cfg, id);
				if (!existing) throw new Error(`Account ${id} not found`);

				const updated: EuorgAccount = {
					...existing,
					...(name !== undefined && { name }),
					...(host !== undefined && { serverUrl: host }),
					...(username !== undefined && { username }),
					...(password !== undefined && { password }),
					...(enabled !== undefined && { enabled }),
					imap: {
						port: port ?? existing.imap?.port ?? 993,
						secure: secure ?? existing.imap?.secure ?? true,
						notesFolder: notesFolder ?? existing.imap?.notesFolder ?? "Notes",
					},
				};
				writeAccounts(upsertAccount(cfg, updated));
				return accountToView(updated);
			},

			async deleteAccount({ id }) {
				writeAccounts(removeAccount(readAccounts(), id));
				db.deleteNotesByAccount(id);
			},

			async testAccount({ host, port, secure, username, password }) {
				const error = await testImapConnection({ serverUrl: host, port, secure, username, password });
				return { ok: error === null, error: error ?? undefined };
			},

			// ── Sync ────────────────────────────────────────────────────────────
			async triggerSync() {
				const accounts = readAccounts().accounts;
				syncAll(db, accounts, (p) => rpc.send("syncProgress", p))
					.then((result) => rpc.send("syncComplete", result))
					.catch((e) =>
						rpc.send("syncComplete", { added: 0, updated: 0, deleted: 0, errors: [String(e)] }),
					);
			},

			async getNoteCount() {
				const ids = enabledImapAccountIds(readAccounts().accounts);
				return db.countNotes(ids);
			},

			async getKeystoreType() {
				return getKeystoreType();
			},

			async setKeystoreType({ type }) {
				setKeystoreType(type);
			},

			async setNoteTags({ uid, tags }) {
				return db.setNoteTags(uid, tags);
			},

			async logError({ message, source, lineno }) {
				console.error(`[webview]`, message, source ? `(${source}:${lineno})` : "");
			},

			// ── Attachments ─────────────────────────────────────────────────────
			async addAttachment({ uid, filename, mimeType, data }) {
				const existing = db.getNote(uid);
				if (!existing) return null;

				const attachmentId = crypto.randomUUID();
				const attDir = join(ATTACHMENTS_DIR, uid);
				mkdirSync(attDir, { recursive: true });
				const storedPath = join(attDir, `${attachmentId}_${filename}`);
				writeFileSync(storedPath, Buffer.from(data, "base64"));

				db.addAttachmentRow({ id: attachmentId, noteUid: uid, filename, mimeType,
					size: Buffer.from(data, "base64").length, storedPath });

				// Mark note as pending update so the attachment travels to IMAP
				const pendingState = existing.pendingSync === "create" ? "create" : "update";
				db.setPendingSync(uid, pendingState);
				if (pendingState === "update" && !pendingPushes.has(uid)) {
					pendingPushes.add(uid);
					pushNoteToImap(uid).finally(() => pendingPushes.delete(uid));
				}

				rpc.send("noteChanged", { uid, action: "updated" });
				return db.getNote(uid);
			},

			async removeAttachment({ uid, attachmentId }) {
				const att = db.removeAttachment(attachmentId);
				if (att) {
					try { unlinkSync(att.storedPath); } catch {}
				}

				const existing = db.getNote(uid);
				if (existing) {
					const pendingState = existing.pendingSync === "create" ? "create" : "update";
					db.setPendingSync(uid, pendingState);
					if (pendingState === "update" && !pendingPushes.has(uid)) {
						pendingPushes.add(uid);
						pushNoteToImap(uid).finally(() => pendingPushes.delete(uid));
					}
				}

				rpc.send("noteChanged", { uid, action: "updated" });
				return db.getNote(uid);
			},

			async openAttachment({ attachmentId }) {
				const att = db.getAttachmentById(attachmentId);
				if (!att) return;
				openWithSystemApp(att.storedPath);
			},

			async getAttachmentData({ attachmentId }) {
				const att = db.getAttachmentById(attachmentId);
				if (!att || !existsSync(att.storedPath)) return null;
				const data = readFileSync(att.storedPath).toString("base64");
				return { data, mimeType: att.mimeType, filename: att.filename };
			},

			async openUrl({ url }) {
				openWithSystemApp(url);
			},

			async saveAttachment({ attachmentId }) {
				const att = db.getAttachmentById(attachmentId);
				if (!att || !existsSync(att.storedPath)) return null;
				const downloadsDir = getDownloadsDir();
				mkdirSync(downloadsDir, { recursive: true });
				// Avoid clobbering existing files with the same name
				let dest = join(downloadsDir, att.filename);
				if (existsSync(dest)) {
					const ext = att.filename.lastIndexOf(".");
					const base = ext >= 0 ? att.filename.slice(0, ext) : att.filename;
					const suffix = ext >= 0 ? att.filename.slice(ext) : "";
					dest = join(downloadsDir, `${base} (copy)${suffix}`);
				}
				copyFileSync(att.storedPath, dest);
				return dest;
			},
		},

		messages: {},
	},
});

// ── Window ────────────────────────────────────────────────────────────────────

new BrowserWindow({
	title: "Notes",
	url: "views://notes/index.html",
	frame: { width: 1100, height: 760, x: 80, y: 80 },
	rpc,
});

// ── Startup sync ──────────────────────────────────────────────────────────────

setTimeout(() => {
	const accounts = readAccounts().accounts;
	syncAll(db, accounts, (p) => rpc.send("syncProgress", p))
		.then((result) => rpc.send("syncComplete", result))
		.catch((e) => {
			console.error("[startup sync]", e);
			rpc.send("syncComplete", { added: 0, updated: 0, deleted: 0, errors: [String(e)] });
		});
}, 1500);
