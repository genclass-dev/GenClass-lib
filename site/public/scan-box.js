// The scan box on genclass.dev (site/visual.py, scanform; rendered only while visual.json has scan_live: true): checks
// the address in the browser, then opens /scan?url=<address>, the page check's own route (scan-worker/), which
// normalises and checks the address again and answers every refusal with a message. It never opens the
// genclass.dev/<address> path form: the site worker hands a path to the page check only when it passes rules this
// script does not copy (the IANA TLD list, URL-safe characters after decoding, file-like names), and a path that fails
// them is a bare 404. Without JavaScript the form is the same plain GET to /scan?url=.
(() => {
  const RESERVED = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|test|invalid|example|onion)$/i;
  const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

  function target(raw) {
    const s = raw.trim();
    if (!s) return { error: "Enter the address of a public page, such as example.com." };
    if (/\s/.test(s)) return { error: "An address has no spaces." };
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
    if (scheme && !/^https?$/i.test(scheme[1])) return { error: "Only http and https pages can be scanned." };
    let u;
    try {
      u = new URL(scheme ? s : "https://" + s);
    } catch {
      return { error: "That is not a web address. Try something like example.com/pricing." };
    }
    if (u.username || u.password) return { error: "Remove the user name and password from the address." };
    if (u.port) return { error: "The scan loads pages on the default port only. Remove the port from the address." };
    const host = u.hostname.replace(/\.$/, "").toLowerCase();
    if (host.startsWith("[") || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) return { error: "Enter a host name, not an IP address." };
    const labels = host.split(".");
    const tld = labels[labels.length - 1];
    if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld))
      return { error: "That host name is not a public one. Try something like example.com." };
    if (RESERVED.test(host)) return { error: "The scan runs on our servers, so it can only load pages on the public internet." };
    if (host === "genclass.dev" || host.endsWith(".genclass.dev")) return { error: "Enter the address of your own page." };
    const path = u.pathname === "/" ? "" : u.pathname;
    return { path: "/scan?url=" + encodeURIComponent((u.protocol === "http:" ? "http://" : "") + host + path + u.search) };
  }

  for (const form of document.querySelectorAll("form[data-scan]")) {
    const input = form.querySelector('input[name="url"]');
    const msg = form.querySelector("[data-scan-msg]");
    if (!input || !msg) continue;
    form.noValidate = true;
    input.addEventListener("input", () => {
      if (!input.hasAttribute("aria-invalid")) return;
      input.removeAttribute("aria-invalid");
      msg.textContent = "";
      delete msg.dataset.state;
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const t = target(input.value);
      if (t.error) {
        input.setAttribute("aria-invalid", "true");
        msg.dataset.state = "error";
        msg.textContent = t.error;
        input.focus();
        return;
      }
      msg.dataset.state = "go";
      msg.textContent = "Opening the page check…";
      location.assign(t.path);
    });
  }
})();
