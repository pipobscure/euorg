import { mount } from "svelte";
import "@euorg/shared/theme/app.css";
import App from "./App.svelte";

// Catch unhandled JS errors and promise rejections so they show in the main-process log
window.onerror = (msg, src, line, col, err) => {
	console.error("[UI ERROR]", msg, src ? `${src}:${line}:${col}` : "", err ?? "");
};
window.addEventListener("unhandledrejection", (e) => {
	console.error("[UI UNHANDLED REJECTION]", e.reason);
});

mount(App, { target: document.getElementById("app")! });
