import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Notes",
		identifier: "org.eu.notes",
		version: "0.1.0",
	},
	build: {
		bun: {
			entrypoint: "src/main/index.ts",
		},
		copy: {
			"src/views/notes/index.html": "views/notes/index.html",
			".build-views/index.js": "views/notes/index.js",
			".build-views/index.css": "views/notes/index.css",
		},
		mac: { bundleCEF: false },
		linux: { bundleCEF: false },
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
