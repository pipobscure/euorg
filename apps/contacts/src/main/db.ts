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
import { mkdirSync } from "fs";
import { EUORG_DIR } from "@euorg/shared/euorg-accounts.ts";
import type { VCard } from "./vcard.ts";
import { displayName } from "./vcard.ts";

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
	}

	close() {
		this.db.close();
	}

	// ── Contacts ──────────────────────────────────────────────────────────────

	/**
	 * Returns all contacts whose collection_id is in the provided set,
	 * sorted by display_name. Pass enabledCollectionIds from accounts.json.
	 */
	getContacts(enabledCollectionIds: string[]): ContactRow[] {
		if (enabledCollectionIds.length === 0) return [];
		const placeholders = enabledCollectionIds.map(() => "?").join(",");
		return (
			this.db
				.query(
					`SELECT * FROM contacts
					 WHERE collection_id IN (${placeholders})
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

	/** href → etag map for a given collection (used for sync diffing) */
	getEtags(collectionId: string): Map<string, string> {
		const rows = this.db
			.query("SELECT href, etag FROM contacts WHERE collection_id=?")
			.all(collectionId) as any[];
		const map = new Map<string, string>();
		for (const r of rows) map.set(r.href, r.etag ?? "");
		return map;
	}

	upsertContact(
		card: VCard,
		collectionId: string,
		accountId: string,
		href: string,
		etag: string,
	): string {
		const vcfPath = join(VCARDS_DIR, `${encodeURIComponent(card.uid)}.vcf`);
		const dn = displayName(card);
		const emails = JSON.stringify(card.emails);
		const phones = JSON.stringify(card.phones);

		this.db.run(
			`INSERT INTO contacts
			   (uid, account_id, collection_id, etag, href, vcf_path, display_name, emails, phones, org, last_synced)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(uid) DO UPDATE SET
			   collection_id=excluded.collection_id, account_id=excluded.account_id,
			   etag=excluded.etag, href=excluded.href, vcf_path=excluded.vcf_path,
			   display_name=excluded.display_name, emails=excluded.emails,
			   phones=excluded.phones, org=excluded.org, last_synced=excluded.last_synced`,
			[card.uid, accountId, collectionId, etag, href, vcfPath, dn, emails, phones, card.org || null, Date.now()],
		);
		return vcfPath;
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
			const row = this.db.query("SELECT COUNT(*) as n FROM contacts").get() as any;
			return row?.n ?? 0;
		}
		const placeholders = enabledCollectionIds.map(() => "?").join(",");
		const row = this.db
			.query(`SELECT COUNT(*) as n FROM contacts WHERE collection_id IN (${placeholders})`)
			.get(...enabledCollectionIds) as any;
		return row?.n ?? 0;
	}
}

// ── Row mapper ────────────────────────────────────────────────────────────────

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
	};
}
