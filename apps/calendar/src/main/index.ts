import { BrowserWindow } from "electrobun/bun";

new BrowserWindow({
	title: "Calendar",
	url: "views://calendar/index.html",
	frame: { width: 1100, height: 780, x: 80, y: 80 },
});
