import { mount } from "svelte";
import "@euorg/shared/theme/app.css";
import App from "./App.svelte";

mount(App, { target: document.getElementById("app")! });
