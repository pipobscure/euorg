/**
 * Cross-platform credential storage abstraction.
 *
 * Platform → backend mapping (auto mode):
 *   macOS   → macOS Keychain          (security CLI, built-in)
 *   Linux   → libsecret / GNOME Keyring (secret-tool)
 *   Windows → Windows Credential Manager (PowerShell PasswordVault)
 *
 * Fallback: plaintext JSON at ~/.euorg/keystore.json (mode 0600)
 *           Used when the system backend is unavailable or fails.
 *
 * The active backend is stored in ~/.euorg/config.json as { "keystoreType": "..." }.
 * "auto" (default) picks the appropriate backend for the running OS.
 *
 * Only import from Bun (main-process) code.
 */

import { readFileSync, writeFileSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { mkdirSync } from "fs";
import { homedir } from "os";

// ── Paths (defined locally to avoid circular imports with euorg-accounts.ts) ──

const EUORG_DIR = join(homedir(), ".euorg");
const CONFIG_PATH = join(EUORG_DIR, "config.json");
const FALLBACK_STORE_PATH = join(EUORG_DIR, "keystore.json");
const SERVICE = "euorg";

// ── Types ─────────────────────────────────────────────────────────────────────

export type KeystoreType =
	| "auto"
	| "secret-service"
	| "kwallet"
	| "macos-keychain"
	| "windows"
	| "plaintext";

// ── Config (keystore type preference) ────────────────────────────────────────

function readConfig(): Record<string, unknown> {
	try {
		if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch {}
	return {};
}

function writeConfig(cfg: Record<string, unknown>): void {
	mkdirSync(EUORG_DIR, { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

export function getKeystoreType(): KeystoreType {
	const cfg = readConfig();
	return (cfg.keystoreType as KeystoreType | undefined) ?? "auto";
}

export function setKeystoreType(type: KeystoreType): void {
	writeConfig({ ...readConfig(), keystoreType: type });
}

// ── Effective backend ─────────────────────────────────────────────────────────

function effectiveBackend(): Exclude<KeystoreType, "auto"> {
	const configured = getKeystoreType();
	if (configured !== "auto") return configured;
	const plat = process.platform;
	if (plat === "darwin") return "macos-keychain";
	if (plat === "win32") return "windows";
	return "secret-service"; // Linux default
}

// ── Spawn helper ──────────────────────────────────────────────────────────────

function run(cmd: string[], stdin?: string): { ok: boolean; out: string } {
	try {
		const proc = Bun.spawnSync(cmd, {
			stdin: stdin !== undefined ? Buffer.from(stdin) : "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		return {
			ok: proc.exitCode === 0,
			out: new TextDecoder().decode(proc.stdout ?? new Uint8Array()).trim(),
		};
	} catch {
		return { ok: false, out: "" };
	}
}

// ── macOS Keychain (security CLI) ─────────────────────────────────────────────

function macStore(id: string, pw: string): boolean {
	// -U = update existing entry if present
	return run(["security", "add-generic-password", "-s", SERVICE, "-a", id, "-w", pw, "-U"]).ok;
}

function macLoad(id: string): string | null {
	const r = run(["security", "find-generic-password", "-s", SERVICE, "-a", id, "-w"]);
	return r.ok && r.out ? r.out : null;
}

function macDelete(id: string): void {
	run(["security", "delete-generic-password", "-s", SERVICE, "-a", id]);
}

// ── libsecret / GNOME Keyring (secret-tool) ───────────────────────────────────

function secretStore(id: string, pw: string): boolean {
	// secret-tool reads the password from stdin when non-interactive
	return run(
		["secret-tool", "store", "--label", `euorg account ${id}`, "application", SERVICE, "account", id],
		pw,
	).ok;
}

function secretLoad(id: string): string | null {
	const r = run(["secret-tool", "lookup", "application", SERVICE, "account", id]);
	return r.ok && r.out ? r.out : null;
}

function secretDelete(id: string): void {
	run(["secret-tool", "clear", "application", SERVICE, "account", id]);
}

// ── KWallet (kwallet-query) ───────────────────────────────────────────────────

function kwalletStore(id: string, pw: string): boolean {
	return run(["kwallet-query", "-f", SERVICE, "-w", `account-${id}`, "kdewallet"], pw).ok;
}

function kwalletLoad(id: string): string | null {
	const r = run(["kwallet-query", "-f", SERVICE, "-r", `account-${id}`, "kdewallet"]);
	return r.ok && r.out ? r.out : null;
}

function kwalletDelete(id: string): void {
	run(["kwallet-query", "-f", SERVICE, "-d", `account-${id}`, "kdewallet"]);
}

// ── Windows Credential Manager (PowerShell PasswordVault) ─────────────────────

function psEscape(s: string): string {
	// In a PowerShell single-quoted string only ' needs escaping (doubled)
	return s.replace(/'/g, "''");
}

function windowsStore(id: string, pw: string): boolean {
	const script = [
		`$v = New-Object Windows.Security.Credentials.PasswordVault`,
		`try { $v.Remove($v.Retrieve('${SERVICE}','${psEscape(id)}')) } catch {}`,
		`$v.Add((New-Object Windows.Security.Credentials.PasswordCredential('${SERVICE}','${psEscape(id)}','${psEscape(pw)}')))`,
	].join(";");
	return run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script]).ok;
}

function windowsLoad(id: string): string | null {
	const script = [
		`$v = New-Object Windows.Security.Credentials.PasswordVault`,
		`$c = $v.Retrieve('${SERVICE}','${psEscape(id)}')`,
		`Write-Output $c.Password`,
	].join(";");
	const r = run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script]);
	return r.ok && r.out ? r.out : null;
}

function windowsDelete(id: string): void {
	const script = [
		`$v = New-Object Windows.Security.Credentials.PasswordVault`,
		`try { $v.Remove($v.Retrieve('${SERVICE}','${psEscape(id)}')) } catch {}`,
	].join(";");
	run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script]);
}

// ── Plaintext fallback (JSON, mode 0600) ─────────────────────────────────────

function plaintextLoad(id: string): string | null {
	try {
		if (existsSync(FALLBACK_STORE_PATH))
			return (JSON.parse(readFileSync(FALLBACK_STORE_PATH, "utf8")) as Record<string, string>)[id] ?? null;
	} catch {}
	return null;
}

function plaintextStore(id: string, pw: string): boolean {
	try {
		mkdirSync(EUORG_DIR, { recursive: true });
		const store: Record<string, string> = existsSync(FALLBACK_STORE_PATH)
			? JSON.parse(readFileSync(FALLBACK_STORE_PATH, "utf8"))
			: {};
		store[id] = pw;
		writeFileSync(FALLBACK_STORE_PATH, JSON.stringify(store, null, 2), "utf8");
		try { chmodSync(FALLBACK_STORE_PATH, 0o600); } catch {}
		return true;
	} catch { return false; }
}

function plaintextDelete(id: string): void {
	try {
		if (!existsSync(FALLBACK_STORE_PATH)) return;
		const store = JSON.parse(readFileSync(FALLBACK_STORE_PATH, "utf8")) as Record<string, string>;
		delete store[id];
		writeFileSync(FALLBACK_STORE_PATH, JSON.stringify(store, null, 2), "utf8");
	} catch {}
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Store a password in the OS keystore. Falls back to plaintext if unavailable. */
export function storePassword(accountId: string, password: string): void {
	if (!password) return;
	const backend = effectiveBackend();
	let ok = false;

	if (backend === "macos-keychain") ok = macStore(accountId, password);
	else if (backend === "secret-service") ok = secretStore(accountId, password);
	else if (backend === "kwallet") ok = kwalletStore(accountId, password);
	else if (backend === "windows") ok = windowsStore(accountId, password);
	else ok = plaintextStore(accountId, password);

	if (!ok) {
		console.warn(`[keystore] ${backend} failed, using plaintext fallback`);
		plaintextStore(accountId, password);
	}
}

/** Load a password from the OS keystore (or plaintext fallback). Returns null if not found. */
export function loadPassword(accountId: string): string | null {
	const backend = effectiveBackend();
	let pw: string | null = null;

	if (backend === "macos-keychain") pw = macLoad(accountId);
	else if (backend === "secret-service") pw = secretLoad(accountId);
	else if (backend === "kwallet") pw = kwalletLoad(accountId);
	else if (backend === "windows") pw = windowsLoad(accountId);

	// Always fall back to the plaintext store in case the system keystore is unavailable
	// or the password was stored there previously
	return pw ?? plaintextLoad(accountId);
}

/** Remove a password from all stores (system keystore + plaintext fallback). */
export function deletePassword(accountId: string): void {
	const backend = effectiveBackend();
	if (backend === "macos-keychain") macDelete(accountId);
	else if (backend === "secret-service") secretDelete(accountId);
	else if (backend === "kwallet") kwalletDelete(accountId);
	else if (backend === "windows") windowsDelete(accountId);
	plaintextDelete(accountId); // always clear plaintext too
}
