// Idly content script. It runs only on origins you enable in the popup.
if (!window.__idly) {
  window.__idly = true;

  // A dialog is treated as a session warning only if its text matches this.
  const SESSION_TEXT =
    /(log(ged|ging)?\s*(you\s*)?out|sign(ed)?\s*out|session|inactiv|idle|timeout|time\s*out|expir|utlogg|logg(e|a)s?\s*ut|logget\s*u[td]|logg(er|ar)\s+(deg|dig|dej)\s+u[td]|sesjon|sessionen|inaktiv|aktivitet|kirjau|istunto|vanhen)/i;

  // Text of the "stay logged in" button, in English and the Nordic languages.
  const CONTINUE_TEXT =
    /^(continue|stay|keep|extend|yes|i'?m (still )?here|still here|fortsett|fortsätt|fortsæt|forbli|forlæng|förläng|forleng|förnya|forny|bli innlogget|forbliv|hold me(g|i) (inn)?logget|hold mig logget|håll mig inloggad|behåll|ja|jatka|pysy|kyllä)/i;

  // Collects every match of a selector, also looking inside shadow roots,
  // because banking UIs are often built from web components.
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

  // At most one click per CLICK_COOLDOWN_MS: if a click doesn't close the warning
  // (say the site's handler failed), the observer mustn't keep clicking on every change.
  const CLICK_COOLDOWN_MS = 30 * 1000;
  let lastClick = 0;

  function dismissSessionDialogs() {
    if (Date.now() - lastClick < CLICK_COOLDOWN_MS) return false;
    const dialogs = deepQueryAll(
      'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal.show, .modal.in'
    ).filter(visible);

    for (const dlg of dialogs) {
      if (!SESSION_TEXT.test(dlg.textContent || "")) continue;
      const labelOf = (b) => (b.innerText || b.value || b.getAttribute("aria-label") || "").trim();
      const matches = deepQueryAll('button, [role="button"], a, input[type="button"], input[type="submit"]', dlg)
        .filter((b) => visible(b) && CONTINUE_TEXT.test(labelOf(b)));
      // Click the innermost match. Some component libraries render a <button> inside
      // another <button> with the same label, and a click only bubbles outward, so
      // only the innermost one is sure to reach the site's handler.
      const btn = matches.find((b) => !matches.some((o) => o !== b && b.contains(o)));
      if (btn) {
        const label = (btn.innerText || btn.value || "").trim();
        if (debug) console.info("[Idly] extending session via:", label);
        chrome.runtime.sendMessage({ type: "idly:extended", host: location.hostname, label }).catch(() => {});
        lastClick = Date.now();
        btn.click();
        return true;
      }
    }
    return false;
  }

  // Synthetic input is opt-in per site: bank bot detection (Akamai and the like)
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
    if (debug) console.info(`[Idly] keepalive ${url}: ${result}`);
    chrome.runtime.sendMessage({ type: "idly:keepalive", host: location.hostname, url, result }).catch(() => {});
  }

  // options: the site's settings from the popup, { simulate?, keepalive? }.
  function nudge(options = {}) {
    dismissSessionDialogs();
    if (options.simulate) simulateActivity();
    keepalive(options.keepalive);
    if (debug) {
      const did = [options.simulate && "simulated activity", options.keepalive && "keepalive due check"].filter(Boolean);
      console.info(`[Idly] nudge at ${new Date().toLocaleTimeString()} (tab ${document.visibilityState}, focus ${document.hasFocus()})${did.length ? `: ${did.join(", ")}` : ""}`);
    }
  }

  // Debug mode is toggled in the popup footer and applies without a reload.
  let debug = false;
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
    if (msg?.type === "idly:nudge") { start(); nudge(msg.options); reply(state()); }
    if (msg?.type === "idly:stop") { stop(); reply(state()); }
  });

  start();
  dismissSessionDialogs();
}
