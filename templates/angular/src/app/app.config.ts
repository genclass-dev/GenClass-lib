import { provideHttpClient } from "@angular/common/http";
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from "@angular/core";
import { provideClientHydration } from "@angular/platform-browser";
import { provideRouter } from "@angular/router";
import { routes } from "./app.routes";

/** Angular's defaults (ng new --ssr): router, hydration, HttpClient on its fetch backend. */
export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), provideRouter(routes), provideHttpClient(), provideClientHydration()],
};
