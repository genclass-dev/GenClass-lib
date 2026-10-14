// genclass-clef-eval: POST one element crop and its measured facts, get Clef's typed answers back.
// Invariants:
// - Every request needs the header x-eval-key equal to the EVAL_KEY secret (compared on SHA-256 digests in constant
//   time); anything else is a bare 404, so the endpoint does not advertise itself.
// - Nothing is logged or stored: no console calls, observability is off in wrangler.jsonc, and the crop, the state
//   and the answers live only for the request.
// - Input follows the Workers AI Clef schema (developers.cloudflare.com/workers-ai/models/clef, schema-input.json,
//   read 2026-10-14): { model: "clef" | "clef-flash", state, questions, images?: [{ content_type, base64 }] }.

interface Ai {
  run(model: string, input: unknown): Promise<unknown>;
}

interface Env {
  AI: Ai;
  EVAL_KEY: string;
}

/** The two models this endpoint may call, by the selector the Clef schema expects. */
const MODELS: Record<string, string> = {
  clef: "@cf/cloudflare/clef",
  "clef-flash": "@cf/cloudflare/clef-flash",
};

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_B64 = 5_600_000; // about 4 MiB decoded, the per-image limit
const MAX_BODY = 12_000_000;

const notFound = (): Response => new Response("not found", { status: 404 });
const bad = (msg: string, status = 400): Response => Response.json({ error: msg }, { status });

async function keyMatches(given: string | null, expected: string | undefined): Promise<boolean> {
  if (!given || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return (crypto.subtle as unknown as { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean }).timingSafeEqual(a, b);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return notFound();
    if (!(await keyMatches(request.headers.get("x-eval-key"), env.EVAL_KEY))) return notFound();
    const len = Number(request.headers.get("content-length") || "0");
    if (len > MAX_BODY) return bad("body too large", 413);

    let body: { image_b64?: unknown; content_type?: unknown; state?: unknown; questions?: unknown; model?: unknown };
    try {
      body = await request.json();
    } catch {
      return bad("body is not JSON");
    }
    const selector = typeof body.model === "string" ? body.model : "clef";
    const modelId = MODELS[selector];
    if (!modelId) return bad("model must be clef or clef-flash");
    if (body.state === undefined || body.state === null || body.state === "") return bad("state is required");
    if (!body.questions || typeof body.questions !== "object") return bad("questions is required");

    const input: Record<string, unknown> = { model: selector, state: body.state, questions: body.questions };
    if (body.image_b64 !== undefined && body.image_b64 !== null && body.image_b64 !== "") {
      if (typeof body.image_b64 !== "string" || body.image_b64.length > MAX_IMAGE_B64) return bad("image_b64 must be base64 under 4 MiB");
      const ct = typeof body.content_type === "string" ? body.content_type : "image/jpeg";
      if (!IMAGE_TYPES.has(ct)) return bad("content_type must be image/png, image/jpeg or image/webp");
      input.images = [{ content_type: ct, base64: body.image_b64 }];
    }

    const t0 = Date.now();
    try {
      const out = (await env.AI.run(modelId, input)) as { model?: string; answers?: unknown; usage?: unknown };
      const ms = Date.now() - t0;
      return Response.json({ model: out.model ?? modelId, answers: out.answers ?? null, usage: out.usage ?? null, ms });
    } catch (e) {
      const ms = Date.now() - t0;
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg.slice(0, 500), ms }, { status: 502 });
    }
  },
};
