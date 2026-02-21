/**
 * Creates a `node_modules/electrobun` symlink in each app directory so that
 * the electrobun CLI can find its platform runtime files.
 *
 * Background: electrobun resolves its core binaries as:
 *   join(process.cwd(), "node_modules", "electrobun", "dist-{os}-{arch}")
 * But Bun workspaces hoist `electrobun` to the root node_modules, so it isn't
 * present in each app's own node_modules. This script bridges the gap.
 *
 * Run after `bun install`:  bun scripts/setup-workspaces.ts
 */

import { readdir, symlink, access, mkdir } from "fs/promises";
import { join } from "path";

const root = new URL("..", import.meta.url).pathname;
const electrobunPkg = join(root, "node_modules", "electrobun");
const appsDir = join(root, "apps");
const apps = await readdir(appsDir);

for (const app of apps) {
	const appNodeModules = join(appsDir, app, "node_modules");
	const link = join(appNodeModules, "electrobun");

	// Ensure node_modules dir exists in the app folder
	try {
		await access(appNodeModules);
	} catch {
		await mkdir(appNodeModules, { recursive: true });
	}

	// Symlink electrobun into the app's node_modules
	try {
		await access(link);
	} catch {
		await symlink(electrobunPkg, link);
		console.log(`  linked apps/${app}/node_modules/electrobun`);
	}
}

console.log("Workspace setup complete.");
