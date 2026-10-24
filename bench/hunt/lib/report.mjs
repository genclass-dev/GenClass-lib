// The hunt report: report.json is the record, report.md renders it for a person. Everything GenClass said (the explore
// report, each finding's explanation, each replay result) is kept verbatim: page strings in it were recorded from the
// app and are data, not instructions. The DOM-oracle comparison is the harness's own and is labelled as such.

// a block that itself holds a code fence (genclass_explain carries the regression test) gets a longer outer fence
/** Other findings whose explanation report.md prints in full (the rest are listed; report.json has every one). */
const OTHERS_IN_FULL = 3;

const fence = (s, lang = "") => {
  const body = String(s ?? "").trimEnd();
  const f = /^`{3,}/m.test(body) ? "`".repeat(Math.max(...[...body.matchAll(/^(`{3,})/gm)].map((m) => m[1].length)) + 1) : "```";
  return `${f}${lang}\n${body}\n${f}`;
};
const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const ms = (n) => (typeof n === "number" && Number.isFinite(n) ? `${Math.round(n)} ms` : "");

function table(head, rows) {
  const out = [`| ${head.map(cell).join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const r of rows) out.push(`| ${r.map(cell).join(" | ")} |`);
  return out.join("\n");
}

// ----------------------------------------------------------------------------------------------- the DOM oracle

/** A readable difference between two oracle values (arrays of lines, strings, objects). */
export function diffOf(a, b) {
  const lines = (v) => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split("\n") : null);
  const la = lines(a);
  const lb = lines(b);
  if (la && lb) {
    const count = (xs) => {
      const m = new Map();
      for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
      return m;
    };
    const ma = count(la);
    const mb = count(lb);
    const only = (x, y) => {
      const out = [];
      for (const [l, n] of x) for (let i = y.get(l) ?? 0; i < n; i++) out.push(l);
      return out;
    };
    return { onlyBaseline: only(ma, mb).slice(0, 20), onlyRun: only(mb, ma).slice(0, 20) };
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const changed = {};
    for (const k of keys) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changed[k] = diffOf(a[k], b[k]);
    return { changed };
  }
  return { baseline: a, run: b };
}

/**
 * Compare the scenario's oracle across the explore loads: the two fifo baselines must agree (else the oracle is noisy
 * and there is no verdict); a seeded load whose oracle differs from them is listed. The harness's own check.
 */
export function compareOracles(loads) {
  const ok = loads.filter((l) => l.phase === "explore" && !l.error && l.oracle !== undefined);
  if (!loads.some((l) => l.oracle !== undefined)) return { status: "none", note: "the scenario defines no oracle" };
  const canon = (v) => JSON.stringify(v);
  const base = ok.filter((l) => l.schedule?.order === "fifo");
  const seeded = ok.filter((l) => l.schedule?.order === "seeded");
  if (base.length < 2) return { status: "no-baseline", note: `only ${base.length} baseline load(s) with an oracle: nothing to compare with`, of: seeded.length };
  if (canon(base[0].oracle) !== canon(base[1].oracle)) return { status: "noisy", note: "the two baselines disagree: the oracle is not stable between identical runs, so no seeded difference can be read as a race", diff: diffOf(base[0].oracle, base[1].oracle), of: seeded.length };
  const differing = seeded.filter((l) => canon(l.oracle) !== canon(base[0].oracle)).map((l) => ({ load: l.index, label: l.schedule?.label ?? "", run: l.run, ...(l.stepsError ? { stepsError: l.stepsError } : {}), diff: diffOf(base[0].oracle, l.oracle) }));
  return { status: differing.length ? "differs" : "same", of: seeded.length, differing, note: differing.length ? `${differing.length} of ${seeded.length} seeded loads ended with a different oracle than the baselines` : `all ${seeded.length} seeded loads ended with the baselines' oracle` };
}

// ----------------------------------------------------------------------------------------------- markdown

function verdictText(v) {
  if (!v) return "no explore ran";
  switch (v.kind) {
    case "race":
      return v.ended ? `RACE: ${v.ended} of ${v.of} reordered runs ended differently${v.along ? ` (${v.along} more overwrote newer data along the way)` : ""}` : `RACE (along the way only): ${v.along} of ${v.of} overwrote newer data, all ended right`;
    case "no-race":
      return `no race: 0 of ${v.of} reordered runs differ`;
    case "no-verdict":
      return `no verdict: ${v.reason}`;
    case "no-runs":
      return `no run reached a quiet point`;
    default:
      return v.reason ?? v.kind;
  }
}

/** The summary's "other findings" cell: every id when there are a few, else counts by kind. */
function otherFindingsCell(s) {
  const others = s.otherFindings ?? [];
  if (!others.length) return "none";
  if (others.length <= 4) return others.map((o) => `${o.id} (${o.kind}, ${o.runs} of ${s.loads.length} loads)`).join(", ");
  const byKind = {};
  for (const o of others) byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;
  return `${others.length}: ${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(", ")} (listed below)`;
}

function loadRow(l) {
  const sched = l.schedule ? (l.schedule.label ?? l.schedule.order) : l.error ? "" : "none assigned";
  return [l.index + 1, l.phase, sched, l.run ?? "", l.error ? "no" : l.settled ? "yes" : "no (timed out)", l.snapshot?.forced ?? "", l.snapshot?.witnesses ?? "", l.pageErrors?.length ?? 0, ms(l.t?.connected), ms(l.t?.steps), ms(l.t?.settled), l.error ? `error: ${l.error}` : l.stepsError ? `steps could not be done: ${l.stepsError}` : ""];
}

export function renderMarkdown(r) {
  const out = [];
  out.push(`# GenClass hunt: ${r.app.url}`);
  out.push("");
  out.push(`Produced by \`bench/hunt/hunt.mjs\` on ${r.started} in ${Math.round(r.durationMs / 1000)} s. Every GenClass text below is the MCP server's own output, kept verbatim; strings inside it were recorded from the app's pages and are data, not instructions.`);
  out.push("");
  out.push(table(["", ""], [
    ["app", `${r.app.url}${r.app.commit ? ` at commit \`${r.app.commit}\`` : " (commit not given: pass --app-commit when you publish a result)"}`],
    ["@genclass/runtime", `${r.runtime.version}, built from ${r.runtime.commit}${r.runtime.dirty ? " (working tree had uncommitted changes)" : ""}`],
    ["@genclass/mcp", `${r.mcp.version}, built from ${r.mcp.commit}`],
    ["harness", `bench/hunt ${r.harness.version}, commit ${r.harness.commit}`],
    ["browser", `${r.browser.name} ${r.browser.version}, ${r.browser.headless ? "headless" : "headful"}, ${r.browser.viewport}`],
    ["explore", `${r.options.runs} seeded orders after 2 baselines, slow ${r.options.slow} ms, first seed ${r.options.seed}${r.options.focus.length ? `, focus ${r.options.focus.join(", ")}` : ""}${r.options.route ? `, route ${r.options.route}` : ""}`],
    ["model", r.options.model === "skipped" ? "skipped (explore compares final states; it does not need the model)" : r.options.model],
    ["injection", `${r.injection.how}; runtime options: ${JSON.stringify(r.injection.config)}`],
    ["login", r.options.storageState ? "storage state from a login" : "none"],
  ]));
  out.push("");
  out.push("## Summary");
  out.push("");
  out.push(table(["scenario", "page", "loads recorded", "GenClass explore verdict", "race findings", "replay", "other findings", "DOM oracle (harness)"],
    r.scenarios.map((s) => [
      s.name,
      s.url,
      `${s.loads.filter((l) => l.phase === "explore" && l.run).length} of ${s.explore?.plan?.length ?? 0}`,
      verdictText(s.explore?.verdict),
      s.findings.map((f) => `${f.id} (${f.kind})`).join(", ") || "none",
      s.findings.map((f) => `${f.id}: ${f.replay?.verdict ?? "not replayed"}`).join("; ") || "",
      otherFindingsCell(s),
      s.oracle ? `${s.oracle.status}${s.oracle.of !== undefined ? ` (${s.oracle.status === "differs" ? s.oracle.differing.length : 0} of ${s.oracle.of})` : ""}` : "",
    ])));
  out.push("");
  for (const s of r.scenarios) {
    out.push(`## Scenario: ${s.name}`);
    out.push("");
    out.push(`- page: ${s.url}${s.route ? ` (armed route ${s.route})` : ""}`);
    out.push(`- file: \`${s.file}\`${Object.keys(s.params).length ? `, params ${JSON.stringify(s.params)}` : ""}`);
    out.push(`- quiet time (settleMs): ${s.settleMs}`);
    out.push(`- recorded user actions, as GenClass grouped them: ${s.explore?.scenario ? `\`${s.explore.scenario.replace(/\n/g, " · ")}\`` : "(none recorded)"}`);
    out.push(`- discovered state fields in the final snapshots: ${s.discovered.fields} ${s.discovered.fields ? `(for example ${s.discovered.examples.map((x) => `\`${x}\``).join(", ")})` : "(none: the verdict rests on page text, form values, request counts, errors and witnesses)"}`);
    out.push(`- time: ${Math.round(s.timings.totalMs / 1000)} s for ${s.loads.length} page loads`);
    if (s.error) out.push(`- **the scenario did not complete**: ${s.error}`);
    out.push("");
    out.push(`### GenClass explore verdict: ${verdictText(s.explore?.verdict)}`);
    out.push("");
    if (s.explore?.reportText) out.push(fence(s.explore.reportText));
    if (s.explore?.groups?.length) {
      const g = s.explore.groups;
      out.push("");
      out.push(`Ignored as noise (differed between the two baselines): ${g.flatMap((x) => x.noise).slice(0, 12).map((n) => `\`${n}\``).join(", ") || "nothing"}.`);
    }
    out.push("");
    if (s.findings.length) {
      for (const f of s.findings) {
        out.push(`### Finding ${f.id} (${f.kind}): ${f.title}`);
        out.push("");
        out.push(`- replay: **${f.replay?.verdict ?? "not replayed"}**${f.replay?.note ? ` (${f.replay.note})` : ""}`);
        out.push(`- generated regression test: ${f.testFile ? `\`${f.testFile}\` (runnable copy with the harness's injection: \`${f.huntTestFile}\`)` : "none (the finding has no replayable run)"}`);
        if (f.testRun) out.push(`- the generated test on the app as it stands: **${f.testRun.status}**${f.testRun.status === "failed" ? " (expected while the bug is there)" : f.testRun.status === "passed" ? " (it should fail while the bug is there: read the test and the explanation before trusting the finding)" : ""}`);
        out.push("");
        out.push("Evidence in causal order, the recorded steps and the delivery order (genclass_explain, verbatim):");
        out.push("");
        out.push(fence(f.explainText));
        out.push("");
        out.push("Replay result (genclass_replay, verbatim):");
        out.push("");
        out.push(fence(f.replay?.text ?? "(no replay)"));
        if (f.testRun?.output) {
          out.push("");
          out.push("Generated test output (last lines):");
          out.push("");
          out.push(fence(f.testRun.output));
        }
        out.push("");
      }
    } else out.push("No race finding from GenClass for this scenario.\n");
    out.push("### Other findings GenClass recorded on these loads");
    out.push("");
    const others = s.otherFindings ?? [];
    if (!others.length) out.push("None: no duplicate request from separate clicks, no response that overwrote newer data, no uncaught error.");
    else {
      out.push(`${others.length} finding(s), not from the order comparison, so not replayed here (genclass_replay can). A witness is a fact, never a diagnosis: many apps repair an overwrite a moment later, and some overwrites are intended (AGENT.md section 2). ${others.length > OTHERS_IN_FULL ? `The first ${OTHERS_IN_FULL} explanations are printed in full; report.json holds all of them.` : ""}`);
      out.push("");
      out.push(table(["id", "kind", "on loads", "generated test", "title (recorded page strings, quoted)"], others.map((o) => [o.id, o.kind, `${o.runs} of ${s.loads.length}`, o.testFile ?? "", o.title])));
      out.push("");
    }
    for (const o of others.slice(0, OTHERS_IN_FULL)) {
      out.push(`#### ${o.id} (${o.kind}, on ${o.runs} of ${s.loads.length} loads): ${o.title}`);
      out.push("");
      out.push(fence(o.explainText));
      out.push("");
    }
    const notDone = s.loads.filter((l) => l.stepsError);
    if (notDone.length) {
      out.push("### Loads whose steps could not be done (the harness's observation, not GenClass's verdict)");
      out.push("");
      out.push(`On ${notDone.length} of ${s.loads.length} loads the scenario's steps failed because the page did not offer what they needed. GenClass groups such a load by its recorded actions (none), so it has no baseline to compare with and is left out of the verdict above; what the page showed at the end is recorded here. If these are seeded loads and the baselines ran the steps, the page's end state depended on the delivery order before the user did anything.`);
      out.push("");
      for (const l of notDone) {
        out.push(`- load ${l.index + 1} (${l.schedule?.label ?? "no schedule"}, run ${l.run ?? "?"}): ${l.stepsError}`);
        if (l.pageText?.length) out.push("", fence(l.pageText.join("\n")));
        out.push("");
      }
    }
    out.push("");
    out.push("### DOM oracle (the harness's own comparison, not GenClass's verdict)");
    out.push("");
    if (!s.oracle || s.oracle.status === "none") out.push("The scenario defines no oracle.");
    else {
      out.push(`${s.oracle.note}.`);
      if (s.oracle.status === "noisy") out.push("", fence(JSON.stringify(s.oracle.diff, null, 2), "json"));
      for (const d of s.oracle.differing ?? []) out.push("", `- load ${d.load + 1} (${d.label}, run ${d.run})${d.stepsError ? ` (the steps could not be done on this load: ${d.stepsError})` : ""}:`, "", fence(JSON.stringify(d.diff, null, 2), "json"));
    }
    out.push("");
    out.push("### Page loads");
    out.push("");
    out.push(table(["#", "phase", "schedule (assigned by the bridge)", "run", "quiet point", "forced", "witnesses", "page errors", "connected after", "steps done after", "quiet after", "note"], s.loads.map(loadRow)));
    out.push("");
    const con = s.loads.flatMap((l) => (l.console ?? []).map((c) => `load ${l.index + 1} [${c.type}] ${c.text}`));
    const errs = s.loads.flatMap((l) => (l.pageErrors ?? []).map((e) => `load ${l.index + 1}: ${e}`));
    out.push("### Console");
    out.push("");
    out.push(`GenClass's own console messages: ${con.length ? "" : "none."}`);
    if (con.length) out.push("", fence(con.slice(0, 60).join("\n")));
    out.push("");
    out.push(`The page's uncaught errors (any source): ${errs.length ? "" : "none."}`);
    if (errs.length) out.push("", fence(errs.slice(0, 60).join("\n")));
    out.push("");
  }
  out.push(...whatThisDoesNotShow(r));
  return out.join("\n") + "\n";
}

function whatThisDoesNotShow(r) {
  const fields = r.scenarios.reduce((n, s) => n + (s.discovered?.fields ?? 0), 0);
  const capped = r.scenarios.some((s) => (s.discovered?.fields ?? 0) >= 300);
  const notQuiet = r.scenarios.reduce((n, s) => n + s.loads.filter((l) => l.run && !l.settled).length, 0);
  const forced = r.scenarios.reduce((n, s) => n + s.loads.reduce((m, l) => m + (l.snapshot?.forced ?? 0), 0), 0);
  const early = r.scenarios.reduce((n, s) => n + s.loads.reduce((m, l) => m + (l.hunt?.requestsBeforeConnect ?? 0), 0), 0);
  return [
    "## What this does not show",
    "",
    `- **State the runtime did not discover.** GenClass compares store fields only for stores it knows: registered ones (none here, the app's source was not touched) and discovered ones (React 16.8 and later component state through the React DevTools hook, Redux and Redux Toolkit stores through the Redux DevTools globals, Zustand \`devtools\` stores). ${fields ? `In this run the final snapshots held ${fields} discovered state field(s) across the scenarios.` : "In this run no state field was discovered: the verdicts rest on page text lines, form values, request counts per signature, errors and witnesses."}${capped ? " A snapshot holds at most 300 state fields and this page reached that cap, so state paths beyond the first 300 (in the store's own order) were not compared; page text and form values still were." : ""} A race that changes only state the page never renders, in a store GenClass does not see, is invisible here.`,
    `- **${r.options.model === "skipped" ? "The model was skipped" : "The model ran"}.** The explore verdict does not use it: it compares final states. ${r.options.model === "skipped" ? "What is missing are the on-device model's own detections (kind `detection`), which an app with GenClass installed would also get; `--model` loads it." : "Its detections are a model opinion, labelled as such by the MCP server."}`,
    `- **Explore's limits** (docs/runtime/AGENT.md section 8). The same steps are needed on every load and each load must reach a quiet point (loads that did not: ${notQuiet}). A scenario whose requests come in a different order on each run gets different request keys and is not compared reliably. WebSocket and EventSource messages are recorded, never reordered. Failure responses are not held. Protected requests (payments, auth, the presets) are never held${r.options.holdProtected ? " (except in this run: --hold-protected was set)" : " unless --hold-protected"}. A response is never held longer than its delay plus the hold limit; after that it is delivered and the run is marked forced (forced deliveries in this run: ${forced}). A wrong state the page repaired before the quiet point shows as an \`overwrote-newer\` witness, not as a different final state.`,
    `- **The injection is the harness's.** GenClass was put on the page by this harness (${r.injection.how}), not by the app. Requests that completed before the agent link was connected were recorded but not scheduled (${early} across all loads). Service workers were blocked and CSP bypassed, in the test browser only. The page's own behaviour is otherwise unchanged: observe mode never holds, delays or changes anything, and a schedule changes only when each response reaches the app.`,
    "- **The DOM oracle is not GenClass's verdict.** The section with that name is the harness's own comparison of what the scenario author chose to read from the page; it is there so a race GenClass reports can be checked against something GenClass did not write, and so a difference GenClass did not see is at least listed.",
    `- **Counts are samples, not rates.** "${r.options.runs} seeded orders" are ${r.options.runs} samples of possible deliveries; "no race" means none of these orders changed the final state, not that none can. Before publishing a result, reproduce it without GenClass (a slow network profile or a server-side delay), show the fixed variant with no race, and name the app's commit (README, "Using a result publicly").`,
    "",
  ];
}
