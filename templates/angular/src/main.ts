// GenClass goes first, before Angular, so it is installed before your app and its first requests.
// "@genclass/runtime/auto" observes (reports what it sees, never changes anything). To let it act, switch to
// "@genclass/runtime/auto/guard". Add ?genclass=off to the URL to turn it off for a page load.
import genclass from "@genclass/runtime/auto";
import { isDevMode } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { App } from "./app/app";
import { appConfig } from "./app/app.config";

bootstrapApplication(App, appConfig).catch((err) => console.error(err));

// The devtools overlay, in development only (isDevMode() is false in a production build, so this is dropped from it).
if (isDevMode()) import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass));
