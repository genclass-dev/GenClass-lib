// 2,500 rows x 4 cells: about 10,000 elements of ordinary, readable content.
const rows = document.getElementById("rows");
const frag = document.createDocumentFragment();
for (let i = 0; i < 2500; i++) {
  const r = document.createElement("div");
  r.className = "row";
  for (let j = 0; j < 3; j++) {
    const s = document.createElement("span");
    s.textContent = `Row ${i} cell ${j}`;
    r.appendChild(s);
  }
  frag.appendChild(r);
}
rows.appendChild(frag);
