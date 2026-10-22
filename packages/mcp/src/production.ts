// Production analytics from the GenClass dashboard (telemetry-worker: GET /api/projects/<secret>). Read-only, with the
// dashboard's private link, which the developer gives the server as GENCLASS_DASHBOARD (the URL or the secret). What
// it returns is what the dashboard shows: counts of sessions, decisions, detections by diagnosis and page, the latest
// decisions (trigger, diagnosis, action, page). It holds no page text, by the telemetry's design (TELEMETRY.md).
// GENCLASS_DASHBOARD=sample reads the public sample dashboard.

export interface ProdStats {
  name?: string;
  range?: string;
  lastEvent?: string | null;
  totals?: Record<string, number>;
  breakdowns?: Record<string, { key: string; count: number }[]>;
  series?: { bucket: string; sessions: number; decisions: number; detections: number; acted: number; possible: number }[];
  recent?: Record<string, unknown>[];
  previous?: Record<string, number>;
}

export function dashboardTarget(v: string | undefined): { origin: string; secret: string } | null {
  if (!v) return null;
  const s = v.trim();
  if (/^[A-Za-z0-9_-]{4,128}$/.test(s)) return { origin: "https://genclass.dev", secret: s };
  try {
    const u = new URL(s);
    const m = /\/dashboard\/([A-Za-z0-9_-]{4,128})/.exec(u.pathname);
    if (!m || (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1")) return null;
    return { origin: u.origin, secret: m[1] };
  } catch {
    return null;
  }
}

export async function fetchProduction(target: { origin: string; secret: string }, range: string, fetchFn: typeof fetch = fetch): Promise<ProdStats> {
  const r = ["24h", "7d", "30d", "90d", "1y"].includes(range) ? range : "7d";
  const res = await fetchFn(`${target.origin}/api/projects/${encodeURIComponent(target.secret)}?range=${r}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) throw new Error("the dashboard was not found (check GENCLASS_DASHBOARD)");
  if (res.status === 402) throw new Error("this dashboard is locked (see its page for the plan it needs)");
  if (!res.ok) throw new Error(`the dashboard answered HTTP ${res.status}`);
  return (await res.json()) as ProdStats;
}
