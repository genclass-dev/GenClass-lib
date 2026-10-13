// D1 stand-in backed by node:sqlite running every migration in migrations/ (in order), so the SQL itself is under
// test. batch() runs in a transaction like D1's.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { D1Like, D1Stmt } from "../src/dashboard.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const DIR = new URL("../migrations/", import.meta.url);
export const MIGRATIONS = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(new URL(f, DIR), "utf8"))
  .join("\n");

export function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(MIGRATIONS);
  let batches = 0;
  const stmt = (sql: string, params: unknown[] = []): D1Stmt => ({
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async <T>() => (db.prepare(sql).get(...(params as never[])) ?? null) as T | null,
    all: async <T>() => ({ results: db.prepare(sql).all(...(params as never[])) as T[] }),
    run: async () => db.prepare(sql).run(...(params as never[])),
  });
  const api: D1Like = {
    prepare: (sql) => stmt(sql),
    async batch(stmts) {
      batches++;
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.all());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { api, db, rows: (sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as never[])) as Record<string, unknown>[], batches: () => batches };
}
