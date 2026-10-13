// D1 stand-in backed by node:sqlite running every migration in migrations/ (in order), so the SQL itself is under
// test. batch() runs in a transaction like D1's. `before` + `seed` run the migrations older than `before`, then seed
// (rows written the way older code wrote them), then the rest: the migrations are tested on a populated database too.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { D1Like, D1Stmt } from "../src/dashboard.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const DIR = new URL("../migrations/", import.meta.url);
export const MIGRATION_FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => ({ name: f, sql: readFileSync(new URL(f, DIR), "utf8") }));
export const MIGRATIONS = MIGRATION_FILES.map((m) => m.sql).join("\n");

type Db = InstanceType<typeof DatabaseSync>;

export function d1(o: { before?: string; seed?: (db: Db) => void } = {}) {
  const db = new DatabaseSync(":memory:");
  if (o.before) {
    for (const m of MIGRATION_FILES) if (m.name < o.before) db.exec(m.sql);
    o.seed?.(db);
    for (const m of MIGRATION_FILES) if (m.name >= o.before) db.exec(m.sql);
  } else {
    db.exec(MIGRATIONS);
  }
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
