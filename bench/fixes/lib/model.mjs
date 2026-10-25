// Fetches the default model package (@genclass/runtime-model, the version the runtime loads by default) into
// .cache/model once, and checks every file against the sha256 in its model.json. The server serves it from there,
// so the GenClass conditions load the same files a page would load from jsDelivr, without leaving the machine.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const REPO = resolve(ROOT, "../..");
const CACHE = join(ROOT, ".cache/model");

/** The model package version the runtime loads by default (DEFAULT_MODEL_BASE_URL in src/model/host.ts). */
export function defaultModelVersion() {
  const src = readFileSync(join(REPO, "packages/runtime/src/model/host.ts"), "utf8");
  const m = /runtime-model@([0-9][^/"]*)\/files\//.exec(src);
  if (!m) throw new Error("could not read DEFAULT_MODEL_BASE_URL from packages/runtime/src/model/host.ts");
  return m[1];
}

function verify(dir) {
  const card = JSON.parse(readFileSync(join(dir, "model.json"), "utf8"));
  const specs = [...Object.values(card.variants ?? {}), ...Object.values(card.files ?? {})];
  for (const spec of specs) {
    const sha = createHash("sha256").update(readFileSync(join(dir, spec.file))).digest("hex");
    if (sha !== spec.sha256) throw new Error(`model file ${spec.file}: sha256 ${sha}, model.json says ${spec.sha256}`);
  }
  return card;
}

/** Ensure .cache/model/files holds the verified model; returns { version, card, dir }. */
export function ensureModel() {
  const version = defaultModelVersion();
  const dir = join(CACHE, "files");
  const stamp = join(CACHE, `version-${version}`);
  if (!existsSync(stamp) || !existsSync(join(dir, "model.json"))) {
    rmSync(CACHE, { recursive: true, force: true });
    mkdirSync(CACHE, { recursive: true });
    console.log(`fetching @genclass/runtime-model@${version} from the npm registry`);
    execFileSync("npm", ["pack", `@genclass/runtime-model@${version}`, "--silent"], { cwd: CACHE, stdio: ["ignore", "ignore", "inherit"] });
    const tgz = readdirSync(CACHE).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error("npm pack produced no tarball");
    execFileSync("tar", ["xzf", tgz, "--strip-components=1"], { cwd: CACHE });
    rmSync(join(CACHE, tgz));
    execFileSync("touch", [stamp]);
  }
  const card = verify(dir);
  return { version, card, dir };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version, card } = ensureModel();
  console.log(`model @genclass/runtime-model@${version}: ${card.name} ${card.version}, files verified`);
}
