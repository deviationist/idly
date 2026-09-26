// Idly content script. It runs only on origins you enable in the popup.
if (!window.__idly) {
  window.__idly = true;

  // The decision logic and word lists live in detect.js / words.js, injected before
  // this script (see background.js). IdlyDetect.decide takes plain facts and says
  // which button to click, so it can be unit-tested without a browser.
  const { decide, countingDown } = globalThis.IdlyDetect;

  // Debug logging (toggled in the popup footer, applies without a reload). Every
  // line is timestamped and prefixed so the page console is easy to filter.
  let debug = false;
  const log = (...args) => { if (debug) console.info(`[Idly ${new Date().toLocaleTimeString()}]`, ...args); };

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

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
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

  // At most one click per CLICK_COOLDOWN_MS: if a click doesn't close the warning
  // (say the site's handler failed), the observer mustn't keep clicking on every change.
  const CLICK_COOLDOWN_MS = 30 * 1000;
  // A short, random reaction delay before clicking, so the click doesn't land the
  // same instant the dialog appears (a human takes a beat). Not evasion: the click is
  // still a plain, honest .click(); this only avoids a zero-millisecond reaction.
  const CLICK_DELAY_MS = [50, 500];
  let lastClick = 0;
  let clickPending = false;

  function dismissSessionDialogs() {
    if (clickPending || Date.now() - lastClick < CLICK_COOLDOWN_MS) return false;
    const idleMs = Date.now() - lastInput;

    // Your own logout cap: past it, stop extending and let the site log you out.
    const capMs = Number(siteOptions.maxIdleMin) * 60 * 1000;
    if (capMs && idleMs >= capMs) {
      if (!pastCapLogged) {
        pastCapLogged = true;
        log(`past your ${siteOptions.maxIdleMin}-min inactivity cap; letting the session log out`);
      }
      return false;
    }

    const dialogs = deepQueryAll(
      'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal.show, .modal.in'
    ).filter(visible);

    for (const dlg of dialogs) {
      const text = dlg.textContent || "";
      const previous = lastText.get(dlg);
      lastText.set(dlg, text);

      const buttonEls = deepQueryAll(BUTTON_SELECTOR, dlg).filter(visible);
      const { index, reason } = decide({
        idleMs,
        dialogLike: true,
        text,
        hints: hintsFor(dlg),
        countdown: previous !== undefined && countingDown(previous, text),
        buttons: buttonEls.map(labelOf),
      });
      if (index === null) {
        if (reason !== "user was active in the last minute") log("left a dialog alone:", reason);
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
      setTimeout(() => {
        clickPending = false;
        if (!btn.isConnected || !visible(btn)) {
          log("warning closed before the click");
          return;
        }
        log(`extending session via "${label}" (${reason}) after ${Math.round(delay)}ms`);
        chrome.runtime.sendMessage({ type: "idly:extended", host: location.hostname, label }).catch(() => {});
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
    dismissSessionDialogs();
    if (options.simulate) simulateActivity();
    keepalive(options.keepalive);
    const idleMin = ((Date.now() - lastInput) / 60000).toFixed(1);
    const cap = options.maxIdleMin ? `, cap ${options.maxIdleMin}m` : "";
    const did = [options.simulate && "simulated activity", options.keepalive && "keepalive check"].filter(Boolean);
    log(`nudge (tab ${document.visibilityState}, focus ${document.hasFocus()}, idle ${idleMin}m${cap})${did.length ? `: ${did.join(", ")}` : ""}`);
  }

  chrome.storage.sync.get({ debug: false }).then((s) => { debug = s.debug; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.debug) debug = changes.debug.newValue;
  });

  // React as soon as a warning dialog appears rather than waiting for the next tick.
  // MutationObserver callbacks are not throttled the way timers are in background tabs.
  let observer = null;
  let pending = false;
  function start() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; if (observer) dismissSessionDialogs(); }, 250);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "class", "aria-hidden", "style"] });
  }

  // Sent when the site is removed from Idly's list. Losing the host permission
  // doesn't unload a running content script, so it has to switch itself off.
  function stop() {
    observer?.disconnect();
    observer = null;
  }

  // The reply lets the service worker log what each nudge found.
  const state = () => ({ host: location.hostname, visibility: document.visibilityState, focus: document.hasFocus() });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === "idly:nudge") { siteOptions = msg.options || {}; start(); nudge(msg.options); reply(state()); }
    if (msg?.type === "idly:stop") { stop(); reply(state()); }
  });

  start();
  dismissSessionDialogs();
}
