import { RenderMode, ServerRoute } from "@angular/ssr";

// Rendered on the server per request (the page's data loads in the browser, on input).
export const serverRoutes: ServerRoute[] = [{ path: "**", renderMode: RenderMode.Server }];
