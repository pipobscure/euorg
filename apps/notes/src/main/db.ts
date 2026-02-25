/**
 * Notes SQLite index.
 *
 * This database is a cache of notes synced from IMAP.
 * Account configuration lives in ~/.euorg/accounts.json.
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync } from "fs";
import { EUORG_DIR } from "@euorg/shared/euorg-accounts.ts";

// ── Paths ─────────────────────────────────────────────────────────────────────

export const NOTES_DIR = join(EUORG_DIR, "notes");
export const DB_PATH = join(NOTES_DIR, "notes.db");
export const ATTACHMENTS_DIR = join(NOTES_DIR, "attachments");

mkdirSync(NOTES_DIR, { recursive: true });
mkdirSync(ATTACHMENTS_DIR, { recursive: true });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AttachmentRow {
	id: string;
	noteUid: string;
	filename: string;
	mimeType: string;
	size: number;
	storedPath: string;
}

export interface NoteRow {
	uid: string;
	accountId: string;
	folder: string;
	/** IMAP UID on the server; null if not yet pushed */
	imapUid: number | null;
	subject: string;
	bodyHtml: string;
	createdAt: string;
	modifiedAt: string;
	/** null = synced; 'create' | 'update' | 'delete' = pending server push */
	pendingSync: string | null;
	lastSynced: number | null;
	tags: string[];
	attachments: AttachmentRow[];
}

// ── Database ──────────────────────────────────────────────────────────────────

export class NotesDB {
	private db: Database;

	constructor() {
		this.db = new Database(DB_PATH);
		this.db.run("PRAGMA journal_mode=WAL");
		this.migrate();
	}

	private migrate() {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS notes (
				uid          TEXT PRIMARY KEY,
				account_id   TEXT NOT NULL,
				folder       TEXT NOT NULL DEFAULT 'Notes',
				imap_uid     INTEGER,
				subject      TEXT NOT NULL DEFAULT '',
				body_html    TEXT NOT NULL DEFAULT '',
				created_at   TEXT NOT NULL,
				modified_at  TEXT NOT NULL,
				pending_sync TEXT,
				last_synced  INTEGER
			)
		`);

		this.db.run(`
			CREATE TABLE IF NOT EXISTS imap_state (
				account_id  TEXT NOT NULL,
				folder      TEXT NOT NULL,
				uidvalidity INTEGER,
				PRIMARY KEY (account_id, folder)
			)
		`);

		// Add tags column to existing DBs (safe no-op if already present)
		try { this.db.run("ALTER TABLE notes ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'"); } catch {}

		this.db.run(`
			CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
				uid UNINDEXED,
				subject,
				body_html,
				content='notes',
				content_rowid='rowid'
			)
		`);

		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
				INSERT INTO notes_fts(rowid, uid, subject, body_html)
				VALUES (new.rowid, new.uid, new.subject, new.body_html);
			END
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
				INSERT INTO notes_fts(notes_fts, rowid, uid, subject, body_html)
				VALUES('delete', old.rowid, old.uid, old.subject, old.body_html);
			END
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
				INSERT INTO notes_fts(notes_fts, rowid, uid, subject, body_html)
				VALUES('delete', old.rowid, old.uid, old.subject, old.body_html);
				INSERT INTO notes_fts(rowid, uid, subject, body_html)
				VALUES (new.rowid, new.uid, new.subject, new.body_html);
			END
		`);

		// Attachments table
		this.db.run(`
			CREATE TABLE IF NOT EXISTS note_attachments (
				id          TEXT PRIMARY KEY,
				note_uid    TEXT NOT NULL,
				filename    TEXT NOT NULL,
				mime_type   TEXT NOT NULL,
				size        INTEGER NOT NULL,
				stored_path TEXT NOT NULL
			)
		`);
	}

	close() {
		this.db.close();
	}

	// ── Notes ──────────────────────────────────────────────────────────────────

	getNotes(accountIds?: string[]): NoteRow[] {
		const base = `
			SELECT uid, account_id, folder, imap_uid, subject, body_html,
			       created_at, modified_at, pending_sync, last_synced, tags
			FROM notes
			WHERE (pending_sync IS NULL OR pending_sync != 'delete')`;

		let rows: any[];
		if (!accountIds || accountIds.length === 0) {
			rows = this.db.query(base + " ORDER BY modified_at DESC").all() as any[];
		} else {
			const placeholders = accountIds.map(() => "?").join(",");
			rows = this.db
				.query(`${base} AND account_id IN (${placeholders}) ORDER BY modified_at DESC`)
				.all(...accountIds) as any[];
		}
		return rows.map((r) => this.rowToNote(r));
	}

	searchNotes(query: string, accountIds?: string[]): NoteRow[] {
		if (!query.trim()) return this.getNotes(accountIds);
		const escaped = query.replace(/['\"*]/g, " ").trim() + "*";

		const base = `
			SELECT n.uid, n.account_id, n.folder, n.imap_uid, n.subject, n.body_html,
			       n.created_at, n.modified_at, n.pending_sync, n.last_synced, n.tags
			FROM notes n
			WHERE (n.pending_sync IS NULL OR n.pending_sync != 'delete')
			  AND n.uid IN (SELECT uid FROM notes_fts WHERE notes_fts MATCH ?)`;

		let rows: any[];
		if (!accountIds || accountIds.length === 0) {
			rows = this.db.query(base + " ORDER BY n.modified_at DESC").all(escaped) as any[];
		} else {
			const placeholders = accountIds.map(() => "?").join(",");
			rows = this.db
				.query(`${base} AND n.account_id IN (${placeholders}) ORDER BY n.modified_at DESC`)
				.all(escaped, ...accountIds) as any[];
		}
		return rows.map((r) => this.rowToNote(r));
	}

	getNote(uid: string): NoteRow | null {
		const row = this.db
			.query(
				`SELECT uid, account_id, folder, imap_uid, subject, body_html,
				        created_at, modified_at, pending_sync, last_synced, tags
				 FROM notes WHERE uid=?`,
			)
			.get(uid) as any;
		return row ? this.rowToNote(row) : null;
	}

	upsertNote(note: NoteRow): void {
		this.db.run(
			`INSERT INTO notes
			   (uid, account_id, folder, imap_uid, subject, body_html, created_at, modified_at, pending_sync, last_synced, tags)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')
			 ON CONFLICT(uid) DO UPDATE SET
			   account_id=excluded.account_id, folder=excluded.folder,
			   imap_uid=excluded.imap_uid, subject=excluded.subject,
			   body_html=excluded.body_html, modified_at=excluded.modified_at,
			   pending_sync=excluded.pending_sync, last_synced=excluded.last_synced`,
			// tags intentionally excluded from UPDATE — preserve user-set tags across sync
			[
				note.uid,
				note.accountId,
				note.folder,
				note.imapUid ?? null,
				note.subject,
				note.bodyHtml,
				note.createdAt,
				note.modifiedAt,
				note.pendingSync ?? null,
				note.lastSynced ?? null,
			],
		);
	}

	setNoteTags(uid: string, tags: string[]): NoteRow | null {
		this.db.run("UPDATE notes SET tags=? WHERE uid=?", [JSON.stringify(tags), uid]);
		return this.getNote(uid);
	}

	setPendingSync(uid: string, state: string | null) {
		this.db.run("UPDATE notes SET pending_sync=? WHERE uid=?", [state, uid]);
	}

	setImapUid(uid: string, imapUid: number | null) {
		this.db.run("UPDATE notes SET imap_uid=? WHERE uid=?", [imapUid ?? null, uid]);
	}

	deleteNote(uid: string) {
		this.db.run("DELETE FROM notes WHERE uid=?", [uid]);
	}

	deleteNotesByAccount(accountId: string) {
		this.db.run("DELETE FROM notes WHERE account_id=?", [accountId]);
	}

	getNotesByAccount(accountId: string, folder: string): NoteRow[] {
		return (
			this.db
				.query(
					`SELECT uid, account_id, folder, imap_uid, subject, body_html,
					        created_at, modified_at, pending_sync, last_synced, tags
					 FROM notes WHERE account_id=? AND folder=?`,
				)
				.all(accountId, folder) as any[]
		).map((r) => this.rowToNote(r));
	}

	getPendingNotes(accountId: string, operation: string): NoteRow[] {
		return (
			this.db
				.query(
					`SELECT uid, account_id, folder, imap_uid, subject, body_html,
					        created_at, modified_at, pending_sync, last_synced, tags
					 FROM notes WHERE account_id=? AND pending_sync=?`,
				)
				.all(accountId, operation) as any[]
		).map((r) => this.rowToNote(r));
	}

	countNotes(accountIds?: string[]): number {
		if (!accountIds || accountIds.length === 0) {
			const row = this.db
				.query("SELECT COUNT(*) as n FROM notes WHERE pending_sync IS NULL OR pending_sync != 'delete'")
				.get() as any;
			return row?.n ?? 0;
		}
		const placeholders = accountIds.map(() => "?").join(",");
		const row = this.db
			.query(
				`SELECT COUNT(*) as n FROM notes
				 WHERE account_id IN (${placeholders})
				   AND (pending_sync IS NULL OR pending_sync != 'delete')`,
			)
			.get(...accountIds) as any;
		return row?.n ?? 0;
	}

	// ── IMAP state ─────────────────────────────────────────────────────────────

	getUidValidity(accountId: string, folder: string): number | null {
		const row = this.db
			.query("SELECT uidvalidity FROM imap_state WHERE account_id=? AND folder=?")
			.get(accountId, folder) as any;
		return row?.uidvalidity ?? null;
	}

	setUidValidity(accountId: string, folder: string, uidvalidity: number) {
		this.db.run(
			`INSERT INTO imap_state (account_id, folder, uidvalidity) VALUES (?, ?, ?)
			 ON CONFLICT(account_id, folder) DO UPDATE SET uidvalidity=excluded.uidvalidity`,
			[accountId, folder, uidvalidity],
		);
	}

	clearImapUids(accountId: string, folder: string) {
		this.db.run("UPDATE notes SET imap_uid=NULL WHERE account_id=? AND folder=?", [accountId, folder]);
	}

	// ── Attachments ────────────────────────────────────────────────────────────

	getAttachments(noteUid: string): AttachmentRow[] {
		return (
			this.db
				.query("SELECT id, note_uid, filename, mime_type, size, stored_path FROM note_attachments WHERE note_uid=?")
				.all(noteUid) as any[]
		).map(rowToAttachment);
	}

	addAttachmentRow(row: AttachmentRow): void {
		this.db.run(
			`INSERT INTO note_attachments (id, note_uid, filename, mime_type, size, stored_path)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   filename=excluded.filename, mime_type=excluded.mime_type,
			   size=excluded.size, stored_path=excluded.stored_path`,
			[row.id, row.noteUid, row.filename, row.mimeType, row.size, row.storedPath],
		);
	}

	removeAttachment(id: string): AttachmentRow | null {
		const row = this.db
			.query("SELECT id, note_uid, filename, mime_type, size, stored_path FROM note_attachments WHERE id=?")
			.get(id) as any;
		if (!row) return null;
		this.db.run("DELETE FROM note_attachments WHERE id=?", [id]);
		return rowToAttachment(row);
	}

	removeAttachmentsByNote(noteUid: string): AttachmentRow[] {
		const rows = (
			this.db
				.query("SELECT id, note_uid, filename, mime_type, size, stored_path FROM note_attachments WHERE note_uid=?")
				.all(noteUid) as any[]
		).map(rowToAttachment);
		this.db.run("DELETE FROM note_attachments WHERE note_uid=?", [noteUid]);
		return rows;
	}

	getAttachmentById(id: string): AttachmentRow | null {
		const row = this.db
			.query("SELECT id, note_uid, filename, mime_type, size, stored_path FROM note_attachments WHERE id=?")
			.get(id) as any;
		return row ? rowToAttachment(row) : null;
	}

	// ── Row mapper ─────────────────────────────────────────────────────────────

	private rowToNote(r: any): NoteRow {
		const uid = r.uid;
		return {
			uid,
			accountId: r.account_id,
			folder: r.folder,
			imapUid: r.imap_uid ?? null,
			subject: r.subject,
			bodyHtml: r.body_html,
			createdAt: r.created_at,
			modifiedAt: r.modified_at,
			pendingSync: r.pending_sync ?? null,
			lastSynced: r.last_synced ?? null,
			tags: JSON.parse(r.tags || "[]"),
			attachments: this.getAttachments(uid),
		};
	}
}

// ── Row mapper ────────────────────────────────────────────────────────────────

function rowToAttachment(r: any): AttachmentRow {
	return {
		id: r.id,
		noteUid: r.note_uid,
		filename: r.filename,
		mimeType: r.mime_type,
		size: r.size,
		storedPath: r.stored_path,
	};
}
