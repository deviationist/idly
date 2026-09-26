# AGENTS.md

Idly is a Chromium extension that keeps chosen sites (online banking, say) from logging the user out for inactivity. See `README.md` for what it does from the user's side.

## Stack and ground rules

- **Manifest V3 only**, vanilla JS, no dependencies, no build step, no bundler. The folder is loaded as-is via `chrome://extensions`, then **Load unpacked**. Keep it that way: no jQuery, no frameworks, no npm.
- `minimum_chrome_version` is 120, which is where the 30-second minimum alarm period comes from. Feel free to use any API available in that version.
- ES modules everywhere except `content.js`. The service worker is `"type": "module"`, and the popup loads `popup.js` as a module. Content scripts can't be modules, so `content.js` is a plain script and can't import `shared.js`.
- Match the existing style: small functions, a short comment only where the *why* isn't obvious, no classes.
- The repo is public. Use `example.com`-style names in code, docs and tests, never real banks or personal details.

## Architecture

| File | Role |
|---|---|
| `manifest.json` | Permissions: `storage`, `alarms`, `scripting`, `activeTab`, `offscreen`. Host access is an **optional** `*://*/*`, granted per entry at runtime |
| `shared.js` | Pure site-entry logic with no browser APIs: `parseInput` (cleaning and validation), `planAdd` (duplicate and overlap rules), `entriesFromOrigins` (granted patterns to entries, for pruning and migration), `covers`, `patternFor`, `stripWww`, `clampInterval`, `DEFAULTS` / `LOCAL_DEFAULTS`, and the user-facing `MESSAGES` |
| `background.js` | Service worker and **the only writer of the list**. It commits pending entries once their grant exists (`permissions.onAdded`, or an `idly:commit` message when the browser skipped the prompt), removes entries (`idly:remove`), unlists sites the user revoked in the browser (`permissions.onRemoved`), and revokes grants nothing listed needs (`pruneGrants`). Whenever the list changes, `apply` registers `content.js` for listed sites that have access, injects into open tabs, sends `idly:stop` to every other tab, and sets the badge and `autoDiscardable: false` (Memory Saver would otherwise discard a background bank tab, which silences Idly and reloads the tab into a login page). The alarm tick nudges each enabled tab after a random 1–3 s delay. It also swaps the toolbar icon on `{type: "idly:scheme"}`. Changes run one at a time through `serial` |
| `offscreen.html` / `offscreen.js` | Hidden offscreen document (reason `MATCH_MEDIA`). Service workers have no `matchMedia`, so this page reports light or dark to `background.js` |
| `content.js` | On a nudge: dismisses session-warning dialogs; sends the site's keepalive GET when due (randomised to 70–130% of 5 minutes); and **only if the site opted in** (`simulate`), dispatches synthetic mouse, pointer, Shift and scroll events. A `MutationObserver` also dismisses dialogs as soon as they appear. Guarded by `window.__idly` because it can be injected twice |
| `popup.html` / `popup.js` | GUI: the This page card, the list of active websites, the add form, the nudge interval |
| `icons/light/`, `icons/dark/` | Toolbar icons: deep green (design option b) for light toolbars, pale green (option c) for dark ones. The manifest points at `light/` |
| `design/` | The Claude Design handoff. See "GUI and design" |
| `test/shared.test.mjs` | Unit tests for `shared.js` |
| `test/patterns.test.mjs` | Checks `SESSION_TEXT` and `CONTINUE_TEXT`, read straight from `content.js`: real-world warnings must match, and logout, close and cancel labels must not |
| `test/background.test.mjs` | Runs `background.js` against a small fake `chrome.*`, covering add, remove, replace and revoke flows |

**State:** Idly keeps **its own list** of websites, and host permissions only say what Idly may touch. The two differ on purpose:
- `chrome.permissions.remove` only drops the *active* permission. The browser keeps the grant on record (listed under Site access) until the user clears it there.
- The browser can grant more than the user listed, for example through its own site-access menu.

| Storage | Keys | Why |
|---|---|---|
| `chrome.storage.local` | `{ sites: string[], pending: string \| null, options: { [entry]: { simulate?, keepalive? } } }` | Per device, because permissions don't sync. `background.js` is the only writer of `sites` |
| `chrome.storage.sync` | `{ intervalMin, pageSubdomains, debug }` | Settings |

A site is active when it's listed **and** Idly has access to it. The popup and background talk through messages (`idly:commit`, `idly:remove`) and storage change events.

**Site entries** come in two forms:
- `example.com` is an **exact host**. It maps to `*://example.com/*`, and `www.example.com` is not included.
- `*.example.com` is a **wildcard**. It maps to `*://*.example.com/*`, which in Chrome also matches `example.com` itself.

`covers()` has to agree with Chrome's match-pattern semantics, because the popup uses it for the "via" status and the overlap rules, while Chrome uses the pattern to inject the script.

**Adding** (see `planAdd`):
- **Keep me logged in** adds the current tab's exact host. With the card's **Include subdomains** box ticked (`#page-subdomains`, remembered as `pageSubdomains`), it adds `*.<host without www.>` instead. The hint under the box shows the exact entry.
- The form adds an exact host or, when **Include subdomains** (`#subdomains`, ticked by default) is on, a wildcard. Wildcards drop a leading `www.`.
- The duplicate and overlap rules, in order:
  1. An entry that's already listed → "Already in the list."
  2. An entry inside an existing wildcard → "Already covered by *.p."
  3. A new wildcard **replaces** the exact hosts and narrower wildcards it covers, with a notice.

**Input handling** (see `popup.js`):
- A typed or pasted `*.` is taken out of the text and ticks the checkbox. The design draws the `*.` itself with CSS.
- Pasted URLs are cleaned to a hostname straight away.
- `parseInput` rejects the following, and every rejection has a message in `MESSAGES`:
  - empty input
  - names without a TLD (including `localhost`)
  - IP addresses
  - bad characters or bad label rules
  - all-digit TLDs

## Invariants: don't break these

- **Only click inside session dialogs.** `dismissSessionDialogs` clicks a button only when it sits inside a dialog-like element *whose text matches `SESSION_TEXT`* and the button's label matches `CONTINUE_TEXT`. This is what stops Idly from clicking "Continue" on a payment confirmation on a banking site. Never widen it to buttons outside dialogs, and never drop the `SESSION_TEXT` check.
- **Click the innermost match, at most once per 30 seconds.** Some component libraries nest a `<button>` inside another with the same label, and a click only bubbles outward. The cooldown stops a warning that doesn't close from being clicked on every page change.
- **Never click logout.** `CONTINUE_TEXT` is anchored (`^`) to the start of the label. Check that new words can't match logout or cancel labels.
- **No synthetic input by default.** Bank bot detection (Akamai) reads mouse and key events and can tell synthetic ones apart (`isTrusted: false`). In testing, it blocked every Chromium browser on the user's home connection for this. `simulateActivity` runs only for sites whose options set `simulate`. Never make it the default, and keep the warning next to the option.
- **Keepalive requests are GET only**, restricted by `parseKeepalive` to the page's own origin or an https host the entry covers. They're sent with `fetch` from the content script, so the page's cookies are used without Idly ever reading them. Never replay POST, PUT or DELETE, never read or store cookies or tokens, and keep the interval randomised.
- **Synthetic keys must be inert.** Only a lone Shift is dispatched. Don't add keys that could type text, submit forms or trigger shortcuts.
- **`chrome.permissions.request` must run synchronously inside the click or submit handler.** Any `await` before it loses the user gesture and Chrome rejects the request. That's why parsing and `planAdd` are synchronous. See `addEntry` in `popup.js`.
- **Never rely on code after `chrome.permissions.request` in the popup.** The popup usually closes while the browser shows its prompt, which kills its script. That caused the "granted but not listed" bug in 0.1. The popup writes `pending` *before* the request, and `background.js` commits it. Anything else that must happen after a grant belongs in `background.js`.
- **Removing only drops the *active* permission.** The browser keeps the grant listed under Site access, and a re-request skips the prompt ([Chromium docs](https://chromium.googlesource.com/chromium/src/+/main/extensions/docs/permissions.md)). No API lets an extension revoke a grant completely, which is why the list is Idly's own and the footer has **Manage site access**.
- **Never lose access to a listed site.** `pruneGrants` keeps any grant that overlaps a listed or pending entry, because Chrome doesn't document how revoking overlapping patterns behaves. A wildcard replacing narrower entries only unlists them.
- **Stopping must reach open tabs.** Losing a permission doesn't unload a running content script, so `apply` sends `idly:stop` to every tab that isn't enabled.
- **Popup element IDs and classes are a contract** with the design:
  - IDs: `current-host`, `current-status`, `current-btn`, `sites`, `add`, `domain`, `subdomains`, `error`, `notice`, `interval`.
  - Added after the handoff, and not in `design/`: the per-site Options panel (`li.options`, `.opt-form`, `.tags`),  `page-scope`, `page-subdomains`, `page-hint` (the scope option under **Keep me logged in**) `manage` (the footer link to the browser's site-access settings) and `debug` (the debug-logging toggle).
  - Classes set by the script: `on`, `primary`, `muted`.
  - Classes used only by CSS: `wild`, `scope-all`, `scope-exact`.
- **Light and dark mode are both required.** Colours are custom properties on `:root`, overridden under `prefers-color-scheme: dark`, and `color-scheme: light dark` keeps native controls themed. All text needs WCAG AA contrast (4.5:1) in both themes. The only change from the design's tokens is `--placeholder`, adjusted for exactly this reason. The header logo and the toolbar icon also switch with the theme.
- Keep requested permissions minimal. Don't add `tabs`, because `activeTab` plus the per-entry host permissions already cover it.

## GUI and design

`design/` holds the Claude Design handoff and is the reference for all GUI work:
- `design/reference/Idly Mockups.dc.html` has every popup state in light and dark. Open it in a browser (it loads `support.js` and React from unpkg). Those states are the acceptance checklist for the popup.
- `design/README.md` is the handoff spec (layout, tokens, copy, behaviour).
- `design/popup.html` is the popup exactly as delivered. The shipped `popup.html` differs in the placeholder contrast, the theme-switching header logo, the scope option under **Keep me logged in** and the **Manage site access** footer link.
- `design/icons/` holds the icon sources (SVG and PNG, options a/b/c and mono).

Nothing in `design/` ships or is loaded by the extension. Square popup corners are accepted. The browser draws the popup frame, and a transparent page background doesn't help (tested: the browser paints an opaque background behind it). The rounded card in the mockups is only presentation. The only known workaround is a fake popup injected into the web page with a content script, and it was rejected: it would draw our UI inside bank pages, can't appear on browser pages, and would need broader permissions.

## Adding support for a site

When a site's warning dialog isn't dismissed, get its exact text and button label (see "Capturing a warning" below), then:
1. Add a distinctive word from the dialog text to `SESSION_TEXT`.
2. Add the button label to `CONTINUE_TEXT`.
3. If the dialog isn't `dialog[open]`, `[role=dialog|alertdialog]`, `[aria-modal=true]` or `.modal.show/.in`, extend the selector in `dismissSessionDialogs`.

4. Add the text and label to `test/patterns.test.mjs`, anonymised: generic wording only, never the site's name or class names.

### Capturing a warning

Warnings appear shortly before a logout, often only a minute before it, and real input such as moving the pointer over the page resets the site's timer. So capture without touching the page:
1. Detach the browser's DevTools into its own window and turn on **Preserve log** in its Console.
2. Right after loading the page, run a `MutationObserver` in the Console that logs the `outerHTML` of added nodes that are dialog-like or mention logging out.
3. Keep the pointer away from the window. A changed tab title is often the first sign that the warning is up.

## Verifying changes

- **Tests:** `node --test`, with no dependencies. Add a test for every rule you change in `shared.js`. Flows that involve the list or permissions go in `test/background.test.mjs`, whose fake keeps separate *active* and *granted* sets like Chromium.
- **Syntax:** `node --check content.js`, and for each module `node --check --input-type=module < file.js`.
- **Popup:** from a scratch directory, not this repo, serve a copy of `popup.html` with `window.chrome` stubbed (storage, `tabs.query`, `permissions.request`). Load each mockup state and screenshot it in both light and dark (for example with Playwright's `emulateMedia`), then compare against `Idly Mockups`.
- **Content script:** serve a mock page that stubs `window.chrome.runtime.onMessage` and loads `content.js`. Include a session-warning dialog (one inside a shadow root) and a decoy payment dialog with a "Continue" button. Fire a nudge and assert that only the session dialog's button was clicked.
- **Debug mode:** tick **Debug logging** in the popup footer. The service worker's Console (open it from `brave://extensions` → Idly → **Inspect views** → service worker) then shows a timeline: ticks, each tab nudged with its visibility and focus, warnings clicked, and sites added, removed or stopped. The page's Console shows a line per nudge. Keep new logging behind `log()` in `background.js` or the `debug` flag in `content.js`, so nothing is logged by default. Errors are always logged.
- **Full extension:** a manual pass. Reload it in `chrome://extensions`, add an entry, check the **ON** badge, switch the browser between light and dark to watch the toolbar icon, and read the `[Idly]` logs in the page console.
- Don't leave test pages or `.playwright-mcp/` output in the repo.
