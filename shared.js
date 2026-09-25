export const DEFAULTS = { sites: [], intervalMin: 1 };

// "example.com" matches example.com and every subdomain, over http and https.
export const patternFor = (domain) => `*://*.${domain}/*`;

// Turns user input such as "https://www.example.com/login" into "example.com".
// Returns null if the input isn't a valid hostname.
export function normalizeDomain(input) {
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
  let host;
  try { host = new URL(s).hostname; } catch { return null; }
  host = host.replace(/^\*\./, "").replace(/^www\./, "").replace(/\.$/, "");
  if (!/^([a-z0-9-]+\.)+[a-z0-9-]+$|^localhost$/.test(host)) return null;
  return host;
}
