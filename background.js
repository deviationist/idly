// Idly service worker.
// Idly's own list (chrome.storage.local "sites") says which websites to keep
// logged in; host permissions only say what Idly is allowed to touch. This worker
// is the only writer of the list, keeps content scripts registered for listed
// sites, and drives a chrome.alarms tick. Alarms keep firing for background tabs,
// where the page's own setInterval would be throttled to about once a minute or less.

import {
  DEFAULTS, LOCAL_DEFAULTS, parseInput, planAdd, patternFor, covers, baseOf, coveringEntry, entriesFromOrigins,
} from "./shared.js";

const SCRIPT_ID = "idly-content";
const ALARM = "idly-tick";
const JITTER_MS = [1000, 3000];

// Debug mode (off by default, toggled in the popup footer) writes a timeline to this
// worker's Console: brave://extensions → Idly → Inspect views → service worker.
// A worker only keeps logs while its DevTools is open. Errors are always logged.
let debug = chrome.storage.sync.get({ debug: false }).then((s) => s.debug);
const time = () => new Date().toLocaleTimeString();
const log = async (...args) => { if (await debug) console.info(`[Idly ${time()}]`, ...args); };

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

async function getLocal() {
  return { ...LOCAL_DEFAULTS, ...(await chrome.storage.local.get(LOCAL_DEFAULTS)) };
}

const hasAccess = (entry) => chrome.permissions.contains({ origins: [patternFor(entry)] });

// Listed sites Idly currently has access to. Only these get the content script.
async function activeSites() {
  const { sites } = await getLocal();
  const access = await Promise.all(sites.map(hasAccess));
  return sites.filter((_, i) => access[i]);
}

// Runs one change at a time: permission and storage events arrive in bursts, and
// the list is read-modify-write.
let queue = Promise.resolve();
function serial(task) {
  queue = queue.then(task).catch((e) => console.error("[Idly]", e));
  return queue;
}

// ---- The list ----------------------------------------------------------------

// The popup records the requested entry as "pending" just before the permission
// prompt, because it usually closes while the prompt is open. Once the grant exists,
// the entry joins the list here. Safe to call repeatedly.
async function commitPending() {
  const { sites, pending } = await getLocal();
  if (!pending || !(await hasAccess(pending))) return;
  const { host, wildcard } = parseInput(pending);
  const plan = host ? planAdd(sites, host, wildcard) : { error: "invalid" };
  // A wildcard that replaces narrower entries just drops them from the list; their
  // grants are revoked by pruneGrants once nothing listed overlaps them.
  await chrome.storage.local.set(plan.error ? { pending: null } : { sites: plan.sites, pending: null });
  if (plan.error) log(`not added ${pending}: ${plan.error}`);
  else log(`added ${plan.entry}${plan.replaced.length ? `, replacing ${plan.replaced.join(", ")}` : ""}`);
}

// Per-site settings from the popup. Empty values are dropped, so a site with no
// options has no key at all.
async function setOptions(entry, next) {
  const { sites, options } = await getLocal();
  if (!sites.includes(entry)) return;
  const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v));
  const { [entry]: _, ...rest } = options;
  await chrome.storage.local.set({ options: Object.keys(clean).length ? { ...rest, [entry]: clean } : rest });
  log(`options for ${entry}: ${JSON.stringify(clean)}`);
}

// Options of entries that left the list (removed, replaced or revoked) go with them.
async function pruneOptions() {
  const { sites, options } = await getLocal();
  const kept = Object.fromEntries(Object.entries(options).filter(([e]) => sites.includes(e)));
  if (Object.keys(kept).length !== Object.keys(options).length) await chrome.storage.local.set({ options: kept });
}

async function removeEntry(entry) {
  const { sites } = await getLocal();
  await chrome.storage.local.set({ sites: sites.filter((s) => s !== entry) });
  log(`removed ${entry}`);
}

// If the user revokes a site in the browser's settings, Idly can't run there any
// more, so it leaves the list too.
async function dropRevoked() {
  const { sites } = await getLocal();
  const access = await Promise.all(sites.map(hasAccess));
  if (access.every(Boolean)) return;
  await chrome.storage.local.set({ sites: sites.filter((_, i) => access[i]) });
  log(`unlisted (access revoked in the browser): ${sites.filter((_, i) => !access[i]).join(", ")}`);
}

// Revokes grants that no listed entry needs. A grant that overlaps a listed entry
// (either one covers the other) is kept: Chrome doesn't document how revoking
// overlapping patterns behaves, and a listed site must never lose access.
// Note that permissions.remove only drops the *active* permission; the browser
// keeps the grant on record under Site access until the user clears it there.
async function pruneGrants() {
  const { sites, pending } = await getLocal();
  const keep = pending ? [...sites, pending] : sites; // a grant may land before its commit
  const overlaps = (a, b) => covers(a, baseOf(b)) || covers(b, baseOf(a));
  const { origins = [] } = await chrome.permissions.getAll();
  const stale = entriesFromOrigins(origins).filter((g) => !keep.some((s) => overlaps(s, g.entry)));
  if (!stale.length) return;
  await chrome.permissions.remove({ origins: stale.flatMap((g) => g.origins) }).catch(() => {});
  log(`revoked access: ${stale.map((g) => g.entry).join(", ")}`);
}

// ---- Applying the list -------------------------------------------------------

async function syncRegistration(sites) {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (!sites.length) return;
  await chrome.scripting.registerContentScripts([{
    id: SCRIPT_ID,
    js: ["words.js", "detect.js", "content.js"],
    matches: sites.map(patternFor),
    runAt: "document_idle",
    allFrames: true,
    persistAcrossSessions: true,
  }]);
}

async function syncAlarm() {
  const { intervalMin } = await getSettings();
  await chrome.alarms.clear(ALARM);
  // Chrome's minimum alarm period is 30 seconds.
  chrome.alarms.create(ALARM, { periodInMinutes: Math.max(0.5, intervalMin) });
}

async function enabledTabs(sites) {
  sites ??= await activeSites();
  if (!sites.length) return [];
  return chrome.tabs.query({ url: sites.map(patternFor) });
}

// Badges enabled tabs and stops Chrome's Memory Saver from discarding them.
// A discarded tab runs no scripts, so the session would expire unseen and the
// tab would reload into the login page when you switch back to it.
// Every other tab is told to stop, in case it runs content.js from before a removal.
async function refreshTabs(sites) {
  const all = await chrome.tabs.query({});
  const on = new Set((await enabledTabs(sites)).map((t) => t.id));
  for (const t of all) {
    chrome.action.setBadgeText({ tabId: t.id, text: on.has(t.id) ? "ON" : "" });
    if (t.autoDiscardable === on.has(t.id)) {
      chrome.tabs.update(t.id, { autoDiscardable: !on.has(t.id) }).catch(() => {});
    }
  }
  chrome.action.setBadgeBackgroundColor({ color: "#1b7d44" });
  chrome.action.setBadgeTextColor({ color: "#ffffff" });
  return { all, on };
}

async function apply() {
  const sites = await activeSites();
  await syncRegistration(sites);
  await syncAlarm();
  const { all, on } = await refreshTabs(sites);
  for (const t of all) {
    if (on.has(t.id)) {
      // Inject into tabs that were already open when the site was added.
      chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ["words.js", "detect.js", "content.js"] }).catch(() => {});
    } else {
      // Only tabs still running content.js answer, so this logs just real stops.
      chrome.tabs.sendMessage(t.id, { type: "idly:stop" })
        .then((s) => s && log(`stopped ${s.host} (tab ${t.id})`), () => {});
    }
  }
}

// ---- Theme-matched toolbar icon ----------------------------------------------

// Deep green on light toolbars, pale green on dark ones. The manifest can't express
// this in Chrome, and service workers have no matchMedia, so offscreen.js watches
// the theme and reports it here.
const iconSet = (theme) => ({ 16: `icons/${theme}/icon-16.png`, 32: `icons/${theme}/icon-32.png` });

async function ensureThemeWatcher() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen
    .createDocument({ url: "offscreen.html", reasons: ["MATCH_MEDIA"], justification: "Match the toolbar icon to the light or dark theme" })
    .catch(() => {}); // Another call may have created it first.
}

// ---- Events ------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "idly:scheme") chrome.action.setIcon({ path: iconSet(msg.dark ? "dark" : "light") });
  if (msg?.type === "idly:commit") serial(commitPending);
  if (msg?.type === "idly:remove") serial(() => removeEntry(msg.entry));
  if (msg?.type === "idly:extended") log(`session warning on ${msg.host}: clicked "${msg.label}"`);
  if (msg?.type === "idly:keepalive") log(`keepalive on ${msg.host} ${msg.url}: ${msg.result}`);
  if (msg?.type === "idly:options") serial(() => setOptions(msg.entry, msg.options));
});

async function startup() {
  await ensureThemeWatcher();
  await serial(dropRevoked);
  await serial(apply);
}

chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  // 0.2 used the granted permissions as its list: carry those over once.
  if (reason === "update" && previousVersion?.startsWith("0.2")) {
    await serial(async () => {
      const { sites } = await getLocal();
      if (sites.length) return;
      const { origins = [] } = await chrome.permissions.getAll();
      await chrome.storage.local.set({ sites: entriesFromOrigins(origins).map((e) => e.entry) });
    });
  }
  await chrome.storage.sync.remove("sites"); // 0.1 kept a synced copy
  await startup();
});
chrome.runtime.onStartup.addListener(startup);

chrome.permissions.onAdded.addListener(() => serial(commitPending));
chrome.permissions.onRemoved.addListener(() => serial(dropRevoked));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.sites) {
    serial(pruneOptions);
    serial(pruneGrants);
    serial(apply);
  }
  if (area === "sync" && changes.intervalMin) syncAlarm();
  if (area === "sync" && changes.debug) debug = Promise.resolve(changes.debug.newValue);
});

// Each tab gets its nudge after a random 1–3 s delay, so ticks aren't perfectly periodic.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  const [min, max] = JITTER_MS;
  const sites = await activeSites();
  const { options } = await getLocal();
  const tabs = await enabledTabs(sites);
  log(`tick: ${tabs.length} tab(s) to nudge`);
  for (const tab of tabs) {
    const delay = min + Math.random() * (max - min);
    // tabs.query only returns url for tabs Idly has access to, which these are.
    const host = tab.url ? new URL(tab.url).hostname : "";
    const siteOptions = options[coveringEntry(sites, host)] ?? {};
    setTimeout(() => {
      chrome.tabs.sendMessage(tab.id, { type: "idly:nudge", options: siteOptions }).then(
        (s) => log(`  nudged ${s?.host ?? "?"} (tab ${tab.id}, +${(delay / 1000).toFixed(1)} s, ${s?.visibility}, focus ${s?.focus})`),
        (e) => log(`  couldn't nudge tab ${tab.id}: ${e.message}`),
      );
    }, delay);
  }
});

chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === "complete") refreshTabs();
});
chrome.tabs.onActivated.addListener(() => refreshTabs());
