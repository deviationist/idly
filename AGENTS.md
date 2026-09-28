# AGENTS.md

Idly is a site-agnostic Chromium extension that keeps chosen sites from logging the user out for inactivity (an admin panel, dashboard, webmail or bank with a short idle timeout). It does so with per-site **strategies**: clicking the site's own warning (always on), a keepalive request, a page timer call, bringing a background tab forward, or simulated activity. See `README.md` for what each does and how to choose; this file is about how they're built.

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
| `background.js` | Service worker and **the only writer of the list**. It commits pending entries once their grant exists (`permissions.onAdded`, or an `idly:commit` message when the browser skipped the prompt), removes entries (`idly:remove`), unlists sites the user revoked in the browser (`permissions.onRemoved`), and revokes grants nothing listed needs (`pruneGrants`). Whenever the list changes, `apply` registers `content.js` for listed sites that have access, injects into open tabs, sends `idly:stop` to every other tab, and sets the badge and `autoDiscardable: false` (Memory Saver would otherwise discard a background tab, which silences Idly and reloads the tab into a login page). The alarm tick nudges each enabled tab (via `nudgeTabs`) with its site's options after a random 1–3 s delay, and a change to a site's options nudges immediately. It brings tabs forward for their warning (`idly:reveal` / `idly:reveal-done`, one at a time through `queueReveal`) and runs page timer calls (`idly:page-call` → `callPageMethod` in the page's world). It also swaps the toolbar icon on `{type: "idly:scheme"}`. List changes run one at a time through `serial` |
| `offscreen.html` / `offscreen.js` | Hidden offscreen document (reason `MATCH_MEDIA`). Service workers have no `matchMedia`, so this page reports light or dark to `background.js` |
| `words.js` | Data only: per-language word lists (session / stay / leave / dismiss) and English class-name hints. Sets `globalThis.IdlyWords` / `IdlyHints`. Edit freely; no logic |
| `detect.js` | Pure decision logic (`globalThis.IdlyDetect.decide`): given plain facts about a dialog, returns which button to click, or null with a reason. Idle-gated and evidence-based (see below). Runs under Node in tests |
| `content.js` | Injected as `words.js`, `detect.js`, `content.js` in that order. Dialogs: a `MutationObserver` (also on open shadow roots) and every nudge gather dialog facts and let `decide` pick the button; the click comes after a 50–500 ms reaction delay, or at once in a hidden tab or while revealed. On a nudge it also sends the site's keepalive GET when due (randomised to 70–130% of 5 minutes), asks for the page timer call (`options.pageCall`), and **only if the site opted in** (`simulate`) dispatches synthetic mouse, pointer, Shift and scroll events. It watches the title and, for sites with `reveal`, asks for the tab to be brought forward on a warning title. A site's `maxIdleMin` is a self-imposed logout cap: past it, clicks and page timer calls stop. With debug on it logs every check, a 5 s heartbeat, and warning signals grouped into episodes. `window.__idly` guards against double injection and lets a fresh copy replace one orphaned by an extension reload; messages go through `send()`, which switches an orphan off |
| `popup.html` / `popup.js` | GUI: the This page card, the list of active websites with each site's Options panel (simulate, keepalive, cap, bring to front, page timer), the add form, the nudge interval, debug logging |
| `icons/light/`, `icons/dark/` | Toolbar icons: deep green (design option b) for light toolbars, pale green (option c) for dark ones. The manifest points at `light/` |
| `design/` | The Claude Design handoff. See "GUI and design" |
| `test/shared.test.mjs` | Unit tests for `shared.js` |
| `test/detect.test.mjs` | Runs `detect.js` against generic warning texts and decoy dialogs: idle-gating, evidence, button choice, and that logout/close/cancel/payment are never clicked |
| `test/background.test.mjs` | Runs `background.js` against a small fake `chrome.*`, covering add, remove, replace and revoke flows, bringing tabs forward (including the queue) and page timer calls |

**State:** Idly keeps **its own list** of websites, and host permissions only say what Idly may touch. The two differ on purpose:
- `chrome.permissions.remove` only drops the *active* permission. The browser keeps the grant on record (listed under Site access) until the user clears it there.
- The browser can grant more than the user listed, for example through its own site-access menu.

| Storage | Keys | Why |
|---|---|---|
| `chrome.storage.local` | `{ sites: string[], pending: string \| null, options: { [entry]: { simulate?, keepalive?, maxIdleMin?, reveal?, pageCall?: { method, selector?, capMethod? } } } }` | Per device, because permissions don't sync. `background.js` is the only writer of `sites` |
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

- **Idle-gating is the core safety guard.** `decide` acts only when the user has had no *trusted* input for `MIN_IDLE_MS` (60 s). A payment or "save changes?" dialog appears right after a click, so it fails this check and is never touched. Idly's own synthetic events are `isTrusted: false` and never reset the idle clock. Never weaken this.
- **Act only on real evidence.** Beyond looking like a dialog, `decide` needs at least one of: a ticking countdown, an English class/id hint, or session wording. Payment/consent dialogs have none.
- **Never click leave/dismiss buttons.** `classify` marks log-out and close/cancel labels and excludes them; a "stay" label is clicked, else the single remaining unknown button, else nothing. `leave` matches anywhere in a label so "Yes, log me out" is a leave, not a stay.
- **Click the innermost match, at most once per 30 seconds, after a 50–500 ms reaction delay.** Some component libraries nest a `<button>` inside another with the same label, and a click only bubbles outward. The cooldown (and a `clickPending` flag while a delayed click is scheduled) stops a warning that doesn't close from being clicked on every page change. The delay is a small human-reaction pause, not evasion; before the delayed click fires it re-checks the button is still connected and visible. The exceptions are a click while the tab is brought forward (below), where the user sees every millisecond, and a click in a hidden tab: there the browser holds timers back until its next wake-up, up to a minute, which can be after the site's own logout. For the same reason, in a hidden tab the observer checks in a microtask rather than after its usual 250 ms.
- **No synthetic input by default.** Some sites' bot detection (Akamai and the like) reads mouse and key events and can tell synthetic ones apart (`isTrusted: false`). In testing, a bank's did this and blocked every Chromium browser on the user's home connection. `simulateActivity` runs only for sites whose options set `simulate`. Never make it the default, and keep the warning next to the option.
- **Keepalive requests are GET only**, restricted by `parseKeepalive` to the page's own origin or an https host the entry covers. They're sent with `fetch` from the content script, so the page's cookies are used without Idly ever reading them. Never replay POST, PUT or DELETE, never read or store cookies or tokens, and keep the interval randomised.
- **Bringing a tab forward is opt-in per site (`reveal`) and minimal.** Some sites only build their warning dialog in a visible tab (a hidden tab runs no animation frames), while their title still changes. On a warning title in a hidden tab, `content.js` asks `background.js` to activate the tab (`idly:reveal`), clicks the dialog with no delay, and reports back (`idly:reveal-done`), and `background.js` switches back to the previous tab, at most 3 s later. Tabs are brought forward one at a time through a queue, each returning to the user's tab before the next; a queued tab that reports done while waiting is skipped. The same guards apply as for any click (idle for `MIN_IDLE_MS`, under the cap), `background.js` re-checks the site has the option, it's at most once a minute, it never restores a window or switches back if the user has moved on to another tab, and it needs no new permission. Don't make it the default.
- **A page timer call runs names, never code.** `options.pageCall` holds a method name, an optional selector and an optional cap method, validated by `parsePageCall` (plain identifiers only). On each nudge `content.js` asks (`idly:page-call`), and `background.js` reads them from storage, never from the message, and runs `callPageMethod` in the page's world (`world: "MAIN"`), in the asking frame only. It calls the method only on custom elements (tag with a hyphen) and never a method `HTMLElement` or `HTMLFormElement` already has, so a name like `reset` or `remove` can't touch ordinary page elements. Past the user's cap it stops, calling the optional `capMethod` once. Keep it opt-in and keep the docs recommending a reset method over one that stops the site's timer: a reset fails safe if Idly stops, a stop fails open.
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

Nothing in `design/` ships or is loaded by the extension. Square popup corners are accepted. The browser draws the popup frame, and a transparent page background doesn't help (tested: the browser paints an opaque background behind it). The rounded card in the mockups is only presentation. The only known workaround is a fake popup injected into the web page with a content script, and it was rejected: it would draw our UI inside third-party pages, can't appear on browser pages, and would need broader permissions.

## Supporting a new site

Choose a strategy before touching code. Most sites need none: the README's **Choosing a strategy** section maps what the debug log shows to the option that fits, and all of them are per-site settings. Only a warning Idly doesn't recognise needs a change here, and that is data:
1. Add the warning's distinctive word(s) to that language's `session` in `words.js`.
2. Add the button label to `stay`; add a matching log-out label to `leave` if one isn't covered.
3. If the dialog isn't matched at all, extend the dialog selector (`DIALOG_SELECTOR` in `content.js`).
4. Add the text and label to `test/detect.test.mjs` as generic wording: never a site's name, verbatim copy or class names.

Prefer widening the language data over per-site code: it helps every site and keeps the repo free of any one site's identifiers. A site's own values (its timer method, keepalive path) belong in the user's settings, never in the repo.

### Capturing a warning

Warnings appear shortly before a logout, often only a minute before it, and real input such as moving the pointer over the page resets the site's timer. So capture without touching the page:
1. Turn on **Debug logging**, detach the site's DevTools into its own window and turn on **Preserve log**.
2. Put the tab in the background and keep the pointer away. The `signal …` lines (`title-warning`, `session-text`, `live-region`, `dialog`) and the episode summary show what the page did, and when, without any manual observer.
3. Only if that isn't enough, log the `outerHTML` of added dialog-like nodes from the Console.

## Verifying changes

- **Tests:** `node --test`, with no dependencies. Add a test for every rule you change in `shared.js`. Flows that involve the list or permissions go in `test/background.test.mjs`, whose fake keeps separate *active* and *granted* sets like Chromium.
- **Syntax:** `node --check content.js`, and for each module `node --check --input-type=module < file.js`.
- **Popup:** from a scratch directory, not this repo, serve a copy of `popup.html` with `window.chrome` stubbed (storage, `tabs.query`, `permissions.request`). Load each mockup state and screenshot it in both light and dark (for example with Playwright's `emulateMedia`), then compare against `Idly Mockups`.
- **Content script:** serve a mock page that stubs `window.chrome.runtime.onMessage` and loads `content.js`. Include a session-warning dialog (one inside a shadow root) and a decoy payment dialog with a "Continue" button. Fire a nudge and assert that only the session dialog's button was clicked.
- **Debug mode:** tick **Debug logging** in the popup footer. The service worker's Console (open it from `brave://extensions` → Idly → **Inspect views** → service worker) then shows a timeline: ticks, each tab nudged with its visibility and focus, warnings clicked, tabs brought forward, page timer results, and sites added, removed or stopped. The page's Console shows each nudge and check, the heartbeat, warning signals and episodes, and page timer calls. Keep new logging behind `log()` in `background.js` or `signal()`/the `debug` flag in `content.js`, so nothing is logged by default. Errors are always logged.
- **Background tabs:** Playwright keeps its pages visible and unthrottled, even without its background-throttling flags, so hidden-tab behaviour (throttled timers, no animation frames, a warning never built) can't be reproduced there. Mock `document.hidden` for unit-level checks, and confirm in a real browser with the tab behind another one: the heartbeat's `+60 s` gaps show real throttling.
- **Full extension:** a manual pass. Reload it in `chrome://extensions`, add an entry, check the **ON** badge, switch the browser between light and dark to watch the toolbar icon, and read the `[Idly]` logs in the page console.
- Don't leave test pages or `.playwright-mcp/` output in the repo.
