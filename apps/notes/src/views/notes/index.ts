import { mount } from "svelte";
import "@euorg/shared/theme/app.css";
import App from "./App.svelte";
import { rpc } from "./lib/rpc.ts";

mount(App, { target: document.getElementById("app")! });

window.addEventListener("error", (e) => {
	rpc.request.logError({ message: e.message, source: e.filename, lineno: e.lineno }).catch(() => {});
});

window.addEventListener("unhandledrejection", (e) => {
	rpc.request.logError({ message: String(e.reason) }).catch(() => {});
});
