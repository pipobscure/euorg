import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Mail",
		identifier: "org.eu.mail",
		version: "0.1.0",
	},
	build: {
		bun: {
			entrypoint: "src/main/index.ts",
		},
		copy: {
			"src/views/mail/index.html": "views/mail/index.html",
			".build-views/index.js": "views/mail/index.js",
			".build-views/index.css": "views/mail/index.css",
		},
		mac: { bundleCEF: false },
		linux: { bundleCEF: false },
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
