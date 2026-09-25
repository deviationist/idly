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

On each enabled site, Idly does the following:

- **Simulated activity:** every *N* minutes (1 by default) it sends mouse, pointer and Shift-key events so the page's idle timer keeps resetting. The tick comes from `chrome.alarms`, so it still fires in background tabs where the page's own timers get throttled.
- **Session-warning dismissal:** a `MutationObserver` watches for dialogs, including ones inside shadow DOM. A dialog only counts if its text mentions logout, session or inactivity. Idly then clicks its "Continue / Fortsett / Fortsätt / Jatka…" button. Buttons outside such dialogs are never clicked, so a "Continue" on a payment screen is left alone.
- **No tab discarding:** tabs on enabled domains are marked non-discardable, so Chrome's Memory Saver doesn't put the bank tab to sleep while you work in other tabs.

## Where the list lives

Idly doesn't keep its own list of websites. The list is the set of sites you've granted Idly access to, so the popup and the browser's extension settings (**Site access**) always agree. Removing a site in the popup stops Idly there at once, but the browser keeps a record that you once allowed it. That record is still listed under Site access, and re-adding the site won't prompt again. To clear it completely, use **Manage site access** in the popup's footer, which opens that settings page. Revoking a site there removes it from Idly too. The list stays on this browser and doesn't sync to your other devices. The nudge interval does sync.

## Limits

- Idly can't get past a **server-side absolute session limit**, for example a forced re-login after a fixed number of hours whatever you do.
- Some sites ignore synthetic events. On those, only the dialog auto-click helps.
- After you remove a website, reload any open tabs on it to fully stop Idly there.
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
