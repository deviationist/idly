# Idly

A Chromium extension (Manifest V3, vanilla JS, no build step) that keeps chosen sites from logging you out for inactivity. It works in Chrome, Brave, Edge and other Chromium browsers.

Idly is site-agnostic. Sites log you out in different ways, so instead of one trick it offers a handful of **strategies**, chosen per site: clicking the site's own "stay logged in" warning, a keepalive request, calling the page's own session timer, bringing a background tab forward for its warning, or simulated activity. The default needs no setup and sends no synthetic input.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Pin Idly, open a site you want to stay signed in to, click the icon, then click **Keep me logged in**.

## Adding a website

- **Keep me logged in** on the site you're on adds its exact address, or, with the **Include subdomains** box under it ticked, the whole domain (`www.example.com` becomes `*.example.com`). Idly remembers your choice for next time.
- The **Add a website** form accepts a domain or a pasted URL. With **Include subdomains** ticked (the default), `example.com` is saved as `*.example.com`, which covers example.com and all its subdomains, such as `www.` and `auth.`. Unticked, it covers only the exact address you typed.

Idly refuses addresses without a TLD, IP addresses and duplicates. If a wildcard already covers an address, it tells you. A new wildcard replaces the narrower entries it covers.

## Strategies

Every site in your list gets the first one. The others are per-site settings under **Options** next to the site in the popup, all off by default.

| Strategy | What Idly does | For sites that… | Setting |
|---|---|---|---|
| **Click the warning** | Clicks the site's own "stay logged in" button when its timeout warning appears | Show a warning dialog before logging you out | Always on |
| **Keepalive request** | Sends a GET request the page itself makes, such as `/api/session`, about every 5 minutes | Expire the session on their server, with no timer of their own in the page | Options → Keepalive request |
| **Page timer** | Calls a method of the site's own timer component, such as "user was active", on every nudge | Run the logout timer in the page, as a web component | Options → Page timer |
| **Bring to front** | Shows a background tab for a moment when its title turns into a warning, clicks the warning, switches back | Only build their warning while the tab is visible | Options → Bring to front |
| **Simulate activity** | Sends mouse, key and scroll events on every nudge | Reset their timer on activity, and have no bot detection | Options → Simulate activity |

Two safeguards apply to all of them:
- **Logout cap.** Options → "Log me out after (minutes idle)". Past that much inactivity (measured from your last real input on the site), Idly stops extending and the site logs you out as it normally would. Blank means no cap.
- **No tab discarding.** Tabs on your sites are marked non-discardable, so the browser's memory saver doesn't put them to sleep while you work elsewhere.

### Click the warning (default)

A `MutationObserver` watches for dialogs, including ones inside shadow DOM. Idly clicks a warning's "stay logged in" button only when you've had no real activity on the page for at least a minute, it looks like a dialog, and there's a real sign of a timeout: a ticking countdown, a timeout-related class name, or wording in one of ten languages. It never clicks log-out, close or cancel, and never touches a dialog you'd see while using the page, such as a payment confirmation. In a background tab it clicks at once; in a visible one it waits a short, human-like moment first.

### Keepalive request

A GET request the site's own page already makes to stay signed in, found in DevTools → Network. Idly sends it from the page, with the page's own cookies, at irregular intervals of 3½–6½ minutes. It's always a GET, only to that site, and Idly never reads your cookies.

It keeps the **server** side alive. It isn't enough on its own when the page also keeps its own deadline and logs you out when that passes: the page doesn't learn about requests Idly makes. Combine it with the default warning click, or use a strategy that works through the page.

### Page timer

Some sites log you out from a timer in their own page: a web component (a tag with a hyphen, like `session-timer`) with a method that the page calls on activity. Give that method's name, and Idly calls it on every nudge on every component that has it, including inside shadow roots, so the warning never comes, even in a background tab. It makes no requests and fires no events.

- **Method to call every nudge**: for example a "user was active" or "reset" method.
- **Only on this element** (optional): a CSS selector, if several components have the method.
- **Method to call once past your cap** (optional): for example one that turns a stopped timer back on.

Only names are stored, Idly never runs code from its settings, and methods every element has (a form's `reset`, `click`, `remove`) are never called. Prefer a method that resets the timer over one that stops it: if Idly ever stops working, a reset timer carries on and logs you out, whereas a stopped one would leave the session open until the page reloads.

### Bring to front

A background tab runs no animation frames, and some frameworks only build a dialog on the next frame, so the warning never appears in the page while the site's own timer still logs you out. The tab title usually does change ("Session expires in 57 seconds"). With this on, when a background tab's title turns into a warning, Idly makes it the active tab, clicks the warning straight away and switches back to the tab you were on. It's a brief flicker. Several tabs are handled one at a time. It doesn't work while the window is minimized, and it never switches back if you've moved to another tab meanwhile. Prefer the page timer where the site has one.

### Simulate activity

Sends synthetic mouse, pointer, Shift-key and scroll events on every nudge, so a page that resets its timer on activity keeps doing so. **Avoid it on sites with bot protection.** Bot managers (Akamai Bot Manager and the like) can tell synthetic events apart (`isTrusted: false`) and may block your browser; in testing one did, for every Chromium browser on a home connection. Use it only where the site's code shows no bot detection.

## Choosing a strategy

Start with the site in the list and nothing else. Most sites need no more. If it still logs you out, turn on **Debug logging** in the popup footer, open the site's DevTools Console with **Preserve log** on, and put the tab in the background until the logout. Then:

| What the log shows | Likely cause | Try |
|---|---|---|
| `dialog found …`, then `left the dialog alone: …` | Idly saw the warning but didn't recognise its wording or button | Report the wording so it can be added to the word lists |
| No `dialog found`, but `signal title-warning …` | The warning is only built while the tab is visible | Page timer if the page has a timer component, else Bring to front |
| No `dialog found`, and `signal session-text … NOT inside a matched dialog` | The warning isn't marked up as a dialog | Report it; Idly's dialog selector may need widening |
| No warning signs at all, then a logout | The server ends the session on its own | Keepalive request |
| Logged out even with a keepalive | The page keeps its own deadline | Simulate activity (only without bot detection) or the default warning click |

To find the values:
- **A page timer**: in DevTools → Elements, look for a custom element (a tag with a hyphen) related to idle or timeout, also inside `#shadow-root`s. Select it and run `Object.getOwnPropertyNames(Object.getPrototypeOf($0))` in the Console to list its methods; one that resets the timer is what you want. Test it by calling it in the Console first.
- **A keepalive request**: in DevTools → Network, find the request the page makes when you click "stay logged in", or periodically on its own. Only GET requests work.
- **Bot detection**: before trying Simulate activity, check whether the site runs a bot manager, for example by searching the scripts it loads (DevTools → Sources) for known vendors. If in doubt, don't.

Idly can't get past a **server-side absolute limit**, such as a forced re-login after a fixed number of hours whatever you do.

## Background tabs

Browsers deliberately slow down background tabs, which matters for anything that keeps a session alive:
- **Timers** in a hidden tab run at most once a second, and after a while only about once a minute. A site's own warning and logout checks slow down with them, which is why logouts in background tabs come at irregular times.
- **Animation frames** don't run at all, so a dialog built on the next frame isn't built until you look at the tab.
- **Idly's nudge** comes from `chrome.alarms` in the extension's service worker, which isn't throttled. It fires every *N* minutes (the popup's **Nudge every** setting: 1 by default, 0.5 at the least), reaches each tab after a random 1–3 second delay, and drives every strategy above.
- **A minimized window, a sleeping computer or a frozen tab** runs nothing, Idly included.

## Where the list lives

Idly keeps its own list of websites on this device. It doesn't sync, because the browser's site permissions don't either. The browser's **Site access** settings are only about what Idly is *allowed* to touch:
- **Removing a site in the popup** stops Idly there straight away, including in tabs that are already open. The browser still remembers that you once allowed the site, so it stays under Site access, and re-adding it won't prompt again. To clear that record, use **Manage site access** in the popup footer.
- **Revoking a site under Site access** removes it from Idly's list too, because Idly can't run there any more.
- **Sites you grant from the browser's own menu** aren't added to the list. Only the popup adds sites.

## Debug mode

Tick **Debug logging** in the popup footer. It's off by default, and errors are always logged.

- **The site's Console** (DevTools on the tab) shows lines prefixed `[Idly …]`:
  - `nudge (tab …, focus …, idle …; …)`: each nudge, with whether the tab was visible, your real idle time and what the last dialog check found.
  - `check (…)`: each dialog check and what it saw, including a 5-second heartbeat whose gaps show how much a background tab is throttled.
  - `dialog found`, `button … chosen`, `clicked … after N ms`: a warning being handled.
  - `signal …` and `episode …`: every sign that a logout is coming (title changes, warning text, countdowns, visibility), timed from the first one, with a summary at the end.
  - `page timer: called …() on N of M element(s)`: each page timer call.
- **The service worker's Console** (`chrome://extensions` → Idly → **Inspect views** → **service worker**, with Developer mode on) shows each tick of the alarm, each tab nudged, warnings clicked, tabs brought forward, page timer results, and sites added or removed. It only keeps logs while its DevTools is open.

## Limits

- A server-side absolute session limit can't be extended.
- Nothing runs while the computer sleeps or the window is minimized; a site may log you out meanwhile.
- The popup's outer corners are drawn by the browser, so they may be square (as in Brave) even though the design shows them rounded.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest; host access is requested per website at runtime |
| `background.js` | Service worker: the site list and permissions, the alarm tick, bringing tabs forward, page timer calls, the badge and the theme-matched toolbar icon |
| `content.js` | Runs in each listed site: finds and clicks warnings, watches the title, sends keepalive requests and simulated activity, asks for page timer calls, debug logging |
| `detect.js` | Decides whether a dialog is a session warning and which button to click |
| `words.js` | Per-language word lists for warnings and buttons |
| `offscreen.html` / `offscreen.js` | Tells the service worker whether the browser is in light or dark mode |
| `popup.html` / `popup.js` | The popup GUI |
| `shared.js` | Address parsing, validation, the duplicate/overlap rules and option validation |
| `icons/` | Toolbar icons for light and dark toolbars |
| `design/` | The Claude Design handoff: mockups of every state, spec, icon sources |
| `test/` | Unit tests: run `node --test` |
