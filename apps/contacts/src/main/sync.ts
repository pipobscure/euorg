/**
 * Sync orchestrator — coordinates CardDAV fetching with local DB + vCard files.
 *
 * Accounts and credentials are read from ~/.euorg/accounts.json.
 * The SQLite DB is a pure cache; vCard files are written to ~/.euorg/contacts/vcards/.
 *
 * Sync strategy (per collection):
 *  0. Flush the offline queue (push any locally-created/edited contacts to server)
 *  1. List all hrefs+ETags from the CardDAV server
 *  2. Compare with DB — determine added / changed / deleted
 *  3. Skip contacts with pending local changes (local wins)
 *  4. Fetch changed vCards, write .vcf files, upsert DB rows
 *  5. Remove locally-deleted contacts from DB + disk
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
	readAccounts,
	allEnabledCollections,
	type EuorgAccount,
	type CardDavCollection,
} from "@euorg/shared/euorg-accounts.ts";

// ── Sync log ──────────────────────────────────────────────────────────────────

const LOG_DIR = join(homedir(), ".euorg", "contacts");
const LOG_PATH = join(LOG_DIR, "sync.log");

function logSyncResult(result: SyncResult): void {
	const ts = new Date().toISOString();
	const summary = `[${ts}] Sync: +${result.added} added, ${result.updated} updated, ${result.deleted} deleted, ${result.errors.length} error(s)`;
	const lines = [summary, ...result.errors.map((e) => `  ERROR: ${e}`)].join("\n") + "\n";
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		appendFileSync(LOG_PATH, lines, "utf8");
	} catch {
		// Logging failure is non-fatal
	}
}
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

// ── Network error detection ───────────────────────────────────────────────────

/**
 * Returns true if the error is a network-level failure (offline, DNS failure,
 * connection refused, timeout) rather than an HTTP-level error (4xx/5xx).
 * Used to decide whether to queue an operation for later rather than fail it.
 */
export function isNetworkError(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	if (e instanceof TypeError) return true; // Bun fetch() throws TypeError for network failures
	const msg = e.message.toLowerCase();
	return (
		msg.includes("fetch failed") ||
		msg.includes("connection refused") ||
		msg.includes("econnrefused") ||
		msg.includes("enotfound") ||
		msg.includes("etimedout") ||
		msg.includes("network") ||
		msg.includes("socket hang up") ||
		msg.includes("name or service not known") ||
		msg.includes("no route to host") ||
		msg.includes("connection reset")
	);
}

// ── Offline queue processor ───────────────────────────────────────────────────

/**
 * Processes all items in the offline queue — pushes locally-saved changes to
 * the CardDAV server.  Called at the start of every sync.
 * Items that fail (server still unreachable) are left in the queue and retried
 * on the next sync.
 */
export async function processOfflineQueue(
	db: ContactsDB,
): Promise<{ processed: number; failed: number }> {
	const queue = db.getOfflineQueue();
	if (queue.length === 0) return { processed: 0, failed: 0 };

	console.log(`[offline-queue] Processing ${queue.length} queued operation(s)…`);
	let processed = 0;
	let failed = 0;
	const cfg = readAccounts();

	for (const item of queue) {
		try {
			switch (item.operation) {
				case "create": {
					const row = db.getContact(item.uid);
					if (!row) {
						// Contact was deleted locally before being pushed — nothing to do.
						db.removeFromQueue(item.id);
						continue;
					}
					const collectionId = item.collectionId ?? row.collectionId;
					const pair = allEnabledCollections(cfg).find(
						({ collection }) => collection.id === collectionId,
					);
					if (!pair) {
						db.removeFromQueue(item.id);
						continue;
					}
					const { account, collection } = pair;
					const creds: carddav.CardDAVCredentials = {
						serverUrl: account.serverUrl,
						username: account.username,
						password: account.password,
					};

					const vcfText = readFileSync(row.vcfPath, "utf8");
					const card = parseVCard(vcfText);
					const { href, etag } = await carddav.createContact(
						collection.url,
						card.uid,
						vcfText,
						creds,
					);

					let finalVcf = vcfText;
					let finalEtag = etag;
					try {
						const fetched = await carddav.fetchVCard(href, account.serverUrl, creds);
						finalVcf = fetched.vcf;
						finalEtag = fetched.etag || etag;
					} catch {
						/* use what we have */
					}

					const finalCard = parseVCard(finalVcf);
					// Upsert with null pendingSync to mark as synced.
					db.upsertContact(finalCard, collection.id, account.id, href, finalEtag, null);
					writeFileSync(row.vcfPath, finalVcf, "utf8");
					db.removeFromQueue(item.id);
					console.log(`[offline-queue] Created ${item.uid} on server.`);
					processed++;
					break;
				}

				case "update": {
					const row = db.getContact(item.uid);
					if (!row || row.pendingSync !== "update") {
						// Stale entry — already synced or contact removed.
						db.removeFromQueue(item.id);
						continue;
					}
					const account = cfg.accounts.find((a) => a.id === row.accountId);
					if (!account) throw new Error(`Account ${row.accountId} not found`);
					const creds: carddav.CardDAVCredentials = {
						serverUrl: account.serverUrl,
						username: account.username,
						password: account.password,
					};

					const vcfText = readFileSync(row.vcfPath, "utf8");
					let newEtag: string;
					try {
						newEtag = await carddav.updateContact(
							row.href,
							account.serverUrl,
							vcfText,
							row.etag ?? "",
							creds,
						);
					} catch (e) {
						// If 412 Precondition Failed (server changed), force-push (local wins).
						const msg = e instanceof Error ? e.message : String(e);
						if (msg.includes("412") || msg.toLowerCase().includes("precondition")) {
							newEtag = await carddav.updateContact(
								row.href,
								account.serverUrl,
								vcfText,
								"", // no If-Match → force overwrite
								creds,
							);
						} else {
							throw e;
						}
					}

					let finalVcf = vcfText;
					let finalEtag = newEtag;
					try {
						const fetched = await carddav.fetchVCard(row.href, account.serverUrl, creds);
						finalVcf = fetched.vcf;
						finalEtag = fetched.etag || newEtag;
					} catch {
						/* use what we have */
					}

					const card = parseVCard(finalVcf);
					db.upsertContact(card, row.collectionId, row.accountId, row.href, finalEtag, null);
					writeFileSync(row.vcfPath, finalVcf, "utf8");
					db.removeFromQueue(item.id);
					console.log(`[offline-queue] Updated ${item.uid} on server.`);
					processed++;
					break;
				}

				case "delete": {
					const row = db.getContact(item.uid);
					if (!row) {
						// Already gone.
						db.removeFromQueue(item.id);
						continue;
					}
					const account = cfg.accounts.find((a) => a.id === row.accountId);
					if (!account) throw new Error(`Account ${row.accountId} not found`);
					const creds: carddav.CardDAVCredentials = {
						serverUrl: account.serverUrl,
						username: account.username,
						password: account.password,
					};

					await carddav.deleteContact(row.href, account.serverUrl, row.etag ?? "", creds);

					db.deleteContact(item.uid);
					if (row.vcfPath && existsSync(row.vcfPath)) unlinkSync(row.vcfPath);
					db.removeFromQueue(item.id);
					console.log(`[offline-queue] Deleted ${item.uid} from server.`);
					processed++;
					break;
				}

				case "move": {
					const row = db.getContact(item.uid);
					if (!row || row.pendingSync !== "move") {
						db.removeFromQueue(item.id);
						continue;
					}
					// row.collectionId is already the TARGET collection (set when move was queued).
					const srcCollectionId = item.sourceCollectionId;
					const srcHref = item.sourceHref;
					const srcEtag = item.sourceEtag;
					if (!srcCollectionId || !srcHref) {
						// Insufficient info to complete the move; abandon.
						db.setPendingSync(item.uid, null);
						db.removeFromQueue(item.id);
						continue;
					}

					const srcAccount = cfg.accounts.find((a) =>
						a.carddav?.collections.some((c) => c.id === srcCollectionId),
					);
					const dstPair = allEnabledCollections(cfg).find(
						({ collection }) => collection.id === row.collectionId,
					);
					if (!srcAccount || !dstPair) throw new Error("Move: account/collection not found");

					const { account: dstAccount, collection: dstCollection } = dstPair;
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
					const { href: newHref, etag: newEtag } = await carddav.createContact(
						dstCollection.url,
						item.uid,
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
						/* use what we have */
					}

					await carddav.deleteContact(srcHref, srcAccount.serverUrl, srcEtag ?? "", srcCreds);

					const finalCard = parseVCard(finalVcf);
					db.upsertContact(
						finalCard,
						dstCollection.id,
						dstAccount.id,
						newHref,
						finalEtag,
						null,
					);
					writeFileSync(row.vcfPath, finalVcf, "utf8");
					db.removeFromQueue(item.id);
					console.log(`[offline-queue] Moved ${item.uid} to ${dstCollection.name} on server.`);
					processed++;
					break;
				}
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`[offline-queue] ${item.operation} ${item.uid} failed: ${msg}`);
			failed++;
			// Leave in queue — will retry on next sync.
		}
	}

	console.log(`[offline-queue] Done: ${processed} succeeded, ${failed} still pending.`);
	return { processed, failed };
}

// ── Main sync entry point ─────────────────────────────────────────────────────

export async function syncAll(db: ContactsDB, onProgress: ProgressCallback): Promise<SyncResult> {
	const result: SyncResult = { added: 0, updated: 0, deleted: 0, errors: [] };

	// Push any locally-queued changes first so the subsequent pull sees up-to-date state.
	const queueResult = await processOfflineQueue(db);
	if (queueResult.failed > 0) {
		result.errors.push(
			`${queueResult.failed} offline change(s) could not be pushed (will retry next sync)`,
		);
	}

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
	logSyncResult(result);
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

	// Hrefs of contacts with pending local changes — skip pulling from server
	// so we don't overwrite edits that haven't been pushed yet.
	const pendingHrefs = db.getPendingSyncHrefs(collection.id);

	const toFetch: string[] = [];
	const toDelete: string[] = [];

	for (const [href, remoteEtag] of remoteEtags) {
		if (pendingHrefs.has(href)) continue; // Local edit in flight — don't overwrite
		const localEtag = localEtags.get(href);
		if (localEtag === undefined || localEtag !== remoteEtag) {
			toFetch.push(href);
		}
	}

	for (const [href] of localEtags) {
		if (!remoteEtags.has(href) && !pendingHrefs.has(href)) {
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
			// upsertContact without pendingSync → clears any stale pending flag
			const vcfPath = db.upsertContact(
				card,
				collection.id,
				account.id,
				href,
				etag || remoteEtags.get(href) || "",
				null,
			);
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
	const vcfPath = db.upsertContact(finalCard, collection.id, account.id, href, finalEtag, null);
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
	const vcfPath = db.upsertContact(card, row.collectionId, row.accountId, row.href, finalEtag, null);
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
	db.upsertContact(card, dstCollection.id, dstAccount.id, newHref, finalEtag, null);
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
