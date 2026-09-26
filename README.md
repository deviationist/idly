# Idly

A Chromium extension (Manifest V3, vanilla JS, no build step) that stops chosen sites from logging you out for inactivity. It works in Chrome, Brave, Edge and other Chromium browsers.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Pin Idly, open a site you want to stay signed in to, click the icon, then click **Keep me logged in**.

## How it works

There are two ways to add a website:
- **Keep me logged in** on the site you're on adds its exact address, or, with the **Include subdomains** box under it ticked, the whole domain (`www.example.com` becomes `*.example.com`). Idly remembers your choice for next time.
- The **Add a website** form accepts a domain or a pasted URL. With **Include subdomains** ticked (the default), `example.com` is saved as `*.example.com`, which covers example.com and all its subdomains, such as `www.` and `auth.`. Unticked, it covers only the exact address you typed.

Idly refuses addresses without a TLD, IP addresses and duplicates. If a wildcard already covers an address, it tells you. A new wildcard replaces the narrower entries it covers.

On each site in your list, Idly does the following:

- **Clicks session warnings.** A `MutationObserver` watches for dialogs, including ones inside shadow DOM. Idly clicks a warning's "stay logged in" button only when: you've had no real activity for at least a minute, it looks like a dialog, and there's a real sign of a timeout (a ticking countdown, a timeout-related class name, or wording in one of ten languages). It never clicks log-out, close or cancel, and never touches a dialog you'd see while using the page, such as a payment confirmation.
- **Keepalive request (optional, per site).** Under **Options** next to a site, you can give a GET request the site's own page already makes, such as `/api/session`. Idly sends it from the page about every 5 minutes, at irregular intervals (3½–6½ minutes), so the session on the site's server stays alive. It's always a GET, only to that site, and Idly never reads your cookies.
- **Simulated activity (optional, per site, risky).** Also under **Options**, and off by default. Idly sends mouse and key events so the page's idle timer keeps resetting. **Avoid it on sites with bot protection** (banks especially). Their bot detection can tell the events are synthetic and may block your browser. In testing, that blocked every Chromium browser on a home connection for a while.
- **Logout cap (optional, per site).** Under **Options**, "Log me out after (minutes idle)". Since Idly defeats the site's own auto-logout, this keeps a cap of your own: once you've been idle that long, Idly stops extending and the site logs you out on its next timeout. Measured from your last real interaction, so using the site resets it. Blank means no cap.
- **No tab discarding.** Tabs on your sites are marked non-discardable, so the browser's memory saver doesn't put the tab to sleep while you work in other tabs.

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

## What it's for

Idly is site-agnostic: it works on anything with an **aggressive idle-logout** — an admin panel, a cloud dashboard, webmail, an intranet, a router's web UI, or online banking. Most sites keep you logged in on their own or have generous timeouts and need nothing, so Idly is for the ones that sign you out after just a few idle minutes.

Where a site enforces the timeout on its **server** (EU/EEA banking must, under PSD2, after about 5 minutes), Idly can't quietly suppress it; instead it clicks the site's own "stay logged in" warning when it appears, which is what tells the server you're still there. (Banks were the strict case used in testing; several other sites stayed logged in without any help.)

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
