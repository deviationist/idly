// Runs background.js against a small fake of the chrome.* APIs it uses.
// Run with: node --test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---- Fake browser ------------------------------------------------------------

function events() {
  const fns = [];
  return { addListener: (f) => fns.push(f), fire: (...a) => fns.forEach((f) => f(...a)) };
}

function area(name, onChanged) {
  let data = {};
  return {
    get: async (defaults) => ({ ...defaults, ...structuredClone(data) }),
    set: async (obj) => {
      const changes = Object.fromEntries(Object.keys(obj).map((k) => [k, { oldValue: data[k], newValue: obj[k] }]));
      data = { ...data, ...structuredClone(obj) };
      onChanged.fire(changes, name);
    },
    remove: async (key) => { delete data[key]; },
    peek: () => data,
  };
}

let chrome, active, granted, sent, registered;

beforeEach(async () => {
  active = new Set();   // what the extension can use now
  granted = new Set();  // what the browser remembers (Site access list)
  sent = [];
  registered = [];
  const onChanged = events();
  chrome = {
    storage: { onChanged, local: area("local", onChanged), sync: area("sync", onChanged) },
    permissions: {
      onAdded: events(), onRemoved: events(),
      contains: async ({ origins }) => origins.every((o) => active.has(o)),
      getAll: async () => ({ origins: [...active] }),
      remove: async ({ origins }) => {
        origins.forEach((o) => active.delete(o)); // granted is kept, as in Chromium
        chrome.permissions.onRemoved.fire({ origins });
        return true;
      },
    },
    scripting: {
      getRegisteredContentScripts: async () => registered,
      unregisterContentScripts: async () => { registered = []; },
      registerContentScripts: async (s) => { registered = s; },
      executeScript: async () => {},
    },
    tabs: {
      query: async ({ url } = {}) => (url ? [] : []),
      update: async () => {}, sendMessage: async (id, msg) => { sent.push(msg.type); },
      onUpdated: events(), onActivated: events(),
    },
    alarms: { clear: async () => {}, create: () => {}, onAlarm: events() },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setBadgeTextColor() {}, setIcon() {} },
    offscreen: { hasDocument: async () => true },
    runtime: { onMessage: events(), onInstalled: events(), onStartup: events() },
  };
  globalThis.chrome = chrome;
  // A fresh module instance per test.
  await import(`../background.js?${Math.random()}`);
});

// The browser's side of chrome.permissions.request after the user clicks Allow.
function userAllows(origin) {
  const fresh = !active.has(origin);
  active.add(origin);
  granted.add(origin);
  if (fresh) chrome.permissions.onAdded.fire({ origins: [origin] });
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const sites = () => chrome.storage.local.peek().sites ?? [];
const message = (msg) => chrome.runtime.onMessage.fire(msg);

// ---- Tests -------------------------------------------------------------------

test("a granted entry is listed even if the popup closed during the prompt", async () => {
  await chrome.storage.local.set({ pending: "*.bank.example" }); // popup, before the prompt
  userAllows("*://*.bank.example/*");                            // popup is already gone
  await settle();
  assert.deepEqual(sites(), ["*.bank.example"]);
  assert.equal(chrome.storage.local.peek().pending, null);
  assert.deepEqual(registered[0]?.matches, ["*://*.bank.example/*"]);
});

test("re-adding a remembered site commits without an onAdded event", async () => {
  active.add("*://bank.example/*");
  await chrome.storage.local.set({ pending: "bank.example" });
  message({ type: "idly:commit" }); // the popup is still open: no prompt was shown
  await settle();
  assert.deepEqual(sites(), ["bank.example"]);
});

test("a declined prompt adds nothing", async () => {
  await chrome.storage.local.set({ pending: "bank.example" });
  message({ type: "idly:commit" });
  await settle();
  assert.deepEqual(sites(), []);
});

test("removing an entry unlists it, revokes its grant and stops open tabs", async () => {
  await chrome.storage.local.set({ pending: "bank.example" });
  userAllows("*://bank.example/*");
  await settle();
  chrome.tabs.query = async ({ url } = {}) => (url ? [] : [{ id: 1, autoDiscardable: false }]);
  message({ type: "idly:remove", entry: "bank.example" });
  await settle();
  assert.deepEqual(sites(), []);
  assert.ok(!active.has("*://bank.example/*"));
  assert.ok(granted.has("*://bank.example/*"), "the browser keeps it on record");
  assert.deepEqual(registered, []);
  assert.ok(sent.includes("idly:stop"));
});

test("a wildcard replaces the entries it covers, without revoking overlapping grants", async () => {
  for (const [entry, origin] of [["bank.example", "*://bank.example/*"], ["auth.bank.example", "*://auth.bank.example/*"]]) {
    await chrome.storage.local.set({ pending: entry });
    userAllows(origin);
    await settle();
  }
  await chrome.storage.local.set({ pending: "*.bank.example" });
  userAllows("*://*.bank.example/*");
  await settle();
  assert.deepEqual(sites(), ["*.bank.example"]);
  assert.ok(active.has("*://*.bank.example/*"));
  assert.ok(active.has("*://bank.example/*"), "overlapping grants are left alone");
});

test("revoking a site in the browser's settings unlists it", async () => {
  await chrome.storage.local.set({ pending: "bank.example" });
  userAllows("*://bank.example/*");
  await settle();
  active.delete("*://bank.example/*");
  chrome.permissions.onRemoved.fire({ origins: ["*://bank.example/*"] });
  await settle();
  assert.deepEqual(sites(), []);
});

test("grants that aren't in the list are not listed", async () => {
  userAllows("*://other.example/*"); // e.g. granted from the browser's own menu
  await settle();
  assert.deepEqual(sites(), []);
});

test("debug logging is off by default and follows the setting", async () => {
  const logged = [];
  const original = console.info;
  console.info = (...a) => logged.push(a.join(" "));
  try {
    chrome.tabs.query = async ({ url } = {}) => (url ? [{ id: 7 }] : [{ id: 7 }]);
    chrome.tabs.sendMessage = async () => ({ host: "bank.example", visibility: "hidden", focus: false });
    await chrome.storage.local.set({ pending: "bank.example" });
    userAllows("*://bank.example/*");
    await settle();
    logged.length = 0;
    chrome.alarms.onAlarm.fire({ name: "idly-tick" });
    await new Promise((r) => setTimeout(r, 3200)); // longer than the jitter
    assert.deepEqual(logged, []);

    await chrome.storage.sync.set({ debug: true });
    chrome.alarms.onAlarm.fire({ name: "idly-tick" });
    await new Promise((r) => setTimeout(r, 3200));
    assert.ok(logged.some((l) => l.includes("tick: 1 tab(s) to nudge")), logged.join("\n"));
    assert.ok(logged.some((l) => l.includes("nudged bank.example (tab 7") && l.includes("hidden, focus false")), logged.join("\n"));
  } finally {
    console.info = original;
  }
});

test("nudges carry the site's options; synthetic input is off unless opted in", async () => {
  const nudges = [];
  chrome.tabs.query = async ({ url } = {}) => [{ id: 3, url: "https://netbank.bank.example/overview" }];
  chrome.tabs.sendMessage = async (id, msg) => { if (msg.type === "idly:nudge") nudges.push(msg.options); return {}; };
  await chrome.storage.local.set({ pending: "*.bank.example" });
  userAllows("*://*.bank.example/*");
  await settle();

  chrome.alarms.onAlarm.fire({ name: "idly-tick" });
  await new Promise((r) => setTimeout(r, 3200));
  assert.deepEqual(nudges.pop(), {}, "no options: dialog clicks only");

  message({ type: "idly:options", entry: "*.bank.example", options: { simulate: false, keepalive: "/api/session" } });
  await settle();
  assert.deepEqual(chrome.storage.local.peek().options, { "*.bank.example": { keepalive: "/api/session" } });
  chrome.alarms.onAlarm.fire({ name: "idly-tick" });
  await new Promise((r) => setTimeout(r, 3200));
  assert.deepEqual(nudges.pop(), { keepalive: "/api/session" });
});

test("options leave with their site", async () => {
  await chrome.storage.local.set({ pending: "bank.example" });
  userAllows("*://bank.example/*");
  await settle();
  message({ type: "idly:options", entry: "bank.example", options: { simulate: true } });
  await settle();
  message({ type: "idly:options", entry: "not-listed.example", options: { simulate: true } });
  await settle();
  assert.deepEqual(chrome.storage.local.peek().options, { "bank.example": { simulate: true } });
  message({ type: "idly:remove", entry: "bank.example" });
  await settle();
  assert.deepEqual(chrome.storage.local.peek().options, {});
});
