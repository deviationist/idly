import {
  DEFAULTS, LOCAL_DEFAULTS, MESSAGES, KEEPALIVE_MIN, patternFor, baseOf, coveringEntry, parseKeepalive,
  parseInput, planAdd, stripWww, hasWildcardPrefix, clampInterval,
} from "./shared.js";

const $ = (id) => document.getElementById(id);
const field = $("domain");
const subdomains = $("subdomains");
const pageSubdomains = $("page-subdomains");
let sites = []; // Idly's list, from chrome.storage.local. background.js is its only writer.
let options = {}; // Per-site settings, keyed by entry. Also written only by background.js.
let openEntry = null; // The site whose options panel is open.
let currentHost = null;

const coveringSite = (host) => coveringEntry(sites, host);

async function loadSites() {
  ({ sites, options } = await chrome.storage.local.get(LOCAL_DEFAULTS));
}

async function load() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  $("interval").value = settings.intervalMin;
  pageSubdomains.checked = settings.pageSubdomains;
  $("debug").checked = settings.debug;
  chrome.storage.local.set({ pending: null }); // left over from a declined prompt
  await loadSites();

  // activeTab exposes the URL of the tab the popup was opened from.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /^https?:/.test(tab.url)) {
    const parsed = parseInput(tab.url);
    if (parsed.host) currentHost = parsed.host;
  }
  render();
}

function render() {
  renderCurrent();
  renderList();
}

function renderCurrent() {
  const btn = $("current-btn");
  const status = $("current-status");
  const scope = $("page-scope");
  const hint = $("page-hint");
  if (!currentHost) {
    $("current-host").textContent = "Idly can't run on this page.";
    status.textContent = "";
    status.className = "";
    btn.hidden = scope.hidden = hint.hidden = true;
    return;
  }
  $("current-host").textContent = currentHost;
  btn.hidden = false;
  const cover = coveringSite(currentHost);
  if (cover) {
    status.className = "on";
    status.textContent = cover === currentHost ? "Staying logged in" : `Staying logged in (via ${cover})`;
    btn.textContent = cover === currentHost ? "Stop keeping me logged in" : `Stop for all of ${baseOf(cover)}`;
    btn.className = "";
    btn.onclick = () => removeSite(cover);
    scope.hidden = hint.hidden = true;
  } else {
    status.className = "";
    status.textContent = "Not active";
    btn.textContent = "Keep me logged in";
    btn.className = "primary";
    btn.onclick = () => addEntry(planAdd(sites, currentHost, pageSubdomains.checked));
    scope.hidden = hint.hidden = false;
    hint.textContent = pageSubdomains.checked ? `Adds *.${stripWww(currentHost)}` : `Adds ${currentHost} only`;
  }
}

function renderList() {
  const list = $("sites");
  list.replaceChildren();
  if (!sites.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No websites yet.";
    list.append(li);
  }
  for (const entry of sites) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = entry;
    span.title = entry; // Long hostnames are truncated with an ellipsis.
    const opts = options[entry] ?? {};
    const tags = document.createElement("span");
    tags.className = "tags";
    tags.textContent = [opts.keepalive && "keepalive", opts.simulate && "simulates"].filter(Boolean).join(" · ");
    const more = button("Options", `Options for ${entry}`, () => {
      openEntry = openEntry === entry ? null : entry;
      renderList();
    });
    more.setAttribute("aria-expanded", String(openEntry === entry));
    li.append(span, tags, more, button("Remove", `Remove ${entry}`, () => removeSite(entry)));
    list.append(li);
    if (openEntry === entry) list.append(optionsPanel(entry, opts));
  }
}

function button(text, label, onclick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.setAttribute("aria-label", label);
  b.onclick = onclick;
  return b;
}

// Per-site settings. Synthetic input is off by default because bank bot detection
// can block the whole browser for it (see content.js simulateActivity).
function optionsPanel(entry, opts) {
  const li = document.createElement("li");
  li.className = "options";
  const id = `ka-${sites.indexOf(entry)}`;
  li.innerHTML = `
    <label class="check"><input type="checkbox"> Simulate activity</label>
    <p class="hint warn">Sends fake mouse and key events. Sites with bot protection (banks especially) can block your browser for this, so only use it where there's none.</p>
    <label class="opt-label" for="${id}">Keepalive request (GET)</label>
    <form class="opt-form">
      <input id="${id}" type="text" placeholder="/api/session" spellcheck="false" autocapitalize="off">
      <button type="submit">Save</button>
    </form>
    <p class="error" role="alert"></p>
    <p class="hint">Fetched from the page about every ${KEEPALIVE_MIN} minutes, at irregular intervals, with the page's own cookies. Find a request the page already makes in DevTools → Network.</p>`;
  const [simulate, keepalive] = li.querySelectorAll("input");
  const error = li.querySelector(".error");
  simulate.checked = !!opts.simulate;
  keepalive.value = opts.keepalive ?? "";
  const save = (next) => chrome.runtime.sendMessage({ type: "idly:options", entry, options: { ...opts, ...next } });
  simulate.onchange = () => save({ simulate: simulate.checked });
  li.querySelector("form").onsubmit = (e) => {
    e.preventDefault();
    const parsed = parseKeepalive(keepalive.value, entry);
    error.textContent = parsed.error ?? "";
    if (!parsed.error) save({ keepalive: parsed.url });
  };
  return li;
}

function feedback({ error = "", notice = "" } = {}) {
  $("error").textContent = error;
  $("notice").textContent = notice;
}

// Moves a typed "*." out of the text and into the checkbox. The design draws the
// prefix itself (the .wild span) while the box is ticked.
function takeWildcardPrefix() {
  if (!hasWildcardPrefix(field.value)) return;
  field.value = field.value.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").slice(2);
  subdomains.checked = true;
}

// Shows the cleaned hostname: "https://www.bank.com/login?x=1" becomes "www.bank.com",
// or "bank.com" when subdomains are included. Invalid input is left for submit to report.
function cleanField() {
  const parsed = parseInput(field.value);
  if (parsed.wildcard) subdomains.checked = true;
  if (parsed.host) field.value = subdomains.checked ? stripWww(parsed.host) : parsed.host;
}

field.addEventListener("input", () => {
  feedback();
  takeWildcardPrefix();
});
field.addEventListener("paste", () => setTimeout(cleanField));
subdomains.addEventListener("change", () => {
  feedback();
  if (subdomains.checked && field.value) field.value = stripWww(field.value.trim());
});

$("add").onsubmit = (e) => {
  e.preventDefault();
  cleanField();
  const parsed = parseInput(field.value);
  if (parsed.error) {
    feedback({ error: MESSAGES[parsed.error] });
    field.focus();
    return;
  }
  addEntry(planAdd(sites, parsed.host, parsed.wildcard || subdomains.checked), { fromForm: true });
};

// The popup usually closes while the browser shows its permission prompt, which
// kills this script, so nothing after the request can be relied on to run. The entry
// is therefore recorded as "pending" first, and background.js adds it to the list
// when the grant arrives (permissions.onAdded). When the site was granted before,
// the browser skips the prompt and fires no event, so the popup, still open,
// asks background.js to commit.
// Must be called straight from a click or submit handler: chrome.permissions.request
// needs the user gesture, so it runs before any await.
function addEntry(plan, { fromForm = false } = {}) {
  if (plan.error) return feedback({ error: plan.error });
  chrome.storage.local.set({ pending: plan.entry });
  chrome.permissions.request({ origins: [patternFor(plan.entry)] }).then((granted) => {
    if (!granted) {
      chrome.storage.local.set({ pending: null });
      return feedback({ error: MESSAGES.declined });
    }
    chrome.runtime.sendMessage({ type: "idly:commit" });
    feedback({ notice: plan.replaced.length ? MESSAGES.replaced(plan.replaced, plan.entry) : "" });
    if (fromForm) {
      field.value = "";
      subdomains.checked = true;
    }
  }, () => feedback({ error: MESSAGES.declined }));
}

function removeSite(entry) {
  chrome.runtime.sendMessage({ type: "idly:remove", entry });
  feedback();
}

// Re-render whenever background.js changes the list.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !(changes.sites || changes.options)) return;
  await loadSites();
  render();
});

// Remembered, so the choice sticks for the next "Keep me logged in".
pageSubdomains.addEventListener("change", () => {
  renderCurrent();
  chrome.storage.sync.set({ pageSubdomains: pageSubdomains.checked }).catch(() => {});
});

$("debug").addEventListener("change", (e) => {
  chrome.storage.sync.set({ debug: e.target.checked }).catch(() => feedback({ error: MESSAGES.saveFailed }));
});

// The only place a site's permission can be revoked completely (see removeSite).
// Chromium-based browsers such as Brave accept the chrome:// address.
$("manage").onclick = () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });

$("interval").onchange = async (e) => {
  const v = clampInterval(e.target.value);
  e.target.value = v;
  try {
    await chrome.storage.sync.set({ intervalMin: v });
  } catch {
    feedback({ error: MESSAGES.saveFailed });
  }
};

load();
