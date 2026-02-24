/**
 * Contacts SQLite index.
 *
 * This database is a cache of contact data synced from CardDAV.
 * Account and collection configuration lives in ~/.euorg/accounts.json.
 * The vCard source files live in ~/.euorg/contacts/vcards/.
 *
 * Other euorg apps (mail, calendar) may open this DB read-only to look up
 * contacts without requiring the contacts app to be running.
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync, readFileSync } from "fs";
import { EUORG_DIR } from "@euorg/shared/euorg-accounts.ts";
import type { VCard } from "./vcard.ts";
import { displayName, parseVCard } from "./vcard.ts";

// ── Paths ─────────────────────────────────────────────────────────────────────

export const CONTACTS_DIR = join(EUORG_DIR, "contacts");
export const VCARDS_DIR = join(CONTACTS_DIR, "vcards");
export const DB_PATH = join(CONTACTS_DIR, "contacts.db");

mkdirSync(VCARDS_DIR, { recursive: true });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ContactRow {
	uid: string;
	accountId: string;
	collectionId: string;
	etag: string | null;
	href: string;
	vcfPath: string;
	displayName: string;
	emails: Array<{ value: string; type: string }>;
	phones: Array<{ value: string; type: string }>;
	org: string | null;
	lastSynced: number | null;
	/** null = synced; 'create' | 'update' | 'delete' | 'move' = pending server push */
	pendingSync: string | null;
}

export interface OfflineQueueItem {
	id: number;
	operation: "create" | "update" | "delete" | "move";
	uid: string;
	/** For create: the target collection id */
	collectionId: string | null;
	/** For move: target collection id */
	targetCollectionId: string | null;
	/** For move: old source collection id */
	sourceCollectionId: string | null;
	/** For move: old server href before move */
	sourceHref: string | null;
	/** For move: old server etag before move */
	sourceEtag: string | null;
	queuedAt: number;
}

// ── Database ──────────────────────────────────────────────────────────────────

export class ContactsDB {
	private db: Database;

	constructor() {
		this.db = new Database(DB_PATH);
		this.db.run("PRAGMA journal_mode=WAL");
		this.migrate();
	}

	private migrate() {
		// Drop legacy schema where accounts/collections were stored in SQLite.
		// Those now live in ~/.euorg/accounts.json. Contacts are just a cache
		// so dropping them here is safe — they will be re-synced.
		const hasOldAccounts = this.db
			.query("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'")
			.get();
		if (hasOldAccounts) {
			this.db.run("DROP TRIGGER IF EXISTS contacts_ai");
			this.db.run("DROP TRIGGER IF EXISTS contacts_ad");
			this.db.run("DROP TRIGGER IF EXISTS contacts_au");
			this.db.run("DROP TABLE IF EXISTS contacts_fts");
			this.db.run("DROP TABLE IF EXISTS contacts");
			this.db.run("DROP TABLE IF EXISTS collections");
			this.db.run("DROP TABLE IF EXISTS accounts");
			console.log("[db] Migrated: dropped legacy accounts/collections tables from SQLite.");
		}

		this.db.run(`
			CREATE TABLE IF NOT EXISTS contacts (
				uid          TEXT PRIMARY KEY,
				account_id   TEXT NOT NULL,
				collection_id TEXT NOT NULL,
				etag         TEXT,
				href         TEXT NOT NULL,
				vcf_path     TEXT NOT NULL,
				display_name TEXT NOT NULL DEFAULT '',
				emails       TEXT NOT NULL DEFAULT '[]',
				phones       TEXT NOT NULL DEFAULT '[]',
				org          TEXT,
				last_synced  INTEGER
			)
		`);

		// Add pending_sync column if it does not yet exist (migration for existing DBs).
		const hasPendingSync = this.db
			.query("SELECT name FROM pragma_table_info('contacts') WHERE name='pending_sync'")
			.get();
		if (!hasPendingSync) {
			this.db.run("ALTER TABLE contacts ADD COLUMN pending_sync TEXT DEFAULT NULL");
			console.log("[db] Migrated: added pending_sync column to contacts.");
		}

		// Add addresses column for cross-app location lookup (calendar etc.)
		const hasAddresses = this.db
			.query("SELECT name FROM pragma_table_info('contacts') WHERE name='addresses'")
			.get();
		if (!hasAddresses) {
			this.db.run("ALTER TABLE contacts ADD COLUMN addresses TEXT NOT NULL DEFAULT '[]'");
			console.log("[db] Migrated: added addresses column to contacts.");
			// Backfill addresses for all existing contacts by re-parsing their vCard files
			const rows = this.db.query<{ uid: string; vcf_path: string }, []>(
				"SELECT uid, vcf_path FROM contacts"
			).all();
			let backfilled = 0;
			for (const row of rows) {
				try {
					const raw = readFileSync(row.vcf_path, "utf8");
					const card = parseVCard(raw);
					if (card.addresses.length > 0) {
						this.db.run("UPDATE contacts SET addresses=? WHERE uid=?", [
							JSON.stringify(card.addresses),
							row.uid,
						]);
						backfilled++;
					}
				} catch {}
			}
			if (backfilled > 0) console.log(`[db] Backfilled addresses for ${backfilled} contacts.`);
		}

		this.db.run(`
			CREATE VIRTUAL TABLE IF NOT EXISTS contacts_fts USING fts5(
				uid UNINDEXED,
				display_name,
				emails,
				phones,
				org,
				content='contacts',
				content_rowid='rowid'
			)
		`);

		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS contacts_ai AFTER INSERT ON contacts BEGIN
				INSERT INTO contacts_fts(rowid, uid, display_name, emails, phones, org)
				VALUES (new.rowid, new.uid, new.display_name, new.emails, new.phones, new.org);
			END
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS contacts_ad AFTER DELETE ON contacts BEGIN
				INSERT INTO contacts_fts(contacts_fts, rowid, uid, display_name, emails, phones, org)
				VALUES('delete', old.rowid, old.uid, old.display_name, old.emails, old.phones, old.org);
			END
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS contacts_au AFTER UPDATE ON contacts BEGIN
				INSERT INTO contacts_fts(contacts_fts, rowid, uid, display_name, emails, phones, org)
				VALUES('delete', old.rowid, old.uid, old.display_name, old.emails, old.phones, old.org);
				INSERT INTO contacts_fts(rowid, uid, display_name, emails, phones, org)
				VALUES (new.rowid, new.uid, new.display_name, new.emails, new.phones, new.org);
			END
		`);

		// Offline queue: operations waiting to be pushed to the server.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS offline_queue (
				id                   INTEGER PRIMARY KEY AUTOINCREMENT,
				operation            TEXT NOT NULL CHECK(operation IN ('create', 'update', 'delete', 'move')),
				uid                  TEXT NOT NULL,
				collection_id        TEXT,
				target_collection_id TEXT,
				source_collection_id TEXT,
				source_href          TEXT,
				source_etag          TEXT,
				queued_at            INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
			)
		`);
	}

	close() {
		this.db.close();
	}

	// ── Contacts ──────────────────────────────────────────────────────────────

	/**
	 * Returns all contacts whose collection_id is in the provided set,
	 * sorted by display_name. Contacts pending server-side delete are excluded.
	 * Pass enabledCollectionIds from accounts.json.
	 */
	getContacts(enabledCollectionIds: string[]): ContactRow[] {
		if (enabledCollectionIds.length === 0) return [];
		const placeholders = enabledCollectionIds.map(() => "?").join(",");
		return (
			this.db
				.query(
					`SELECT * FROM contacts
					 WHERE collection_id IN (${placeholders})
					   AND (pending_sync IS NULL OR pending_sync != 'delete')
					 ORDER BY display_name COLLATE NOCASE`,
				)
				.all(...enabledCollectionIds) as any[]
		).map(rowToContact);
	}

	searchContacts(query: string, enabledCollectionIds: string[]): ContactRow[] {
		if (!query.trim()) return this.getContacts(enabledCollectionIds);
		if (enabledCollectionIds.length === 0) return [];
		const escaped = query.replace(/['"*]/g, " ").trim() + "*";
		const placeholders = enabledCollectionIds.map(() => "?").join(",");
		return (
			this.db
				.query(
					`SELECT * FROM contacts
					 WHERE collection_id IN (${placeholders})
					   AND (pending_sync IS NULL OR pending_sync != 'delete')
					   AND uid IN (SELECT uid FROM contacts_fts WHERE contacts_fts MATCH ?)
					 ORDER BY display_name COLLATE NOCASE`,
				)
				.all(...enabledCollectionIds, escaped) as any[]
		).map(rowToContact);
	}

	getContact(uid: string): ContactRow | null {
		const row = this.db.query("SELECT * FROM contacts WHERE uid=?").get(uid) as any;
		return row ? rowToContact(row) : null;
	}

	/**
	 * href → etag map for sync diffing.
	 * Excludes pending-create contacts (they have no server href yet).
	 */
	getEtags(collectionId: string): Map<string, string> {
		const rows = this.db
			.query(
				"SELECT href, etag FROM contacts WHERE collection_id=? AND (pending_sync IS NULL OR pending_sync != 'create')",
			)
			.all(collectionId) as any[];
		const map = new Map<string, string>();
		for (const r of rows) if (r.href) map.set(r.href, r.etag ?? "");
		return map;
	}

	/**
	 * Returns the set of hrefs for contacts with pending changes (update/delete/move).
	 * Used by syncCollection to skip overwriting local edits with server data.
	 */
	getPendingSyncHrefs(collectionId: string): Set<string> {
		const rows = this.db
			.query(
				"SELECT href FROM contacts WHERE collection_id=? AND pending_sync IS NOT NULL AND pending_sync != 'create'",
			)
			.all(collectionId) as any[];
		return new Set(rows.map((r: any) => r.href).filter(Boolean));
	}

	upsertContact(
		card: VCard,
		collectionId: string,
		accountId: string,
		href: string,
		etag: string,
		pendingSync?: string | null,
	): string {
		const vcfPath = join(VCARDS_DIR, `${encodeURIComponent(card.uid)}.vcf`);
		const dn = displayName(card);
		const emails = JSON.stringify(card.emails);
		const phones = JSON.stringify(card.phones);
		const addresses = JSON.stringify(card.addresses ?? []);
		const ps = pendingSync !== undefined ? pendingSync : null;

		this.db.run(
			`INSERT INTO contacts
			   (uid, account_id, collection_id, etag, href, vcf_path, display_name, emails, phones, addresses, org, last_synced, pending_sync)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(uid) DO UPDATE SET
			   collection_id=excluded.collection_id, account_id=excluded.account_id,
			   etag=excluded.etag, href=excluded.href, vcf_path=excluded.vcf_path,
			   display_name=excluded.display_name, emails=excluded.emails,
			   phones=excluded.phones, addresses=excluded.addresses, org=excluded.org,
			   last_synced=excluded.last_synced, pending_sync=excluded.pending_sync`,
			[card.uid, accountId, collectionId, etag, href, vcfPath, dn, emails, phones, addresses, card.org || null, Date.now(), ps],
		);
		return vcfPath;
	}

	setPendingSync(uid: string, state: string | null) {
		this.db.run("UPDATE contacts SET pending_sync=? WHERE uid=?", [state, uid]);
	}

	deleteContact(uid: string) {
		this.db.run("DELETE FROM contacts WHERE uid=?", [uid]);
	}

	deleteContactsByCollection(collectionId: string) {
		this.db.run("DELETE FROM contacts WHERE collection_id=?", [collectionId]);
	}

	deleteContactsByAccount(accountId: string) {
		this.db.run("DELETE FROM contacts WHERE account_id=?", [accountId]);
	}

	countContacts(enabledCollectionIds?: string[]): number {
		if (!enabledCollectionIds || enabledCollectionIds.length === 0) {
			const row = this.db
				.query("SELECT COUNT(*) as n FROM contacts WHERE pending_sync IS NULL OR pending_sync != 'delete'")
				.get() as any;
			return row?.n ?? 0;
		}
		const placeholders = enabledCollectionIds.map(() => "?").join(",");
		const row = this.db
			.query(
				`SELECT COUNT(*) as n FROM contacts
				 WHERE collection_id IN (${placeholders})
				   AND (pending_sync IS NULL OR pending_sync != 'delete')`,
			)
			.get(...enabledCollectionIds) as any;
		return row?.n ?? 0;
	}

	/** How many contacts have unsent local changes (all operations, including pending deletes). */
	getPendingCount(): number {
		const row = this.db.query("SELECT COUNT(*) as n FROM contacts WHERE pending_sync IS NOT NULL").get() as any;
		return row?.n ?? 0;
	}

	// ── Offline queue ─────────────────────────────────────────────────────────

	/** Returns the first queue entry for a uid (oldest queued operation). */
	getQueueEntry(uid: string): OfflineQueueItem | null {
		const row = this.db
			.query("SELECT * FROM offline_queue WHERE uid=? ORDER BY queued_at ASC LIMIT 1")
			.get(uid) as any;
		return row ? rowToQueueItem(row) : null;
	}

	/** All pending queue items in the order they were queued. */
	getOfflineQueue(): OfflineQueueItem[] {
		return (this.db.query("SELECT * FROM offline_queue ORDER BY queued_at ASC").all() as any[]).map(rowToQueueItem);
	}

	addToQueue(item: {
		operation: string;
		uid: string;
		collectionId?: string;
		targetCollectionId?: string;
		sourceCollectionId?: string;
		sourceHref?: string;
		sourceEtag?: string;
	}): number {
		const result = this.db.run(
			`INSERT INTO offline_queue
			   (operation, uid, collection_id, target_collection_id, source_collection_id, source_href, source_etag)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				item.operation,
				item.uid,
				item.collectionId ?? null,
				item.targetCollectionId ?? null,
				item.sourceCollectionId ?? null,
				item.sourceHref ?? null,
				item.sourceEtag ?? null,
			],
		);
		return result.lastInsertRowid as number;
	}

	removeFromQueue(id: number) {
		this.db.run("DELETE FROM offline_queue WHERE id=?", [id]);
	}

	/** Remove all queue entries for a given uid. */
	clearQueueForUid(uid: string) {
		this.db.run("DELETE FROM offline_queue WHERE uid=?", [uid]);
	}
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function rowToContact(r: any): ContactRow {
	return {
		uid: r.uid,
		accountId: r.account_id,
		collectionId: r.collection_id,
		etag: r.etag ?? null,
		href: r.href,
		vcfPath: r.vcf_path,
		displayName: r.display_name,
		emails: JSON.parse(r.emails ?? "[]"),
		phones: JSON.parse(r.phones ?? "[]"),
		org: r.org ?? null,
		lastSynced: r.last_synced ?? null,
		pendingSync: r.pending_sync ?? null,
	};
}

function rowToQueueItem(r: any): OfflineQueueItem {
	return {
		id: r.id,
		operation: r.operation,
		uid: r.uid,
		collectionId: r.collection_id ?? null,
		targetCollectionId: r.target_collection_id ?? null,
		sourceCollectionId: r.source_collection_id ?? null,
		sourceHref: r.source_href ?? null,
		sourceEtag: r.source_etag ?? null,
		queuedAt: r.queued_at,
	};
}
