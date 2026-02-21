/**
 * euorg accounts configuration
 *
 * Source of truth for all account credentials and CardDAV/CalDAV service config.
 * Stored as human-readable JSON at ~/.euorg/accounts.json.
 *
 * Passwords are NOT stored in accounts.json — they live in the OS keystore
 * (see keystore.ts). On first run, any plaintext passwords already present
 * in accounts.json are migrated automatically and then removed from the file.
 *
 * All euorg apps (contacts, calendar, mail) read from this file.
 * Only import this module from Bun (main process) code — it uses Node.js fs APIs.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { storePassword, loadPassword, deletePassword } from "./keystore.ts";

// ── Paths ─────────────────────────────────────────────────────────────────────

export const EUORG_DIR = join(homedir(), ".euorg");
export const ACCOUNTS_PATH = join(EUORG_DIR, "accounts.json");
export const EUORG_CONFIG_PATH = join(EUORG_DIR, "config.json");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CardDavCollection {
	id: string;
	url: string;
	name: string;
	/** Whether this collection is included in sync and shown in the UI */
	enabled: boolean;
}

export interface CardDavConfig {
	/** ID of the collection new contacts are written to by default */
	defaultCollectionId: string | null;
	collections: CardDavCollection[];
}

export interface EuorgAccount {
	id: string;
	/** Human-readable display name, e.g. "mailbox.org" */
	name: string;
	/** Base server URL, used for CardDAV discovery (e.g. "https://dav.mailbox.org") */
	serverUrl: string;
	username: string;
	/**
	 * Runtime-only password field — populated from the OS keystore on read.
	 * Never persisted to accounts.json (stored as empty string in JSON).
	 */
	password: string;
	/** Whether this account is active; disabled accounts are skipped during sync */
	enabled: boolean;
	carddav: CardDavConfig;
}

export interface EuorgAccountsConfig {
	version: 1;
	accounts: EuorgAccount[];
}

// ── Internal JSON read/write (no keystore interaction) ───────────────────────

function readAccountsRaw(): EuorgAccountsConfig {
	try {
		if (existsSync(ACCOUNTS_PATH)) {
			const parsed = JSON.parse(readFileSync(ACCOUNTS_PATH, "utf8"));
			if (parsed.version === 1 && Array.isArray(parsed.accounts)) {
				return parsed as EuorgAccountsConfig;
			}
		}
	} catch {
		// Corrupt file — start fresh
	}
	return { version: 1, accounts: [] };
}

function writeAccountsRaw(cfg: EuorgAccountsConfig): void {
	mkdirSync(EUORG_DIR, { recursive: true });
	writeFileSync(ACCOUNTS_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

// ── Public Read / Write ───────────────────────────────────────────────────────

/**
 * Read accounts from disk. Passwords are populated from the OS keystore.
 * If any account still has a plaintext password in accounts.json (legacy),
 * it is migrated to the keystore and removed from the file automatically.
 */
export function readAccounts(): EuorgAccountsConfig {
	const cfg = readAccountsRaw();
	let needsWrite = false;

	for (const account of cfg.accounts) {
		if (account.password) {
			// Legacy plaintext password — migrate to keystore and clear from JSON
			storePassword(account.id, account.password);
			account.password = "";
			needsWrite = true;
		}
		// Always populate from keystore for callers
		account.password = loadPassword(account.id) ?? "";
	}

	if (needsWrite) {
		// Persist the cleared version (strip the just-populated runtime passwords)
		writeAccountsRaw({
			...cfg,
			accounts: cfg.accounts.map((a) => ({ ...a, password: "" })),
		});
	}

	return cfg;
}

/**
 * Persist accounts to disk.
 * Any non-empty password on an account is saved to the OS keystore;
 * the password field is stripped before writing accounts.json.
 */
export function writeAccounts(cfg: EuorgAccountsConfig): void {
	for (const account of cfg.accounts) {
		if (account.password) {
			storePassword(account.id, account.password);
		}
	}
	// Write JSON without plaintext passwords
	const safe: EuorgAccountsConfig = {
		...cfg,
		accounts: cfg.accounts.map((a) => ({ ...a, password: "" })),
	};
	writeAccountsRaw(safe);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getAccount(cfg: EuorgAccountsConfig, id: string): EuorgAccount | null {
	return cfg.accounts.find((a) => a.id === id) ?? null;
}

export function upsertAccount(cfg: EuorgAccountsConfig, account: EuorgAccount): EuorgAccountsConfig {
	const idx = cfg.accounts.findIndex((a) => a.id === account.id);
	const accounts = [...cfg.accounts];
	if (idx >= 0) {
		accounts[idx] = account;
	} else {
		accounts.push(account);
	}
	return { ...cfg, accounts };
}

export function removeAccount(cfg: EuorgAccountsConfig, id: string): EuorgAccountsConfig {
	deletePassword(id);
	return { ...cfg, accounts: cfg.accounts.filter((a) => a.id !== id) };
}

/** Returns all collection IDs that belong to enabled accounts and are themselves enabled. */
export function enabledCollectionIds(cfg: EuorgAccountsConfig): string[] {
	return cfg.accounts
		.filter((a) => a.enabled)
		.flatMap((a) => a.carddav.collections.filter((c) => c.enabled).map((c) => c.id));
}

/** Returns all enabled accounts with all their enabled collections flattened. */
export function allEnabledCollections(
	cfg: EuorgAccountsConfig,
): Array<{ account: EuorgAccount; collection: CardDavCollection }> {
	return cfg.accounts
		.filter((a) => a.enabled)
		.flatMap((a) =>
			a.carddav.collections.filter((c) => c.enabled).map((c) => ({ account: a, collection: c })),
		);
}
