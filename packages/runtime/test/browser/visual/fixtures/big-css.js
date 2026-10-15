// 5,000 rules that use custom properties (some with no fallback and defined nowhere), none of them matching an
// element: the stylesheet walk has to read them all, and finds nothing to report.
const rules = [":root { " + Array.from({ length: 60 }, (_, i) => `--c${i}: #${(i * 4).toString(16).padStart(2, "0")}2937;`).join(" ") + " }"];
for (let i = 0; i < 5000; i++) rules.push(`.u${i} > .v { color: var(--c${i % 60}); background-color: var(--surface-${i % 7}); border-color: var(--line, #e5e7eb); padding: ${i % 9}px; }`);
const s = document.createElement("style");
s.textContent = rules.join("\n");
document.head.appendChild(s);
