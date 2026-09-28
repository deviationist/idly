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
// Errors are always logged (not gated on debug), and timestamped like everything else.
const logError = (...args) => console.error(`[Idly ${time()}]`, ...args);

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
  queue = queue.then(task).catch((e) => logError(e));
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

// ---- Bringing a tab forward ------------------------------------------------------

// Opt-in per site (options.reveal). Some sites only build their logout warning while
// the tab is visible: a hidden tab runs no animation frames, so the warning never
// appears and there's nothing to click, while the site's own timer logs you out. When
// such a site's title turns into a warning in a hidden tab, content.js asks for the
// tab to be shown; it clicks the warning, says so, and the previous tab comes back.
// To the site this is the same as the user glancing at the tab.
// Several sites can warn at once, so tabs are brought forward one at a time: each
// switches back to the user's tab before the next one comes forward.
const REVEAL_WAIT_MS = 3000;
const revealing = new Map();   // tabId -> resolve(outcome), while it's in front
const queued = new Set();      // tabIds waiting their turn
const settled = new Set();     // queued tabs that sorted themselves out meanwhile
let revealQueue = Promise.resolve();

function queueReveal(tab) {
  if (!tab?.id || queued.has(tab.id) || revealing.has(tab.id)) return;
  queued.add(tab.id);
  revealQueue = revealQueue.then(async () => {
    queued.delete(tab.id);
    if (settled.delete(tab.id)) return log(`reveal tab ${tab.id}: skipped, it was handled while waiting`);
    await reveal(tab);
  }).catch((e) => logError("reveal failed:", e));
}

async function reveal(tab) {
  const host = tab.url ? new URL(tab.url).hostname : "";
  const sites = await activeSites();
  const { options } = await getLocal();
  const entry = coveringEntry(sites, host);
  if (!entry || !options[entry]?.reveal) return log(`reveal refused for ${host || "?"}: not enabled for this site`);
  const win = await chrome.windows.get(tab.windowId);
  if (win.state === "minimized") return log(`reveal ${host}: window is minimized, can't bring the tab forward`);
  const [previous] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (!previous || previous.id === tab.id) return;

  const started = Date.now();
  const done = new Promise((resolve) => {
    revealing.set(tab.id, resolve);
    setTimeout(() => resolve("no click within 3 s"), REVEAL_WAIT_MS);
  });
  await chrome.tabs.update(tab.id, { active: true });
  log(`reveal ${host}: brought tab ${tab.id} forward (from tab ${previous.id})`);
  const outcome = await done;
  revealing.delete(tab.id);
  // Switch back only if the revealed tab is still in front, so a tab the user picked
  // in the meantime isn't taken away from them.
  const [now] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  const back = now?.id === tab.id;
  if (back) await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
  log(`reveal ${host}: ${outcome}; ${back ? `back to tab ${previous.id}` : "left as is (you switched tabs)"} after ${Date.now() - started} ms`);
}

// ---- Page timer ---------------------------------------------------------------------

// Opt-in per site (options.pageCall). Some sites log you out from a timer on their own
// page, a web component with a public method such as "user was active" or "stop". On
// each nudge content.js asks for that method to be called, and this runs it in the
// page's own JavaScript world (content scripts can't see page-defined methods). The
// element and method come from the stored options, never from the message, and only
// names are stored: nothing from the settings is ever run as code.
async function pageCall(sender, phase) {
  const tab = sender?.tab;
  const host = tab?.url ? new URL(tab.url).hostname : "";
  const sites = await activeSites();
  const { options } = await getLocal();
  const call = options[coveringEntry(sites, host)]?.pageCall;
  const method = phase === "cap" ? call?.capMethod : call?.method;
  if (!method) return { skipped: "no page timer set for this site" };
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [sender.frameId ?? 0] },
    world: "MAIN",
    args: [call.selector, method],
    func: callPageMethod,
  });
  const result = injection?.result ?? { error: "no result" };
  if (result.called || result.error) log(`page timer on ${host}: ${call.selector}.${method}() → ${JSON.stringify(result)}`);
  return result;
}

// Runs inside the page, so it must be self-contained. Calls method() on every element
// matching selector, including inside shadow roots, and reports what it found.
function callPageMethod(selector, method) {
  const found = [];
  const walk = (root) => {
    found.push(...root.querySelectorAll(selector));
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot);
  };
  try { walk(document); } catch (e) { return { error: `bad selector: ${e.message}` }; }
  let called = 0;
  const errors = [];
  for (const el of found) {
    if (typeof el[method] !== "function") continue;
    try { el[method](); called++; } catch (e) { errors.push(e.message); }
  }
  return { found: found.length, called, ...(errors.length && { error: errors[0] }) };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === "idly:page-call") {
    pageCall(sender, msg.phase).then(reply, (e) => reply({ error: e.message }));
    return true;   // replies asynchronously
  }
  if (msg?.type === "idly:reveal") queueReveal(sender?.tab);
  if (msg?.type === "idly:reveal-done") {
    const id = sender?.tab?.id;
    if (revealing.has(id)) revealing.get(id)(msg.outcome);
    else if (queued.has(id)) settled.add(id);
  }
  if (msg?.type === "idly:scheme") chrome.action.setIcon({ path: iconSet(msg.dark ? "dark" : "light") });
  if (msg?.type === "idly:commit") serial(commitPending);
  if (msg?.type === "idly:remove") serial(() => removeEntry(msg.entry));
  if (msg?.type === "idly:extended") log(`session warning on ${msg.host}: clicked "${msg.label}" after ${msg.waited} ms`);
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
  if (area === "local" && changes.options) nudgeTabs({ jitter: false });
  if (area === "sync" && changes.debug) debug = Promise.resolve(changes.debug.newValue);
});

// Each tab gets its nudge after a random 1–3 s delay, so ticks aren't perfectly periodic.
// Sends a nudge to every enabled tab, carrying that site's current options. The
// alarm jitters each send by 1-3 s; an options change nudges immediately so a
// changed cap/keepalive/simulate applies without waiting for the next tick.
async function nudgeTabs({ jitter } = { jitter: true }) {
  const [min, max] = jitter ? JITTER_MS : [0, 0];
  const sites = await activeSites();
  const { options } = await getLocal();
  const tabs = await enabledTabs(sites);
  log(`${jitter ? "tick" : "refresh"}: ${tabs.length} tab(s) to nudge`);
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
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) nudgeTabs({ jitter: true });
});

chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === "complete") refreshTabs();
});
chrome.tabs.onActivated.addListener(() => refreshTabs());
