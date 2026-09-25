// Idly service worker.
// Owns the list of enabled domains, keeps content scripts registered for them,
// and drives a chrome.alarms tick. Alarms keep firing for background tabs,
// where the page's own setInterval would be throttled to about once a minute or less.

import { DEFAULTS, patternFor } from "./shared.js";

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
  chrome.action.setBadgeBackgroundColor({ color: "#1f8a4c" });
}

// Inject into tabs that were already open when a site was enabled.
async function injectExisting() {
  for (const tab of await enabledTabs()) {
    chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] })
      .catch(() => {});
  }
}

async function resync() {
  await syncRegistration();
  await syncAlarm();
  await injectExisting();
  await refreshTabs();
}

chrome.runtime.onInstalled.addListener(resync);
chrome.runtime.onStartup.addListener(resync);

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
