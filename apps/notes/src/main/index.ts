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
import { NotesDB, type NoteRow } from "./db.ts";
import { syncAll, buildNoteMessage, testImapConnection, isNetworkError, type SyncProgress, type SyncResult } from "./sync.ts";

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

				// Try to push immediately if not already queued as create
				if (updated.pendingSync === "update") {
					try {
						const accounts = readAccounts().accounts;
						const account = accounts.find((a) => a.id === updated.accountId);
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
							const lock = await client.getMailboxLock(updated.folder);
							try {
								if (updated.imapUid !== null) {
									await client.messageDelete(`${updated.imapUid}`, { uid: true });
								}
								const raw = buildNoteMessage(updated);
								const appendResult = await client.append(updated.folder, raw, ["\\Seen"], new Date(updated.modifiedAt));
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
						console.log(`[offline] updateNote ${uid}: network error, will sync later`);
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
