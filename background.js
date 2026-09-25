// Idly service worker.
// The list of websites is the browser's granted host permissions (see shared.js).
// This worker keeps content scripts registered for them and drives a
// chrome.alarms tick. Alarms keep firing for background tabs, where the page's
// own setInterval would be throttled to about once a minute or less.

import { DEFAULTS, entriesFromOrigins, entryFromOrigin, patternFor, covers, baseOf, isWildcard } from "./shared.js";

const SCRIPT_ID = "idly-content";
const ALARM = "idly-tick";

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

async function getSites() {
  const { origins = [] } = await chrome.permissions.getAll();
  return entriesFromOrigins(origins);
}

const matchPatterns = (sites) => sites.flatMap((s) => s.origins);

async function syncRegistration() {
  const patterns = matchPatterns(await getSites());
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (!patterns.length) return;
  await chrome.scripting.registerContentScripts([{
    id: SCRIPT_ID,
    js: ["content.js"],
    matches: patterns,
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

async function enabledTabs() {
  const patterns = matchPatterns(await getSites());
  if (!patterns.length) return [];
  return chrome.tabs.query({ url: patterns });
}

// Badges enabled tabs and stops Chrome's Memory Saver from discarding them.
// A discarded tab runs no scripts, so the session would expire unseen and the
// tab would reload into the login page when you switch back to it.
async function refreshTabs() {
  const all = await chrome.tabs.query({});
  const on = new Set((await enabledTabs()).map((t) => t.id));
  for (const t of all) {
    chrome.action.setBadgeText({ tabId: t.id, text: on.has(t.id) ? "ON" : "" });
    if (t.autoDiscardable === on.has(t.id)) {
      chrome.tabs.update(t.id, { autoDiscardable: !on.has(t.id) }).catch(() => {});
    }
  }
  chrome.action.setBadgeBackgroundColor({ color: "#1b7d44" });
  chrome.action.setBadgeTextColor({ color: "#ffffff" });
}

// Inject into tabs that were already open when a site was enabled.
async function injectExisting() {
  for (const tab of await enabledTabs()) {
    chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] })
      .catch(() => {});
  }
}

// A newly granted wildcard replaces the entries it covers ("*.bank.com" makes
// "bank.com" and "auth.bank.com" redundant). This runs here rather than in the
// popup because the popup usually closes while the browser shows its
// permission prompt.
async function replaceCovered(addedOrigins) {
  const wildcards = addedOrigins.map(entryFromOrigin).filter((e) => e && isWildcard(e));
  if (!wildcards.length) return;
  const covered = (await getSites()).filter((s) =>
    wildcards.some((w) => w !== s.entry && covers(w, baseOf(s.entry))));
  if (!covered.length) return;
  await chrome.permissions.remove({ origins: matchPatterns(covered) });
  // Chrome doesn't document how revoking a narrow pattern interacts with a broader
  // grant, so check that the wildcard survived.
  for (const w of wildcards) {
    if (!(await chrome.permissions.contains({ origins: [patternFor(w)] }))) {
      console.error(`[Idly] Revoking entries covered by ${w} also revoked ${w}. Add it again.`);
    }
  }
}

// Runs one resync at a time: permission events can arrive in bursts, and
// overlapping unregister/register calls would fail with a duplicate script ID.
let queue = Promise.resolve();
function resync() {
  queue = queue.then(async () => {
    await syncRegistration();
    await syncAlarm();
    await injectExisting();
    await refreshTabs();
  }).catch((e) => console.error("[Idly] resync failed:", e));
  return queue;
}

// Toolbar icon per theme: deep green on light toolbars, pale green on dark ones.
// The manifest can't express this in Chrome, and service workers have no
// matchMedia, so offscreen.js watches the theme and reports it here.
const iconSet = (theme) => ({ 16: `icons/${theme}/icon-16.png`, 32: `icons/${theme}/icon-32.png` });

async function ensureThemeWatcher() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen
    .createDocument({ url: "offscreen.html", reasons: ["MATCH_MEDIA"], justification: "Match the toolbar icon to the light or dark theme" })
    .catch(() => {}); // Another call may have created it first.
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "idly:scheme") chrome.action.setIcon({ path: iconSet(msg.dark ? "dark" : "light") });
});

async function startup() {
  await ensureThemeWatcher();
  await resync();
}

chrome.runtime.onInstalled.addListener(async () => {
  // Versions before 0.2 kept their own list in storage. The browser's granted
  // permissions are the list now, so drop the old copy.
  await chrome.storage.sync.remove("sites");
  await startup();
});
chrome.runtime.onStartup.addListener(startup);

chrome.permissions.onAdded.addListener(async ({ origins = [] }) => {
  await replaceCovered(origins).catch((e) => console.error("[Idly] replace failed:", e));
  resync();
});
chrome.permissions.onRemoved.addListener(() => resync());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.intervalMin) syncAlarm();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  for (const tab of await enabledTabs()) {
    chrome.tabs.sendMessage(tab.id, { type: "idly:nudge" }).catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === "complete") refreshTabs();
});
chrome.tabs.onActivated.addListener(refreshTabs);
