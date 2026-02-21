import { BrowserWindow } from "electrobun/bun";

new BrowserWindow({
	title: "Notes",
	url: "views://notes/index.html",
	frame: { width: 800, height: 700, x: 80, y: 80 },
});
