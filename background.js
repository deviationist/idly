// Idly service worker.
// Owns the list of enabled domains, keeps content scripts registered for them,
// and drives a chrome.alarms tick. Alarms keep firing for background tabs,
// where the page's own setInterval would be throttled to about once a minute or less.

import { DEFAULTS, patternFor, covers, baseOf } from "./shared.js";

const SCRIPT_ID = "idly-content";
const ALARM = "idly-tick";

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

async function syncRegistration() {
  const { sites } = await getSettings();
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (!sites.length) return;
  await chrome.scripting.registerContentScripts([{
    id: SCRIPT_ID,
    js: ["content.js"],
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

async function enabledTabs() {
  const { sites } = await getSettings();
  if (!sites.length) return [];
  return chrome.tabs.query({ url: sites.map(patternFor) });
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

// Revokes host permissions that no entry needs any more, e.g. after a removal or
// after a wildcard replaced exact entries. A grant that overlaps a listed entry
// (either one covers the other) is left for later: how Chrome revokes overlapping
// patterns isn't documented, and we must never lose access to a listed site.
async function pruneGrants() {
  const { sites } = await getSettings();
  const wanted = new Set(sites.map(patternFor));
  const overlaps = (a, b) => covers(a, baseOf(b)) || covers(b, baseOf(a));
  const { origins = [] } = await chrome.permissions.getAll();
  const stale = origins.filter((o) => {
    if (wanted.has(o)) return false;
    const entry = o.match(/^\*:\/\/(.+)\/\*$/)?.[1];
    return !(entry && sites.some((s) => overlaps(s, entry)));
  });
  if (stale.length) await chrome.permissions.remove({ origins: stale }).catch(() => {});
}

async function resync() {
  await pruneGrants();
  await syncRegistration();
  await syncAlarm();
  await injectExisting();
  await refreshTabs();
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

chrome.runtime.onInstalled.addListener(startup);
chrome.runtime.onStartup.addListener(startup);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && (changes.sites || changes.intervalMin)) resync();
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
