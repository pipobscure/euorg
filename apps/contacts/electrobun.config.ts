import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Contacts",
		identifier: "org.eu.contacts",
		version: "0.1.0",
	},
	build: {
		bun: {
			entrypoint: "src/main/index.ts",
		},
		copy: {
			"src/views/contacts/index.html": "views/contacts/index.html",
			".build-views/index.js": "views/contacts/index.js",
			".build-views/index.css": "views/contacts/index.css",
		},
		mac: { bundleCEF: false },
		linux: { bundleCEF: false },
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
