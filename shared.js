export const DEFAULTS = { sites: [], intervalMin: 1 };

// A site entry is either an exact host ("bank.com") or a wildcard ("*.bank.com"),
// which covers bank.com itself and every subdomain.
const isWildcard = (entry) => entry.startsWith("*.");
const baseOf = (entry) => (isWildcard(entry) ? entry.slice(2) : entry);

// Chrome match pattern for an entry, over http and https.
// Chrome's "*.bank.com" host pattern already includes bank.com itself.
export const patternFor = (entry) => `*://${entry}/*`;

export const covers = (entry, host) => {
  const base = baseOf(entry);
  return host === base || (isWildcard(entry) && host.endsWith(`.${base}`));
};

// Turns user input such as "https://auth.bank.com/login" into "auth.bank.com",
// and "*.bank.com" into "*.bank.com". Returns null if it isn't a valid hostname.
export function normalizeDomain(input) {
  let s = String(input).trim().toLowerCase().replace(/^[a-z]+:\/\//, "");
  const wildcard = s.startsWith("*.");
  if (wildcard) s = s.slice(2);
  let host;
  try { host = new URL(`https://${s}`).hostname; } catch { return null; }
  host = host.replace(/\.$/, "");
  if (!/^([a-z0-9-]+\.)+[a-z0-9-]+$|^localhost$/.test(host)) return null;
  return wildcard ? `*.${host}` : host;
}
