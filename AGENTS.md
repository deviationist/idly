# AGENTS.md

Idly is a Chromium extension that keeps chosen sites (online banking, say) from logging the user out for inactivity. See `README.md` for what it does from the user's side.

## Stack and ground rules

- **Manifest V3 only**, vanilla JS, no dependencies, no build step, no bundler. The folder is loaded as-is via `chrome://extensions`, then **Load unpacked**. Keep it that way: no jQuery, no frameworks, no npm.
- `minimum_chrome_version` is 120, which is where the 30-second minimum alarm period comes from. Feel free to use any API available in that version.
- ES modules everywhere except `content.js`. The service worker is `"type": "module"`, and the popup loads `popup.js` as a module. Content scripts can't be modules, so `content.js` is a plain script and can't import `shared.js`.
- Match the existing style: small functions, a short comment only where the *why* isn't obvious, no classes.

## Architecture

| File | Role |
|---|---|
| `manifest.json` | Permissions: `storage`, `alarms`, `scripting`, `activeTab`. Host access is an **optional** `*://*/*`, granted per domain at runtime |
| `shared.js` | `DEFAULTS`, `patternFor(entry)`, `covers(entry, host)`, `normalizeDomain(input)`. The single source of truth for site-entry matching |
| `background.js` | Service worker. Re-syncs everything whenever `chrome.storage.sync` changes: registers `content.js` dynamically, recreates the alarm, injects into tabs that are already open, then `refreshTabs` updates the badge and sets `autoDiscardable: false` on enabled tabs (Memory Saver would otherwise discard a background bank tab, which silences Idly and reloads the tab into a login page). Each alarm tick sends `{type: "idly:nudge"}` to matching tabs |
| `content.js` | On a nudge: dismisses session-warning dialogs, then dispatches synthetic mouse, pointer, Shift and scroll events. A `MutationObserver` also dismisses dialogs as soon as they appear. Guarded by `window.__idly` because it can be injected twice |
| `popup.html` / `popup.js` | GUI: the current page toggle, the domain list with add/remove, the nudge interval |

**State** lives in `chrome.storage.sync` as `{ sites: string[], intervalMin: number }`. `sites` holds site entries such as `example.com` or `*.example.com` (see below). The popup writes storage and the background reacts, so the popup never talks to the background directly.

**Site entries** come in two forms:
- `example.com` is an **exact host**. It maps to `*://example.com/*`, and `www.example.com` is not included.
- `*.example.com` is a **wildcard**. It maps to `*://*.example.com/*`, which in Chrome also matches `example.com` itself.

`normalizeDomain` strips the scheme, path and port and keeps a leading `*.`. It deliberately keeps `www.`, because with exact matching `www.example.com` is a different entry. **Keep me logged in** adds the current tab's exact hostname. `covers()` has to agree with Chrome's match-pattern semantics, because the popup uses it to show the "via" status while Chrome uses the pattern to inject the script.

## Invariants: don't break these

- **Only click inside session dialogs.** `dismissSessionDialogs` clicks a button only when it sits inside a dialog-like element *whose text matches `SESSION_TEXT`* and the button's label matches `CONTINUE_TEXT`. This is what stops Idly from clicking "Continue" on a payment confirmation on a banking site. Never widen it to buttons outside dialogs, and never drop the `SESSION_TEXT` check.
- **Never click logout.** `CONTINUE_TEXT` is anchored (`^`) to the start of the label. Check that new words can't match logout or cancel labels.
- **Synthetic keys must be inert.** Only a lone Shift is dispatched. Don't add keys that could type text, submit forms or trigger shortcuts.
- **`chrome.permissions.request` must run synchronously inside the click or submit handler.** Any `await` before it loses the user gesture and Chrome rejects the request. See `addSite` in `popup.js`.
- **Popup element IDs are a contract** with `DESIGN_PROMPT.md` (the GUI is redesigned in Claude Design and dropped back in). The IDs are `current-host`, `current-status`, `current-btn`, `sites`, `add`, `domain`, `error`, `interval`. The classes are `on`, `primary`, `muted`. If you change one, update `DESIGN_PROMPT.md` too.
- Keep requested permissions minimal. Don't add `tabs`, because `activeTab` plus the per-domain host permissions already cover it.

## Adding support for a site

When a site's warning dialog isn't dismissed, get its exact text and button label, then:
1. Add a distinctive word from the dialog text to `SESSION_TEXT`.
2. Add the button label to `CONTINUE_TEXT`.
3. If the dialog isn't `dialog[open]`, `[role=dialog|alertdialog]`, `[aria-modal=true]` or `.modal.show/.in`, extend the selector in `dismissSessionDialogs`.

## Verifying changes

There is no test suite. To verify:
- Syntax: `node --check content.js`, and for each module `node --check --input-type=module < file.js`.
- Content-script logic: serve a mock page (from a scratch directory, not this repo) that stubs `window.chrome.runtime.onMessage` and loads `content.js`. Add a session-warning dialog, including one inside a shadow root, plus a decoy payment dialog with a "Continue" button. Fire a nudge and assert that only the session dialog's continue button was clicked.
- The full extension needs a manual pass: reload it in `chrome://extensions`, add a domain, check the **ON** badge, and read the `[Idly]` logs in the page console.
- Don't leave test pages or `.playwright-mcp/` output in the repo.
