import { SveltePlugin } from "bun-plugin-svelte";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const isDev = process.argv.includes("--dev");

mkdirSync(".build-views", { recursive: true });

// ── 1. Build JS (Svelte) ──────────────────────────────────────────────────────
const result = await Bun.build({
	entrypoints: ["src/views/contacts/index.ts"],
	outdir: ".build-views",
	target: "browser",
	sourcemap: isDev ? "inline" : "none",
	minify: !isDev,
	plugins: [SveltePlugin({ development: isDev })],
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

// ── 2. Build CSS with PostCSS + Tailwind v4 ───────────────────────────────────
const cssSource = readFileSync("../../packages/shared/src/theme/app.css", "utf8");

const cssResult = await postcss([
	tailwindcss(),
]).process(cssSource, {
	from: "../../packages/shared/src/theme/app.css",
	to: ".build-views/index.css",
});

writeFileSync(".build-views/index.css", cssResult.css, "utf8");
