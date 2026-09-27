// Idly content script. It runs only on origins you enable in the popup.
if (!window.__idly) {
  window.__idly = true;

  // The decision logic and word lists live in detect.js / words.js, injected before
  // this script (see background.js). IdlyDetect.decide takes plain facts and says
  // which button to click, so it can be unit-tested without a browser.
  const { decide, countingDown, mentionsSession, numbers } = globalThis.IdlyDetect;

  // Debug logging (toggled in the popup footer, applies without a reload). Every
  // line is timestamped and prefixed so the page console is easy to filter.
  let debug = false;
  const log = (...args) => { if (debug) console.info(`[Idly ${new Date().toLocaleTimeString()}]`, ...args); };

  // Debug: a warning "episode" starts at the first sign that a logout is coming (title,
  // session text, live region or dialog) and ends with a click, the page being left,
  // or two quiet minutes. Every signal is logged with its offset into the episode, and
  // the end logs a one-line summary, so a run reads as a timeline.
  const EPISODE_QUIET_MS = 2 * 60 * 1000;
  let episode = null;
  const since = (t) => `+${((Date.now() - t) / 1000).toFixed(1)} s`;
  function signal(name, detail, { warning = false } = {}) {
    if (!debug) return;
    if (warning && (!episode || Date.now() - episode.last > EPISODE_QUIET_MS)) {
      episode = { start: Date.now(), last: Date.now(), signals: new Set(), checks: 0, dialogs: 0 };
      log(`episode started: a logout warning looks underway (tab ${document.visibilityState})`);
    }
    if (warning) { episode.last = Date.now(); episode.signals.add(name); }
    const at = episode ? ` [${since(episode.start)}]` : "";
    log(`signal ${name}${at} (tab ${document.visibilityState}): ${detail}`);
  }
  function endEpisode(outcome) {
    if (!debug || !episode) return;
    const e = episode;
    episode = null;
    log(`episode ended after ${since(e.start).slice(1)}: ${outcome}; signals: ${[...e.signals].join(", ")}; ` +
      `${e.checks} check(s), dialog ${e.dialogs ? `found ${e.dialogs} time(s)` : "never found"}`);
  }

  // How long since the user's last *real* input. Only trusted events count, so Idly's
  // own synthetic activity never makes the page look used. This is the main guard: a
  // payment or "save changes?" dialog appears right after a click, when idle is ~0.
  let lastInput = Date.now();
  // The current site's options, refreshed on each nudge (see the message handler).
  // maxIdleMin, when set, is a self-imposed logout cap: Idly stops extending the
  // session once you've been idle that long, so an unattended tab still logs out.
  let siteOptions = {};
  let pastCapLogged = false;
  const noteInput = (e) => { if (e.isTrusted) { lastInput = Date.now(); pastCapLogged = false; } };
  for (const type of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "mousedown"]) {
    addEventListener(type, noteInput, { capture: true, passive: true });
  }

  // Collects every match of a selector, also looking inside shadow roots,
  // because these dialogs are often built from web components.
  function deepQueryAll(selector, root = document) {
    const out = [...root.querySelectorAll(selector)];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      if (n.shadowRoot) out.push(...deepQueryAll(selector, n.shadowRoot));
    }
    return out;
  }

  // A background tab doesn't render, so a dialog that animates in (from scale(0), or on
  // the next animation frame) stays 0x0 until the tab is shown. While hidden, only
  // check that the page hasn't hidden it (display, visibility, content-visibility).
  const visible = (el) => {
    if (!el.checkVisibility({ visibilityProperty: true })) return false;
    if (document.hidden) return true;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const labelOf = (b) => (b.innerText || b.value || b.getAttribute("aria-label") || "").trim();
  const BUTTON_SELECTOR = 'button, [role="button"], a[href], input[type="button"], input[type="submit"]';

  // The class/id/label attributes of a dialog and its ancestors, across shadow
  // boundaries. Developers name these in English (e.g. "session-timeout-modal"),
  // so they're a language-independent hint that a dialog is a timeout warning.
  function hintsFor(el) {
    const parts = [];
    for (let n = el; n; n = n.parentElement ?? n.getRootNode().host) {
      for (const attr of ["class", "id", "data-testid", "aria-label"]) {
        const v = n.getAttribute?.(attr);
        if (v) parts.push(v);
      }
    }
    return parts.join(" ");
  }

  // Remembers each dialog's last text so a shrinking number reads as a countdown.
  const lastText = new WeakMap();
  // What was last logged per dialog, so the observer's frequent passes don't repeat it.
  const lastLogged = new WeakMap();
  const found = new WeakSet();
  const logOnce = (dlg, line) => { if (lastLogged.get(dlg) !== line) { lastLogged.set(dlg, line); log(line); } };

  // At most one click per CLICK_COOLDOWN_MS: if a click doesn't close the warning
  // (say the site's handler failed), the observer mustn't keep clicking on every change.
  const CLICK_COOLDOWN_MS = 30 * 1000;
  // A short, random reaction delay before clicking, so the click doesn't land the
  // same instant the dialog appears (a human takes a beat). Not evasion: the click is
  // still a plain, honest .click(); this only avoids a zero-millisecond reaction.
  const CLICK_DELAY_MS = [50, 500];
  let lastClick = 0;
  let clickPending = false;

  // What the last dialog check saw, for the nudge log line.
  let lastScan = "not run";

  function dismissSessionDialogs() {
    if (clickPending || Date.now() - lastClick < CLICK_COOLDOWN_MS) {
      lastScan = clickPending ? "click pending" : "cooling down after a click";
      return false;
    }
    const idleMs = Date.now() - lastInput;

    // Your own logout cap: past it, stop extending and let the site log you out.
    const capMs = Number(siteOptions.maxIdleMin) * 60 * 1000;
    if (capMs && idleMs >= capMs) {
      lastScan = "past your inactivity cap";
      if (!pastCapLogged) {
        pastCapLogged = true;
        log(`past your ${siteOptions.maxIdleMin}-min inactivity cap; letting the session log out`);
      }
      return false;
    }

    const candidates = deepQueryAll(DIALOG_SELECTOR);
    const dialogs = candidates.filter(visible);
    lastScan = `${candidates.length} dialog(s), ${dialogs.length} visible`;
    if (episode) episode.checks++;
    for (const dlg of candidates) {
      if (dialogs.includes(dlg) || !debug) continue;
      const r = dlg.getBoundingClientRect();
      logOnce(dlg, `skipped a dialog that isn't visible (${Math.round(r.width)}x${Math.round(r.height)}, tab ${document.visibilityState})`);
    }

    for (const dlg of dialogs) {
      const text = dlg.textContent || "";
      const previous = lastText.get(dlg);
      lastText.set(dlg, text);

      const buttonEls = deepQueryAll(BUTTON_SELECTOR, dlg).filter(visible);
      if (!found.has(dlg)) {
        found.add(dlg);
        if (mentionsSession(text)) signal("dialog", "a dialog with session wording is in the page", { warning: true });
        if (episode) episode.dialogs++;
        const snippet = (dlg.innerText || text).replace(/\s+/g, " ").trim().slice(0, 80);
        log(`dialog found (tab ${document.visibilityState}): "${snippet}" (buttons: ${buttonEls.map((b) => `"${labelOf(b)}"`).join(", ") || "none"})`);
      }
      const { index, reason } = decide({
        idleMs,
        dialogLike: true,
        text,
        hints: hintsFor(dlg),
        countdown: previous !== undefined && countingDown(previous, text),
        buttons: buttonEls.map(labelOf),
      });
      if (index === null) {
        logOnce(dlg, `left the dialog alone: ${reason}`);
        continue;
      }

      // Some component libraries render a <button> inside another <button> with the
      // same label, and a click only bubbles outward, so click the innermost element.
      let btn = buttonEls[index];
      for (let changed = true; changed; ) {
        changed = false;
        for (const b of buttonEls) if (b !== btn && btn.contains(b)) { btn = b; changed = true; }
      }
      const label = labelOf(btn);
      const [lo, hi] = CLICK_DELAY_MS;
      const delay = lo + Math.random() * (hi - lo);
      lastClick = Date.now();   // engage the cooldown now, so pending clicks don't stack
      clickPending = true;
      const planned = Math.round(delay);
      const scheduled = performance.now();
      logOnce(dlg, `button "${label}" chosen (${reason}); clicking in ${planned} ms`);
      setTimeout(() => {
        clickPending = false;
        // Background tabs throttle timers, so the real wait can exceed the planned one.
        const waited = Math.round(performance.now() - scheduled);
        if (!btn.isConnected || !visible(btn)) {
          log(`warning closed before the click (waited ${waited} ms of ${planned} ms)`);
          return;
        }
        log(`clicked "${label}" after ${waited} ms (planned ${planned} ms)`);
        endEpisode(`clicked "${label}"`);
        chrome.runtime.sendMessage({ type: "idly:extended", host: location.hostname, label, waited }).catch(() => {});
        btn.click();
      }, delay);
      return true;
    }
    return false;
  }

  // Synthetic input is opt-in per site: some sites' bot detection (Akamai and the like)
  // reads mouse and key events, can tell synthetic ones apart (isTrusted: false), and
  // blocked a whole home network for it in testing. Never make this the default.
  function simulateActivity() {
    const x = 5 + Math.floor(Math.random() * 20);
    const y = 5 + Math.floor(Math.random() * 20);
    const mouse = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    for (const target of [document, document.body, window].filter(Boolean)) {
      target.dispatchEvent(new MouseEvent("mousemove", mouse));
      target.dispatchEvent(new PointerEvent("pointermove", mouse));
    }
    // Shift on its own won't type anything or fire shortcuts, but it still resets
    // idle timers that listen for keydown.
    const key = { bubbles: true, key: "Shift", code: "ShiftLeft", keyCode: 16 };
    document.dispatchEvent(new KeyboardEvent("keydown", key));
    document.dispatchEvent(new KeyboardEvent("keyup", key));
    window.dispatchEvent(new Event("scroll"));
  }

  // A site's keepalive: a plain GET, sent from the page so it carries the page's own
  // cookies (Idly never reads them). It's due every KEEPALIVE_MIN minutes (see shared.js;
  // content scripts can't import it), each time randomised to 70–130% of that, so the
  // requests never settle into a machine-like rhythm. The first one waits a random
  // share of the interval too, instead of firing the moment the page loads.
  const KEEPALIVE_MS = 5 * 60 * 1000;
  const nextDelay = () => KEEPALIVE_MS * (0.7 + Math.random() * 0.6);
  let keepaliveDue = Date.now() + Math.random() * KEEPALIVE_MS;
  async function keepalive(url) {
    if (!url || Date.now() < keepaliveDue) return;
    keepaliveDue = Date.now() + nextDelay();
    let result;
    try {
      const res = await fetch(new URL(url, location.origin), { method: "GET", credentials: "include", cache: "no-store" });
      result = `HTTP ${res.status}`;
    } catch (e) {
      result = `failed: ${e.message}`;
    }
    log(`keepalive ${url}: ${result}`);
    chrome.runtime.sendMessage({ type: "idly:keepalive", host: location.hostname, url, result }).catch(() => {});
  }

  // options: the site's settings from the popup, { simulate?, keepalive? }.
  function nudge(options = {}) {
    noteTitle();
    dismissSessionDialogs();   // the nudge line below logs what it saw
    if (options.simulate) simulateActivity();
    keepalive(options.keepalive);
    const idleMin = ((Date.now() - lastInput) / 60000).toFixed(1);
    const cap = options.maxIdleMin ? `, cap ${options.maxIdleMin}m` : "";
    const did = [options.simulate && "simulated activity", options.keepalive && "keepalive check"].filter(Boolean);
    log(`nudge (tab ${document.visibilityState}, focus ${document.hasFocus()}, idle ${idleMin}m${cap}; ${lastScan})${did.length ? `: ${did.join(", ")}` : ""}`);
  }

  chrome.storage.sync.get({ debug: false }).then((s) => { debug = s.debug; syncHeartbeat(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.debug) { debug = changes.debug.newValue; syncHeartbeat(); }
  });

  // Debug: every check logs what it saw, so "ran and found nothing" is distinguishable
  // from "didn't run". Page-change checks can fire many times a second, so those are
  // only logged when the result changes.
  let lastPageScan = "";
  function check(trigger) {
    const clicked = dismissSessionDialogs();
    if (!debug) return clicked;
    if (trigger === "page change") {
      if (lastScan === lastPageScan) return clicked;
      lastPageScan = lastScan;
    }
    const at = episode ? ` [${since(episode.start)}]` : "";
    log(`check (${trigger}, tab ${document.visibilityState})${at}: ${lastScan}`);
    return clicked;
  }

  // Debug: a check every HEARTBEAT_MS, logged with the real gap since the last one.
  // A hidden tab throttles timers, and the gap shows by how much.
  const HEARTBEAT_MS = 5 * 1000;
  let heartbeat = null;
  let lastBeat = 0;   // performance.now(), which clock changes don't affect
  function syncHeartbeat() {
    if (debug && observer && !heartbeat) {
      lastBeat = performance.now();
      heartbeat = setInterval(() => {
        const gap = ((performance.now() - lastBeat) / 1000).toFixed(1);
        lastBeat = performance.now();
        watchShadowRoots();
        check(`heartbeat, +${gap} s`);
        if (episode && Date.now() - episode.last > EPISODE_QUIET_MS) endEpisode("warning signs stopped");
      }, HEARTBEAT_MS);
    } else if (!(debug && observer) && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  // Debug: log added elements that mention a session or logout, so a warning that
  // doesn't match the dialog selector still shows up. Once per element.
  const DIALOG_SELECTOR = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal.show, .modal.in';
  const seenText = new WeakSet();
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const cls = [...el.classList].slice(0, 3).map((c) => `.${c}`).join("");
    const role = el.getAttribute("role") ? ` role=${el.getAttribute("role")}` : "";
    return `<${el.localName}${el.id ? `#${el.id}` : ""}${cls}${role}> ${Math.round(r.width)}x${Math.round(r.height)}`;
  };
  const LIVE_SELECTOR = '[aria-live]:not([aria-live="off"]), [role="alert"], [role="status"], [role="timer"]';
  const snippet = (text) => `"${text.replace(/\s+/g, " ").trim().slice(0, 80)}"`;
  function noteSessionText(records) {
    for (const rec of records) {
      // Screen-reader live regions often announce the countdown as changing text.
      if (rec.type === "characterData") {
        const live = rec.target.parentElement?.closest(LIVE_SELECTOR);
        const text = live?.innerText || "";
        if (live && mentionsSession(text)) signal("live-region", `${describe(live)} ${snippet(text)}`, { warning: true });
        continue;
      }
      for (const node of rec.addedNodes) {
        const el = node.nodeType === 1 ? node : node.parentElement;
        if (!el || seenText.has(el) || el.closest("head, script, style, noscript, template")) continue;
        const text = el.innerText || "";
        if (text.length > 3000 || !mentionsSession(text)) continue;
        seenText.add(el);
        const where = el.closest(DIALOG_SELECTOR) ? "inside a dialog" : el.closest(LIVE_SELECTOR) ? "in a live region" : "NOT inside a matched dialog";
        signal("session-text", `${where}: ${describe(el)} ${snippet(text)}`, { warning: true });
      }
    }
  }

  // Dialogs built as web components live in shadow roots, which a document-level
  // MutationObserver doesn't see into, so each open shadow root gets observed as well.
  const watchedRoots = new WeakSet();
  let rootCount = 0;
  function watchShadowRoots() {
    if (!observer) return;
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    const visit = (root) => {
      const w = root === document ? walker : document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let n = w.currentNode; n; n = w.nextNode()) {
        const sr = n.shadowRoot;
        if (!sr) continue;
        if (!watchedRoots.has(sr)) {
          watchedRoots.add(sr);
          observer.observe(sr, OBSERVE);
          rootCount++;
          if (debug) signal("shadow-root", `now also watching <${n.localName}>'s shadow root (${rootCount} in all)`);
        }
        visit(sr);
      }
    };
    visit(document);
  }

  // Sites often change the tab title when their logout warning starts, even in a
  // hidden tab that hasn't drawn the dialog yet, so debug mode logs each change.
  let lastTitle = document.title;
  function noteTitle() {
    if (!debug || document.title === lastTitle) return;
    lastTitle = document.title;
    if (mentionsSession(lastTitle)) {
      const n = numbers(lastTitle);
      const left = n.length ? ` (${n[0]} s left?)` : "";
      signal("title-warning", `"${lastTitle}"${left}`, { warning: true });
    } else {
      signal("title", `"${lastTitle}"`);
    }
  }

  // React as soon as a warning dialog appears rather than waiting for the next tick.
  // MutationObserver callbacks are not throttled the way timers are in background tabs.
  let observer = null;
  let pending = false;
  // characterData is only for debug logging (live-region text); on its own it doesn't
  // trigger a check, so a page with a ticking clock doesn't cause constant checks.
  const OBSERVE = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["open", "class", "aria-hidden", "style"] };
  function start() {
    if (observer) return;
    observer = new MutationObserver((records) => {
      noteTitle();
      if (debug) noteSessionText(records);
      if (pending || records.every((r) => r.type === "characterData")) return;
      pending = true;
      setTimeout(() => { pending = false; if (observer) { watchShadowRoots(); check("page change"); } }, 250);
    });
    observer.observe(document.documentElement, OBSERVE);
    watchShadowRoots();
    syncHeartbeat();
  }

  addEventListener("visibilitychange", () => signal("visibility", `tab is now ${document.visibilityState}`));
  addEventListener("pagehide", () => {
    signal("page-leave", `leaving ${location.pathname}`);
    endEpisode(`page left (${location.pathname})`);
  });

  // Sent when the site is removed from Idly's list. Losing the host permission
  // doesn't unload a running content script, so it has to switch itself off.
  function stop() {
    observer?.disconnect();
    observer = null;
    syncHeartbeat();
  }

  // The reply lets the service worker log what each nudge found.
  const state = () => ({ host: location.hostname, visibility: document.visibilityState, focus: document.hasFocus() });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === "idly:nudge") { siteOptions = msg.options || {}; start(); nudge(msg.options); reply(state()); }
    if (msg?.type === "idly:stop") { stop(); reply(state()); }
  });

  start();
  check("script start");
}
