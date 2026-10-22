// The e2e search page: a plain search box whose results are written by each response, the way generated code often
// does it. Buggy by default: a slower answer to an older query can land last and replace newer results. The fixed
// build (window.__FIXED__) keeps only the answer to the latest query. A normal GenClass integration: init in the
// app's entry, connectAgent in development; nothing in it is tuned for the agent.
import { GenClass } from "@genclass/runtime";
import { connectAgent } from "@genclass/runtime/agent";

const rt = GenClass.init({ model: false, report: "silent", telemetry: false });
connectAgent(rt);

const st = rt.atom("search", { query: "", results: [] });
const input = document.querySelector("#q");
const list = document.querySelector("#results");
const heading = document.querySelector("#for");
let latest = 0;

input.addEventListener("input", async () => {
  const q = input.value;
  const id = ++latest;
  st.set((v) => ({ ...v, query: q }));
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const data = await res.json();
  if (window.__FIXED__ && id !== latest) return;
  st.set((v) => ({ ...v, results: data.items }));
});

st.subscribe((v) => {
  list.replaceChildren(...v.results.map((t) => Object.assign(document.createElement("li"), { textContent: t })));
  heading.textContent = v.results.length ? `Results for ${v.results[0].split(" ")[0]}` : "";
});
