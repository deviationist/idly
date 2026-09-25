// Site-entry logic shared by the popup and the service worker. Nothing here
// touches browser APIs, so test/shared.test.mjs can run it under plain Node.
//
// Idly keeps its own list of websites (chrome.storage.local "sites"). Host
// permissions only say what Idly may touch: the browser remembers grants even
// after they're removed, and can grant more than the user listed.

// Settings, synced across devices.
export const DEFAULTS = { intervalMin: 1, pageSubdomains: false };
// Per-device state. The list isn't synced because permissions aren't: a synced list
// would show sites Idly can't access on the other device. "pending" is the entry
// waiting for the permission prompt (see popup.js addEntry).
export const LOCAL_DEFAULTS = { sites: [], pending: null };
export const INTERVAL = { min: 0.5, max: 60, step: 0.5 };

export const MESSAGES = {
  empty: "Enter a website address.",
  invalid: "That doesn't look like a website address.",
  duplicate: "Already in the list.",
  covered: (entry) => `Already covered by ${entry}.`,
  replaced: (hosts, entry) => `Replaced ${listJoin(hosts)} with ${entry}.`,
  declined: "Permission was declined.",
  saveFailed: "Couldn't save. Try again.",
};

// A site entry is either an exact host ("bank.com") or a wildcard ("*.bank.com"),
// which covers bank.com itself and every subdomain.
export const isWildcard = (entry) => entry.startsWith("*.");
export const baseOf = (entry) => (isWildcard(entry) ? entry.slice(2) : entry);

// Chrome match pattern for an entry, over http and https.
// Chrome's "*.bank.com" host pattern already includes bank.com itself.
export const patternFor = (entry) => `*://${entry}/*`;

export const covers = (entry, host) => {
  const base = baseOf(entry);
  return host === base || (isWildcard(entry) && host.endsWith(`.${base}`));
};

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const IPV4 = /^\d+(?:\.\d+){3}$/;

// True when the input starts with "*.", with or without a scheme in front.
export const hasWildcardPrefix = (raw) => String(raw).trim().replace(SCHEME, "").startsWith("*.");

// Reduces whatever the user typed or pasted to a hostname.
// "https://user@www.bank.com:8443/login?x=1" becomes { host: "www.bank.com", wildcard: false },
// "*.bank.com" becomes { host: "bank.com", wildcard: true }. On failure it returns
// { error } with a key of MESSAGES.
export function parseInput(raw) {
  let s = String(raw ?? "").trim().toLowerCase().replace(SCHEME, "");
  if (!s) return { error: "empty" };
  const wildcard = s.startsWith("*.");
  if (wildcard) s = s.slice(2);

  let host;
  try { host = new URL(`https://${s}`).hostname; } catch { return { error: "invalid" }; }
  host = host.replace(/\.$/, "");

  const labels = host.split(".");
  if (
    labels.length < 2 ||              // no TLD: "netbank", "localhost"
    host.length > 253 ||
    IPV4.test(host) ||                // IP addresses; IPv6 "[::1]" fails LABEL below
    !labels.every((l) => LABEL.test(l)) ||
    !TLD.test(labels.at(-1))          // all-digit or one-letter TLD
  ) return { error: "invalid" };

  return { host, wildcard };
}

// "*.www.bank.com" is almost never what people mean, and "*.bank.com" covers www anyway.
export const stripWww = (host) =>
  host.startsWith("www.") && host.slice(4).includes(".") ? host.slice(4) : host;

// Works out what adding a host does to the list. Returns { error } (text for the user),
// or { entry, sites, replaced } where sites is the new list.
// - An entry that's already listed, or already covered by a wildcard, is refused.
// - A wildcard replaces the entries it covers: exact hosts and narrower wildcards.
export function planAdd(sites, host, wildcard) {
  if (wildcard) host = stripWww(host);
  const entry = wildcard ? `*.${host}` : host;
  if (sites.includes(entry)) return { error: MESSAGES.duplicate };

  const cover = sites.find((s) => isWildcard(s) && covers(s, host));
  if (cover) return { error: MESSAGES.covered(cover) };

  const replaced = wildcard ? sites.filter((s) => covers(entry, baseOf(s))) : [];
  return { entry, replaced, sites: [...sites.filter((s) => !replaced.includes(s)), entry] };
}

// Maps a granted host-permission pattern back to a site entry:
// "*://*.bank.com/*" → "*.bank.com", "https://www.bank.com/*" → "www.bank.com".
// Returns null for patterns that aren't a single website, such as "*://*/*" or
// "<all_urls>" from the browser's "On all sites" setting.
export function entryFromOrigin(origin) {
  const host = /^(?:\*|https?):\/\/([^/]+)\/\*?$/.exec(origin)?.[1];
  if (!host || host === "*") return null;
  const parsed = parseInput(host);
  if (parsed.error) return null;
  return parsed.wildcard ? `*.${parsed.host}` : parsed.host;
}

// Groups granted patterns by entry: [{ entry, origins }], sorted by domain. One entry
// can have several patterns (the browser may grant http and https separately).
export function entriesFromOrigins(origins) {
  const byEntry = new Map();
  for (const origin of origins) {
    const entry = entryFromOrigin(origin);
    if (entry) byEntry.set(entry, [...(byEntry.get(entry) ?? []), origin]);
  }
  return [...byEntry]
    .map(([entry, origins]) => ({ entry, origins }))
    .sort((a, b) => baseOf(a.entry).localeCompare(baseOf(b.entry)) || b.entry.localeCompare(a.entry));
}

// Clamps the nudge interval to a sane range on the 0.5-minute grid.
export function clampInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.intervalMin;
  const snapped = Math.round(n / INTERVAL.step) * INTERVAL.step;
  return Math.min(INTERVAL.max, Math.max(INTERVAL.min, snapped));
}

function listJoin(items) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
