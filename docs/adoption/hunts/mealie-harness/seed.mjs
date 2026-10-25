// Seeds a local Mealie dev instance with recipes through its API (default admin of a fresh dev database).
const API = "http://localhost:9000";
const form = new URLSearchParams({ username: "changeme@example.com", password: "MyPassword" });
const t = await (await fetch(`${API}/api/auth/token`, { method: "POST", body: form })).json();
if (!t.access_token) throw new Error("login failed: " + JSON.stringify(t));
const H = { authorization: `Bearer ${t.access_token}`, "content-type": "application/json" };
const mains = ["Chicken", "Chickpea", "Chili", "Chipotle", "Beef", "Beet", "Pork", "Potato", "Salmon", "Salsa", "Tofu", "Tomato", "Lamb", "Lemon", "Mushroom", "Mustard", "Shrimp", "Spinach", "Turkey", "Tuna"];
const dishes = ["Soup", "Stew", "Curry", "Salad", "Tacos", "Pasta", "Pie", "Bowl", "Sandwich", "Skewers", "Casserole", "Stir Fry", "Burger", "Wrap", "Risotto"];
let made = 0;
for (const m of mains) for (const d of dishes) {
  const name = `${m} ${d}`;
  const r = await fetch(`${API}/api/recipes`, { method: "POST", headers: H, body: JSON.stringify({ name }) });
  if (r.ok) made++; else console.log(name, r.status, await r.text());
}
const all = await (await fetch(`${API}/api/recipes?perPage=1`, { headers: H })).json();
console.log(JSON.stringify({ made, total: all.total }));
