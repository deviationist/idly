import {
  DEFAULTS, MESSAGES, patternFor, covers, baseOf,
  parseInput, planAdd, stripWww, hasWildcardPrefix, clampInterval,
} from "./shared.js";

const $ = (id) => document.getElementById(id);
const field = $("domain");
const subdomains = $("subdomains");
let sites = [];
let currentHost = null;

// The listed entry that covers host, preferring an exact match over a wildcard.
const coveringEntry = (host) => sites.find((s) => s === host) ?? sites.find((s) => covers(s, host));

async function load() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  sites = settings.sites;
  $("interval").value = settings.intervalMin;

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
  if (!currentHost) {
    $("current-host").textContent = "Idly can't run on this page.";
    status.textContent = "";
    status.className = "";
    btn.hidden = true;
    return;
  }
  $("current-host").textContent = currentHost;
  btn.hidden = false;
  const cover = coveringEntry(currentHost);
  if (cover) {
    status.className = "on";
    status.textContent = cover === currentHost ? "Staying logged in" : `Staying logged in (via ${cover})`;
    btn.textContent = cover === currentHost ? "Stop keeping me logged in" : `Stop for all of ${baseOf(cover)}`;
    btn.className = "";
    btn.onclick = () => removeSite(cover);
  } else {
    status.className = "";
    status.textContent = "Not active";
    btn.textContent = "Keep me logged in";
    btn.className = "primary";
    btn.onclick = () => addEntry(planAdd(sites, currentHost, false));
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
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "Remove";
    rm.setAttribute("aria-label", `Remove ${entry}`);
    rm.onclick = () => removeSite(entry);
    li.append(span, rm);
    list.append(li);
  }
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

// Must be called straight from a click or submit handler: chrome.permissions.request
// needs the user gesture, so it runs before any await.
function addEntry(plan, { fromForm = false } = {}) {
  if (plan.error) return feedback({ error: plan.error });
  chrome.permissions.request({ origins: [patternFor(plan.entry)] }).then(async (granted) => {
    if (!granted) return feedback({ error: MESSAGES.declined });
    try {
      // background.js drops host permissions that no entry needs any more.
      await chrome.storage.sync.set({ sites: plan.sites });
    } catch {
      return feedback({ error: MESSAGES.saveFailed });
    }
    sites = plan.sites;
    feedback({ notice: plan.replaced.length ? MESSAGES.replaced(plan.replaced, plan.entry) : "" });
    if (fromForm) {
      field.value = "";
      subdomains.checked = true;
    }
    render();
  }, () => feedback({ error: MESSAGES.declined }));
}

async function removeSite(entry) {
  const next = sites.filter((s) => s !== entry);
  try {
    await chrome.storage.sync.set({ sites: next });
  } catch {
    return feedback({ error: MESSAGES.saveFailed });
  }
  sites = next;
  feedback();
  render();
}

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
