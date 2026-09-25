import { DEFAULTS, patternFor, normalizeDomain } from "./shared.js";

const $ = (id) => document.getElementById(id);
let sites = [];
let currentHost = null;

// The listed domain that covers host, e.g. "example.com" covers "netbank.example.com".
const coveringDomain = (host) => sites.find((d) => host === d || host.endsWith(`.${d}`));

async function load() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  sites = settings.sites;
  $("interval").value = settings.intervalMin;

  // activeTab exposes the URL of the tab the popup was opened from.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /^https?:/.test(tab.url)) currentHost = normalizeDomain(tab.url);
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
    btn.hidden = true;
    return;
  }
  $("current-host").textContent = currentHost;
  btn.hidden = false;
  const cover = coveringDomain(currentHost);
  if (cover) {
    status.className = "status on";
    status.textContent = cover === currentHost ? "Staying logged in" : `Staying logged in (via ${cover})`;
    btn.textContent = cover === currentHost ? "Stop keeping me logged in" : `Stop for all of ${cover}`;
    btn.className = "";
    btn.onclick = () => removeSite(cover);
  } else {
    status.className = "status";
    status.textContent = "Not active";
    btn.textContent = "Keep me logged in";
    btn.className = "primary";
    btn.onclick = () => addSite(currentHost);
  }
}

function renderList() {
  const list = $("sites");
  list.replaceChildren();
  if (!sites.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No domains yet.";
    list.append(li);
  }
  for (const domain of sites) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = domain;
    const rm = document.createElement("button");
    rm.textContent = "Remove";
    rm.onclick = () => removeSite(domain);
    li.append(span, rm);
    list.append(li);
  }
}

// Must be called straight from a click or submit handler: chrome.permissions.request
// needs the user gesture, so it runs before any await.
function addSite(domain) {
  $("error").textContent = "";
  chrome.permissions.request({ origins: [patternFor(domain)] }).then(async (granted) => {
    if (!granted) return void ($("error").textContent = "Permission was declined.");
    sites = [...sites, domain];
    await chrome.storage.sync.set({ sites });
    render();
  });
}

async function removeSite(domain) {
  sites = sites.filter((s) => s !== domain);
  await chrome.storage.sync.set({ sites });
  chrome.permissions.remove({ origins: [patternFor(domain)] }).catch(() => {});
  render();
}

$("add").onsubmit = (e) => {
  e.preventDefault();
  const domain = normalizeDomain($("domain").value);
  if (!domain) return void ($("error").textContent = "That doesn't look like a domain.");
  if (sites.includes(domain)) return void ($("error").textContent = "Already in the list.");
  $("domain").value = "";
  addSite(domain);
};

$("interval").onchange = async (e) => {
  const v = Math.max(0.5, Number(e.target.value) || DEFAULTS.intervalMin);
  e.target.value = v;
  await chrome.storage.sync.set({ intervalMin: v });
};

load();
