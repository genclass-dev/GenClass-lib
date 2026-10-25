// (j) Svelte 5 entry: mounts the component (the strategy is in j-svelte/App.svelte).

import { mount } from "svelte";
import App from "./j-svelte/App.svelte";

mount(App, { target: document.getElementById("app")! });
