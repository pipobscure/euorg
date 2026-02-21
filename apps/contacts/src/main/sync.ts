/**
 * Sync orchestrator — coordinates CardDAV fetching with local DB + vCard files.
 *
 * Accounts and credentials are read from ~/.euorg/accounts.json.
 * The SQLite DB is a pure cache; vCard files are written to ~/.euorg/contacts/vcards/.
 *
 * Sync strategy (per collection):
 *  1. List all hrefs+ETags from the CardDAV server
 *  2. Compare with DB — determine added / changed / deleted
 *  3. Fetch changed vCards, write .vcf files, upsert DB rows
 *  4. Remove locally-deleted contacts from DB + disk
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import {
	readAccounts,
	allEnabledCollections,
	type EuorgAccount,
	type CardDavCollection,
} from "@euorg/shared/euorg-accounts.ts";
import type { ContactsDB } from "./db.ts";
import * as carddav from "./carddav.ts";
import { parseVCard } from "./vcard.ts";

export interface SyncProgress {
	phase: "discovering" | "syncing" | "done";
	done: number;
	total: number;
	accountName?: string;
	collectionName?: string;
}

export interface SyncResult {
	added: number;
	updated: number;
	deleted: number;
	errors: string[];
}

export type ProgressCallback = (p: SyncProgress) => void;

// ── Main sync entry point ─────────────────────────────────────────────────────

export async function syncAll(db: ContactsDB, onProgress: ProgressCallback): Promise<SyncResult> {
	const result: SyncResult = { added: 0, updated: 0, deleted: 0, errors: [] };
	const cfg = readAccounts();
	const pairs = allEnabledCollections(cfg);

	let done = 0;

	for (const { account, collection } of pairs) {
		onProgress({
			phase: "syncing",
			done,
			total: done + 1,
			accountName: account.name,
			collectionName: collection.name,
		});

		try {
			const collResult = await syncCollection(db, account, collection, (p) =>
				onProgress({ ...p, accountName: account.name, collectionName: collection.name }),
			);
			result.added += collResult.added;
			result.updated += collResult.updated;
			result.deleted += collResult.deleted;
			result.errors.push(...collResult.errors);
		} catch (e) {
			const msg = `[${account.name}/${collection.name}] ${e instanceof Error ? e.message : String(e)}`;
			result.errors.push(msg);
			console.error("[sync]", msg);
		}

		done++;
	}

	onProgress({ phase: "done", done, total: done });
	return result;
}

// ── Per-collection sync ───────────────────────────────────────────────────────

async function syncCollection(
	db: ContactsDB,
	account: EuorgAccount,
	collection: CardDavCollection,
	onProgress: ProgressCallback,
): Promise<SyncResult> {
	const result: SyncResult = { added: 0, updated: 0, deleted: 0, errors: [] };

	const creds: carddav.CardDAVCredentials = {
		serverUrl: account.serverUrl,
		username: account.username,
		password: account.password,
	};

	const remoteEtags = await carddav.listEtags(collection.url, creds);
	const localEtags = db.getEtags(collection.id);

	const toFetch: string[] = [];
	const toDelete: string[] = [];

	for (const [href, remoteEtag] of remoteEtags) {
		const localEtag = localEtags.get(href);
		if (localEtag === undefined || localEtag !== remoteEtag) {
			toFetch.push(href);
		}
	}

	for (const [href] of localEtags) {
		if (!remoteEtags.has(href)) {
			toDelete.push(href);
		}
	}

	const total = toFetch.length + toDelete.length;
	let done = 0;

	for (const href of toFetch) {
		onProgress({ phase: "syncing", done, total });
		try {
			const { vcf, etag } = await carddav.fetchVCard(href, account.serverUrl, creds);
			const card = parseVCard(vcf);
			const vcfPath = db.upsertContact(card, collection.id, account.id, href, etag || remoteEtags.get(href) || "");
			writeFileSync(vcfPath, vcf, "utf8");
			if (localEtags.has(href)) result.updated++;
			else result.added++;
		} catch (e) {
			const msg = `fetch ${href}: ${e instanceof Error ? e.message : String(e)}`;
			result.errors.push(msg);
			console.error("[sync]", msg);
		}
		done++;
	}

	for (const href of toDelete) {
		onProgress({ phase: "syncing", done, total });
		try {
			const contacts = db.getContacts([collection.id]).filter((c) => c.href === href);
			if (contacts[0]) {
				db.deleteContact(contacts[0].uid);
				if (existsSync(contacts[0].vcfPath)) unlinkSync(contacts[0].vcfPath);
			}
			result.deleted++;
		} catch (e) {
			result.errors.push(`delete ${href}: ${e instanceof Error ? e.message : String(e)}`);
		}
		done++;
	}

	return result;
}

// ── Write operations (create / update / delete) ───────────────────────────────

export async function writeCreate(
	db: ContactsDB,
	vcfText: string,
	collectionId: string,
): Promise<{ uid: string }> {
	const cfg = readAccounts();
	const pair = allEnabledCollections(cfg).find(({ collection }) => collection.id === collectionId);
	if (!pair) throw new Error(`Collection ${collectionId} not found or disabled`);
	const { account, collection } = pair;

	const creds: carddav.CardDAVCredentials = {
		serverUrl: account.serverUrl,
		username: account.username,
		password: account.password,
	};

	const card = parseVCard(vcfText);
	const { href, etag } = await carddav.createContact(collection.url, card.uid, vcfText, creds);

	let finalVcf = vcfText;
	let finalEtag = etag;
	try {
		const fetched = await carddav.fetchVCard(href, account.serverUrl, creds);
		finalVcf = fetched.vcf;
		finalEtag = fetched.etag || etag;
	} catch {
		// use what we have
	}

	const finalCard = parseVCard(finalVcf);
	const vcfPath = db.upsertContact(finalCard, collection.id, account.id, href, finalEtag);
	writeFileSync(vcfPath, finalVcf, "utf8");

	return { uid: finalCard.uid };
}

export async function writeUpdate(db: ContactsDB, uid: string, vcfText: string): Promise<void> {
	const row = db.getContact(uid);
	if (!row) throw new Error(`Contact ${uid} not found`);

	const cfg = readAccounts();
	const account = cfg.accounts.find((a) => a.id === row.accountId);
	if (!account) throw new Error(`Account for contact ${uid} not found`);

	const creds: carddav.CardDAVCredentials = {
		serverUrl: account.serverUrl,
		username: account.username,
		password: account.password,
	};

	const newEtag = await carddav.updateContact(row.href, account.serverUrl, vcfText, row.etag ?? "", creds);

	let finalVcf = vcfText;
	let finalEtag = newEtag;
	try {
		const fetched = await carddav.fetchVCard(row.href, account.serverUrl, creds);
		finalVcf = fetched.vcf;
		finalEtag = fetched.etag || newEtag;
	} catch {
		// use what we have
	}

	const card = parseVCard(finalVcf);
	const vcfPath = db.upsertContact(card, row.collectionId, row.accountId, row.href, finalEtag);
	writeFileSync(vcfPath, finalVcf, "utf8");
}

export async function writeMove(
	db: ContactsDB,
	uid: string,
	targetCollectionId: string,
): Promise<void> {
	const row = db.getContact(uid);
	if (!row) throw new Error(`Contact ${uid} not found`);
	if (row.collectionId === targetCollectionId) return;

	const cfg = readAccounts();

	const srcAccount = cfg.accounts.find((a) => a.id === row.accountId);
	if (!srcAccount) throw new Error(`Source account for contact ${uid} not found`);

	const targetPair = allEnabledCollections(cfg).find(({ collection }) => collection.id === targetCollectionId);
	if (!targetPair) throw new Error(`Target collection ${targetCollectionId} not found or disabled`);
	const { account: dstAccount, collection: dstCollection } = targetPair;

	const srcCreds: carddav.CardDAVCredentials = {
		serverUrl: srcAccount.serverUrl,
		username: srcAccount.username,
		password: srcAccount.password,
	};
	const dstCreds: carddav.CardDAVCredentials = {
		serverUrl: dstAccount.serverUrl,
		username: dstAccount.username,
		password: dstAccount.password,
	};

	const vcfText = readFileSync(row.vcfPath, "utf8");

	// PUT to target collection first (so we don't lose data if delete fails)
	const { href: newHref, etag: newEtag } = await carddav.createContact(
		dstCollection.url,
		uid,
		vcfText,
		dstCreds,
	);

	let finalVcf = vcfText;
	let finalEtag = newEtag;
	try {
		const fetched = await carddav.fetchVCard(newHref, dstAccount.serverUrl, dstCreds);
		finalVcf = fetched.vcf;
		finalEtag = fetched.etag || newEtag;
	} catch {
		// use what we have
	}

	// DELETE from source only after successful PUT
	await carddav.deleteContact(row.href, srcAccount.serverUrl, row.etag ?? "", srcCreds);

	const card = parseVCard(finalVcf);
	db.upsertContact(card, dstCollection.id, dstAccount.id, newHref, finalEtag);
	writeFileSync(row.vcfPath, finalVcf, "utf8");
}

export async function writeDelete(db: ContactsDB, uid: string): Promise<void> {
	const row = db.getContact(uid);
	if (!row) return;

	const cfg = readAccounts();
	const account = cfg.accounts.find((a) => a.id === row.accountId);
	if (!account) throw new Error(`Account for contact ${uid} not found`);

	const creds: carddav.CardDAVCredentials = {
		serverUrl: account.serverUrl,
		username: account.username,
		password: account.password,
	};

	await carddav.deleteContact(row.href, account.serverUrl, row.etag ?? "", creds);

	db.deleteContact(uid);
	if (row.vcfPath && existsSync(row.vcfPath)) unlinkSync(row.vcfPath);
}

// ── Import / Export helpers ───────────────────────────────────────────────────

/**
 * Splits a (possibly multi-contact) vCard text into individual vCard strings.
 * Handles both CRLF and LF line endings.
 */
export function splitVCards(text: string): string[] {
	const results: string[] = [];
	let current = "";
	let inCard = false;

	for (const line of text.split(/\r?\n/)) {
		const upper = line.trimEnd().toUpperCase();
		if (upper === "BEGIN:VCARD") {
			inCard = true;
			current = line + "\n";
		} else if (upper === "END:VCARD") {
			if (inCard) {
				current += line + "\n";
				results.push(current.trim());
			}
			current = "";
			inCard = false;
		} else if (inCard) {
			current += line + "\n";
		}
	}

	return results.filter((v) => v.length > 0);
}

export interface ImportResult {
	imported: number;
	skipped: number;
	errors: string[];
}

/**
 * Imports all vCards in `vcfText` into the specified collection.
 * Contacts with a UID that already exists in the DB are skipped.
 */
export async function importVCards(
	db: ContactsDB,
	vcfText: string,
	collectionId: string,
): Promise<ImportResult> {
	const cards = splitVCards(vcfText);
	if (cards.length === 0) throw new Error("No valid vCards found in the file.");

	const cfg = readAccounts();
	const pair = allEnabledCollections(cfg).find(({ collection }) => collection.id === collectionId);
	if (!pair) throw new Error(`Collection ${collectionId} not found or disabled.`);

	let imported = 0;
	let skipped = 0;
	const errors: string[] = [];

	for (const vcf of cards) {
		try {
			const card = parseVCard(vcf);
			// Skip if already present locally
			if (db.getContact(card.uid)) {
				skipped++;
				continue;
			}
			await writeCreate(db, vcf, collectionId);
			imported++;
		} catch (e) {
			errors.push(e instanceof Error ? e.message : String(e));
		}
	}

	return { imported, skipped, errors };
}
