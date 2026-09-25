// Idly content script. It runs only on origins you enable in the popup.
if (!window.__idly) {
  window.__idly = true;

  // A dialog is treated as a session warning only if its text matches this.
  const SESSION_TEXT =
    /(log(ged|ging)?\s*(you\s*)?out|sign(ed)?\s*out|session|inactiv|idle|timeout|time\s*out|expir|utlogg|logg(e|a)s?\s*ut|logget\s*ud|sesjon|sessionen|inaktiv|aktivitet|kirjau|istunto|vanhen)/i;

  // Text of the "stay logged in" button, in English and the Nordic languages.
  const CONTINUE_TEXT =
    /^(continue|stay|keep|extend|yes|i'?m (still )?here|still here|fortsett|fortsätt|fortsæt|forbli|forlæng|förläng|forleng|förnya|forny|bli innlogget|forbliv|ja|jatka|pysy|kyllä)/i;

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

  function dismissSessionDialogs() {
    const dialogs = deepQueryAll(
      'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal.show, .modal.in'
    ).filter(visible);

    for (const dlg of dialogs) {
      if (!SESSION_TEXT.test(dlg.textContent || "")) continue;
      const buttons = deepQueryAll('button, [role="button"], a, input[type="button"], input[type="submit"]', dlg)
        .filter(visible);
      const btn = buttons.find((b) => CONTINUE_TEXT.test((b.innerText || b.value || b.getAttribute("aria-label") || "").trim()));
      if (btn) {
        console.info("[Idly] extending session via:", (btn.innerText || btn.value || "").trim());
        btn.click();
        return true;
      }
    }
    return false;
  }

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

  function nudge() {
    dismissSessionDialogs();
    simulateActivity();
    // Visible with the console's "Verbose" level; handy when testing a new site.
    console.debug(`[Idly] nudge at ${new Date().toLocaleTimeString()} (tab ${document.visibilityState}, focus ${document.hasFocus()})`);
  }

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

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "idly:nudge") { start(); nudge(); }
    if (msg?.type === "idly:stop") stop();
  });

  start();
  nudge();
}
