// Counts securitypolicyviolation events (inline scripts are blocked under the fixture's CSP).
window.__violations = [];
document.addEventListener("securitypolicyviolation", (e) => window.__violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI }), true);
