import { BrowserWindow, BrowserView, type ElectrobunRPCSchema, type RPCSchema } from "electrobun/bun";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
	readAccounts,
	writeAccounts,
	getAccount,
	upsertAccount,
	removeAccount,
	enabledCollectionIds,
	allEnabledCollections,
	type EuorgAccount,
} from "@euorg/shared/euorg-accounts.ts";
import { ContactsDB, type ContactRow } from "./db.ts";
import { discoverCollections, testConnection } from "./carddav.ts";
import { parseVCard, serializeVCard, mergeVCards, type VCardInput } from "./vcard.ts";
import { syncAll, writeCreate, writeUpdate, writeDelete, writeMove, importVCards, type SyncProgress, type SyncResult, type ImportResult } from "./sync.ts";
import { getKeystoreType, setKeystoreType, type KeystoreType } from "@euorg/shared/keystore.ts";

// ── View types (password omitted) ─────────────────────────────────────────────

interface AccountView {
	id: string;
	name: string;
	serverUrl: string;
	username: string;
	enabled: boolean;
	defaultCollectionId: string | null;
}

interface CollectionView {
	id: string;
	accountId: string;
	name: string;
	url: string;
	enabled: boolean;
}

// ── RPC schema ────────────────────────────────────────────────────────────────

interface ContactsRPCSchema extends ElectrobunRPCSchema {
	bun: RPCSchema<{
		requests: {
			getContacts: { params: void; response: ContactRow[] };
			searchContacts: { params: { query: string }; response: ContactRow[] };
			getContactVcard: { params: { uid: string }; response: string | null };
			createContact: { params: { vcf: string; collectionId: string }; response: ContactRow | null };
			updateContact: { params: { uid: string; vcf: string }; response: ContactRow | null };
			deleteContact: { params: { uid: string }; response: void };
			getAccounts: { params: void; response: AccountView[] };
			addAccount: { params: { name: string; serverUrl: string; username: string; password: string }; response: AccountView };
			updateAccount: { params: { id: string; name?: string; serverUrl?: string; username?: string; password?: string; enabled?: boolean }; response: AccountView };
			deleteAccount: { params: { id: string }; response: void };
			getCollections: { params: { accountId: string }; response: CollectionView[] };
			rediscoverCollections: { params: { accountId: string }; response: CollectionView[] };
			setCollectionEnabled: { params: { accountId: string; collectionId: string; enabled: boolean }; response: void };
			setDefaultCollection: { params: { accountId: string; collectionId: string }; response: void };
			getDefaultCollection: { params: { accountId: string }; response: string | null };
			testAccount: { params: { serverUrl: string; username: string; password: string }; response: { ok: boolean; error?: string } };
			triggerSync: { params: void; response: void };
			serializeVCard: { params: { input: VCardInput }; response: string };
			parseVCardText: { params: { vcf: string }; response: ReturnType<typeof parseVCard> };
			getContactCount: { params: void; response: number };
			getEnabledCollections: { params: void; response: CollectionView[] };
			openExternal: { params: { url: string }; response: void };
			moveContact: { params: { uid: string; targetCollectionId: string }; response: ContactRow | null };
			importVCards: { params: { vcfText: string; collectionId: string }; response: ImportResult };
			exportContact: { params: { uid: string }; response: { path: string } };
			exportCollection: { params: { collectionId: string }; response: { path: string; count: number } };
			findDuplicates: { params: void; response: { primaryUid: string; secondaryUid: string }[] };
			mergeContacts: { params: { primaryUid: string; secondaryUid: string }; response: { vcf: string } };
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
			contactChanged: { uid: string; action: "created" | "updated" | "deleted" };
			openImport: { vcfText: string };
		};
	}>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function accountToView(a: EuorgAccount): AccountView {
	return {
		id: a.id,
		name: a.name,
		serverUrl: a.serverUrl,
		username: a.username,
		enabled: a.enabled,
		defaultCollectionId: a.carddav.defaultCollectionId,
	};
}

function collectionToView(
	accountId: string,
	c: { id: string; url: string; name: string; enabled: boolean },
): CollectionView {
	return { id: c.id, accountId, name: c.name, url: c.url, enabled: c.enabled };
}

// ── Database ──────────────────────────────────────────────────────────────────

const db = new ContactsDB();

// ── RPC ───────────────────────────────────────────────────────────────────────

const rpc = BrowserView.defineRPC<ContactsRPCSchema>({
	handlers: {
		requests: {
			// ── Contacts ───────────────────────────────────────────────────────
			async getContacts() {
				return db.getContacts(enabledCollectionIds(readAccounts()));
			},

			async searchContacts({ query }) {
				return db.searchContacts(query, enabledCollectionIds(readAccounts()));
			},

			async getContactVcard({ uid }) {
				const row = db.getContact(uid);
				if (!row || !existsSync(row.vcfPath)) return null;
				return readFileSync(row.vcfPath, "utf8");
			},

			async createContact({ vcf, collectionId }) {
				const { uid } = await writeCreate(db, vcf, collectionId);
				const row = db.getContact(uid);
				rpc.send("contactChanged", { uid, action: "created" });
				return row;
			},

			async updateContact({ uid, vcf }) {
				await writeUpdate(db, uid, vcf);
				const row = db.getContact(uid);
				rpc.send("contactChanged", { uid, action: "updated" });
				return row;
			},

			async deleteContact({ uid }) {
				await writeDelete(db, uid);
				rpc.send("contactChanged", { uid, action: "deleted" });
			},

			// ── Accounts ───────────────────────────────────────────────────────
			async getAccounts() {
				return readAccounts().accounts.map(accountToView);
			},

			async addAccount({ name, serverUrl, username, password }) {
				const id = crypto.randomUUID();
				const newAccount: EuorgAccount = {
					id,
					name,
					serverUrl,
					username,
					password,
					enabled: true,
					carddav: { defaultCollectionId: null, collections: [] },
				};

				try {
					const remote = await discoverCollections({ serverUrl, username, password });
					newAccount.carddav.collections = remote.map((rc) => ({
						id: rc.id,
						url: rc.url,
						name: rc.name,
						enabled: true,
					}));
					if (remote.length > 0) newAccount.carddav.defaultCollectionId = remote[0].id;
				} catch (e) {
					console.error("[addAccount] discovery failed:", e);
				}

				writeAccounts(upsertAccount(readAccounts(), newAccount));
				return accountToView(newAccount);
			},

			async updateAccount({ id, name, serverUrl, username, password, enabled }) {
				const cfg = readAccounts();
				const existing = getAccount(cfg, id);
				if (!existing) throw new Error(`Account ${id} not found`);
				const updated: EuorgAccount = {
					...existing,
					...(name !== undefined && { name }),
					...(serverUrl !== undefined && { serverUrl }),
					...(username !== undefined && { username }),
					...(password !== undefined && { password }),
					...(enabled !== undefined && { enabled }),
				};
				writeAccounts(upsertAccount(cfg, updated));
				return accountToView(updated);
			},

			async deleteAccount({ id }) {
				writeAccounts(removeAccount(readAccounts(), id));
				db.deleteContactsByAccount(id);
			},

			// ── Collections ───────────────────────────────────────────────────
			async getCollections({ accountId }) {
				const account = getAccount(readAccounts(), accountId);
				if (!account) return [];
				return account.carddav.collections.map((c) => collectionToView(accountId, c));
			},

			async rediscoverCollections({ accountId }) {
				const cfg = readAccounts();
				const account = getAccount(cfg, accountId);
				if (!account) throw new Error(`Account ${accountId} not found`);

				const remote = await discoverCollections({
					serverUrl: account.serverUrl,
					username: account.username,
					password: account.password,
				});

				const existingById = new Map(account.carddav.collections.map((c) => [c.id, c]));
				const merged = remote.map((rc) => ({
					id: rc.id,
					url: rc.url,
					name: rc.name,
					enabled: existingById.get(rc.id)?.enabled ?? true,
				}));

				writeAccounts(upsertAccount(cfg, { ...account, carddav: { ...account.carddav, collections: merged } }));
				return merged.map((c) => collectionToView(accountId, c));
			},

			async setCollectionEnabled({ accountId, collectionId, enabled }) {
				const cfg = readAccounts();
				const account = getAccount(cfg, accountId);
				if (!account) throw new Error(`Account ${accountId} not found`);
				const updated: EuorgAccount = {
					...account,
					carddav: {
						...account.carddav,
						collections: account.carddav.collections.map((c) =>
							c.id === collectionId ? { ...c, enabled } : c,
						),
					},
				};
				writeAccounts(upsertAccount(cfg, updated));
			},

			async setDefaultCollection({ accountId, collectionId }) {
				const cfg = readAccounts();
				const account = getAccount(cfg, accountId);
				if (!account) throw new Error(`Account ${accountId} not found`);
				writeAccounts(
					upsertAccount(cfg, { ...account, carddav: { ...account.carddav, defaultCollectionId: collectionId } }),
				);
			},

			async getDefaultCollection({ accountId }) {
				return getAccount(readAccounts(), accountId)?.carddav.defaultCollectionId ?? null;
			},

			async testAccount({ serverUrl, username, password }) {
				const error = await testConnection({ serverUrl, username, password });
				return { ok: error === null, error: error ?? undefined };
			},

			// ── Sync ───────────────────────────────────────────────────────────
			async triggerSync() {
				syncAll(db, (p) => rpc.send("syncProgress", p))
					.then((result) => rpc.send("syncComplete", result))
					.catch((e) =>
						rpc.send("syncComplete", { added: 0, updated: 0, deleted: 0, errors: [String(e)] }),
					);
			},

			// ── Helpers ────────────────────────────────────────────────────────
			async serializeVCard({ input }) {
				return serializeVCard(input);
			},

			async parseVCardText({ vcf }) {
				return parseVCard(vcf);
			},

			async getContactCount() {
				return db.countContacts(enabledCollectionIds(readAccounts()));
			},

			async getEnabledCollections() {
				return allEnabledCollections(readAccounts()).map(({ account, collection }) =>
					collectionToView(account.id, collection),
				);
			},

			async openExternal({ url }) {
				const plat = process.platform;
				if (plat === "darwin") Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
				else if (plat === "win32") Bun.spawn(["cmd", "/c", "start", "", url], { stdout: "ignore", stderr: "ignore" });
				else Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
			},

			async moveContact({ uid, targetCollectionId }) {
				await writeMove(db, uid, targetCollectionId);
				const row = db.getContact(uid);
				rpc.send("contactChanged", { uid, action: "updated" });
				return row;
			},

			async importVCards({ vcfText, collectionId }) {
				const result = await importVCards(db, vcfText, collectionId);
				if (result.imported > 0) rpc.send("syncComplete", { added: result.imported, updated: 0, deleted: 0, errors: result.errors });
				return result;
			},

			async exportContact({ uid }) {
				const row = db.getContact(uid);
				if (!row || !existsSync(row.vcfPath)) throw new Error(`Contact ${uid} not found`);
				const vcf = readFileSync(row.vcfPath, "utf8");
				const safe = row.displayName.replace(/[/\\?%*:|"<>]/g, "_") || uid;
				const destDir = join(homedir(), "Downloads");
				mkdirSync(destDir, { recursive: true });
				const destPath = join(destDir, `${safe}.vcf`);
				writeFileSync(destPath, vcf, "utf8");
				return { path: destPath };
			},

			async exportCollection({ collectionId }) {
				const cfg = readAccounts();
				const pair = allEnabledCollections(cfg).find(({ collection }) => collection.id === collectionId);
				const collectionName = pair?.collection.name ?? collectionId;
				const contacts = db.getContacts([collectionId]);
				const vcfs = contacts
					.map((row) => {
						try { return readFileSync(row.vcfPath, "utf8"); } catch { return null; }
					})
					.filter((v): v is string => v !== null);
				const combined = vcfs.join("\r\n");
				const safe = collectionName.replace(/[/\\?%*:|"<>]/g, "_") || collectionId;
				const destDir = join(homedir(), "Downloads");
				mkdirSync(destDir, { recursive: true });
				const destPath = join(destDir, `${safe}.vcf`);
				writeFileSync(destPath, combined, "utf8");
				return { path: destPath, count: vcfs.length };
			},

			async findDuplicates() {
				const contacts = db.getContacts(enabledCollectionIds(readAccounts()));
				const pairs: { primaryUid: string; secondaryUid: string }[] = [];
				const seen = new Set<string>();

				const nameMap = new Map<string, string[]>();
				const emailMap = new Map<string, string[]>();
				const phoneMap = new Map<string, string[]>();

				for (const c of contacts) {
					const name = c.displayName.toLowerCase().replace(/\s+/g, " ").trim();
					if (name) {
						if (!nameMap.has(name)) nameMap.set(name, []);
						nameMap.get(name)!.push(c.uid);
					}
					for (const e of c.emails) {
						const key = e.value.toLowerCase().trim();
						if (key) {
							if (!emailMap.has(key)) emailMap.set(key, []);
							emailMap.get(key)!.push(c.uid);
						}
					}
					for (const p of c.phones) {
						const key = p.value.replace(/\D/g, "");
						if (key.length >= 7) {
							if (!phoneMap.has(key)) phoneMap.set(key, []);
							phoneMap.get(key)!.push(c.uid);
						}
					}
				}

				function addPair(uid1: string, uid2: string) {
					if (uid1 === uid2) return;
					const key = [uid1, uid2].sort().join("|");
					if (seen.has(key)) return;
					seen.add(key);
					pairs.push({ primaryUid: uid1, secondaryUid: uid2 });
				}

				for (const uids of nameMap.values())
					for (let i = 0; i < uids.length; i++)
						for (let j = i + 1; j < uids.length; j++)
							addPair(uids[i], uids[j]);

				for (const uids of emailMap.values())
					for (let i = 0; i < uids.length; i++)
						for (let j = i + 1; j < uids.length; j++)
							addPair(uids[i], uids[j]);

				for (const uids of phoneMap.values())
					for (let i = 0; i < uids.length; i++)
						for (let j = i + 1; j < uids.length; j++)
							addPair(uids[i], uids[j]);

				return pairs;
			},

			async getKeystoreType() {
				return getKeystoreType();
			},

			async setKeystoreType({ type }) {
				setKeystoreType(type);
			},

			async mergeContacts({ primaryUid, secondaryUid }) {
				const primaryRow = db.getContact(primaryUid);
				const secondaryRow = db.getContact(secondaryUid);
				if (!primaryRow) throw new Error(`Contact ${primaryUid} not found`);
				if (!secondaryRow) throw new Error(`Contact ${secondaryUid} not found`);
				if (!existsSync(primaryRow.vcfPath)) throw new Error(`vCard file not found for ${primaryUid}`);
				if (!existsSync(secondaryRow.vcfPath)) throw new Error(`vCard file not found for ${secondaryUid}`);

				const primaryCard = parseVCard(readFileSync(primaryRow.vcfPath, "utf8"));
				const secondaryCard = parseVCard(readFileSync(secondaryRow.vcfPath, "utf8"));
				const mergedInput = mergeVCards(primaryCard, secondaryCard);
				return { vcf: serializeVCard(mergedInput) };
			},
		},

		messages: {},
	},
});

// ── Window ────────────────────────────────────────────────────────────────────

new BrowserWindow({
	title: "Contacts",
	url: "views://contacts/index.html",
	frame: { width: 960, height: 720, x: 80, y: 80 },
	rpc,
});

// ── VCF file argument ─────────────────────────────────────────────────────────
// When launched with a .vcf file path (e.g. from a file manager association),
// open the import panel with the file pre-loaded.

const vcfArg = process.argv.slice(1).find((a) => a.endsWith(".vcf") && existsSync(a));
if (vcfArg) {
	const vcfText = readFileSync(vcfArg, "utf8");
	// Delay to let the webview finish loading before sending
	setTimeout(() => rpc.send("openImport", { vcfText }), 2500);
}

// ── Startup sync ──────────────────────────────────────────────────────────────

setTimeout(() => {
	syncAll(db, (p) => rpc.send("syncProgress", p))
		.then((result) => rpc.send("syncComplete", result))
		.catch((e) => {
			console.error("[startup sync]", e);
			rpc.send("syncComplete", { added: 0, updated: 0, deleted: 0, errors: [String(e)] });
		});
}, 1500);
