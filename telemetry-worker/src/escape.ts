// Escaping shared by every page this worker renders (src/pages.ts, src/studio.ts, the account and billing pages).
// No imports, so any page module can use it without an import cycle.

/** HTML-escape text for element content and quoted attributes. */
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** JSON safe to embed in <script type="application/json">. */
export const embed = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
