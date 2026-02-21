import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Calendar",
		identifier: "org.eu.calendar",
		version: "0.1.0",
	},
	build: {
		bun: {
			entrypoint: "src/main/index.ts",
		},
		copy: {
			"src/views/calendar/index.html": "views/calendar/index.html",
			".build-views/index.js": "views/calendar/index.js",
			".build-views/index.css": "views/calendar/index.css",
		},
		mac: { bundleCEF: false },
		linux: { bundleCEF: false },
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
