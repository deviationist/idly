# Idly

A Chromium extension (Manifest V3, vanilla JS, no build step) that stops chosen sites from logging you out for inactivity. It works in Chrome, Brave, Edge and other Chromium browsers.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Pin Idly, open your bank, click the icon, then click **Keep me logged in**.

## How it works

There are two ways to add a website:
- **Keep me logged in** on the site you're on adds its exact address, or, with the **Include subdomains** box under it ticked, the whole domain (`www.bank.com` becomes `*.bank.com`). Idly remembers your choice for next time.
- The **Add a website** form accepts a domain or a pasted URL. With **Include subdomains** ticked (the default), `bank.com` is saved as `*.bank.com`, which covers bank.com and all its subdomains, such as `www.` and `auth.`. Unticked, it covers only the exact address you typed.

Idly refuses addresses without a TLD, IP addresses and duplicates. If a wildcard already covers an address, it tells you. A new wildcard replaces the narrower entries it covers.

On each site in your list, Idly does the following:

- **Clicks session warnings.** A `MutationObserver` watches for dialogs, including ones inside shadow DOM. A dialog only counts if its text mentions logout, session or inactivity (in English or the Nordic languages). Idly then clicks its "Continue / Fortsett / Fortsätt / Jatka…" button. Buttons outside such dialogs are never clicked, so a "Continue" on a payment screen is left alone.
- **Keepalive request (optional, per site).** Under **Options** next to a site, you can give a GET request the site's own page already makes, such as `/api/session`. Idly sends it from the page about every 5 minutes, at irregular intervals (3½–6½ minutes), so the session on the bank's server stays alive. It's always a GET, only to that site, and Idly never reads your cookies.
- **Simulated activity (optional, per site, risky).** Also under **Options**, and off by default. Idly sends mouse and key events so the page's idle timer keeps resetting. **Don't use it on banks.** Their bot detection can tell the events are synthetic and may block your browser. In testing, that blocked every Chromium browser on a home connection for a while.
- **No tab discarding.** Tabs on your sites are marked non-discardable, so the browser's memory saver doesn't put the bank tab to sleep while you work in other tabs.

A tick every *N* minutes (1 by default, from `chrome.alarms`, which keeps firing in background tabs) drives all of this, and each tab's tick comes after a random 1–3 second delay.

## Where the list lives

Idly keeps its own list of websites on this device. It doesn't sync, because the browser's site permissions don't either. The browser's **Site access** settings are only about what Idly is *allowed* to touch:
- **Removing a site in the popup** stops Idly there straight away, including in tabs that are already open. The browser still remembers that you once allowed the site, so it stays under Site access, and re-adding it won't prompt again. To clear that record, use **Manage site access** in the popup footer.
- **Revoking a site under Site access** removes it from Idly's list too, because Idly can't run there any more.
- **Sites you grant from the browser's own menu** aren't added to the list. Only the popup adds sites.

## Debug mode

Tick **Debug logging** in the popup footer to watch Idly work. It's off by default.
- **Service worker Console:** go to `brave://extensions` (or `chrome://extensions`), turn on Developer mode, and under Idly's **Inspect views** click **service worker**. You'll see a timeline: each tick, each tab nudged (with whether it was visible and focused), session warnings clicked, and sites added or removed. A service worker only keeps logs while its DevTools is open.
- **The site's own Console:** DevTools on the tab shows `[Idly] nudge at …` for each nudge.

## Limits

- Idly can't get past a **server-side absolute session limit**, for example a forced re-login after a fixed number of hours whatever you do.
- Some sites ignore synthetic events. On those, only the dialog auto-click helps.
- The popup's outer corners are drawn by the browser, so they may be square (as in Brave) even though the design shows them rounded.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest; host access is requested per website at runtime |
| `background.js` | Registers the content script, runs the alarm tick, sets the badge and the theme-matched toolbar icon, revokes unused permissions |
| `offscreen.html` / `offscreen.js` | Tells the service worker whether the browser is in light or dark mode |
| `content.js` | Simulates activity and dismisses session warnings |
| `popup.html` / `popup.js` | The popup GUI |
| `shared.js` | Address parsing, validation and the duplicate/overlap rules |
| `icons/` | Toolbar icons for light and dark toolbars |
| `design/` | The Claude Design handoff: mockups of every state, spec, icon sources |
| `test/` | Unit tests: run `node --test` |
