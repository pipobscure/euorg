import { BrowserWindow } from "electrobun/bun";

new BrowserWindow({
	title: "Mail",
	url: "views://mail/index.html",
	frame: { width: 1200, height: 800, x: 80, y: 80 },
});
