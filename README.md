# Idly

A Chromium extension (Manifest V3, vanilla JS, no build step) that stops chosen sites from logging you out for inactivity.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Pin Idly, open your bank, click the icon, then click **Keep me logged in**.

## How it works

On each enabled domain (subdomains included), Idly does the following:

- **Simulated activity:** every *N* minutes (1 by default) it sends mouse, pointer and Shift-key events so the page's idle timer keeps resetting. The tick comes from `chrome.alarms`, so it still fires in background tabs where the page's own timers get throttled.
- **Session-warning dismissal:** a `MutationObserver` watches for dialogs, including ones inside shadow DOM. A dialog only counts if its text mentions logout, session or inactivity. Idly then clicks its "Continue / Fortsett / Fortsätt / Jatka…" button. Buttons outside such dialogs are never clicked, so a "Continue" on a payment screen is left alone.
- **No tab discarding:** tabs on enabled domains are marked non-discardable, so Chrome's Memory Saver doesn't put the bank tab to sleep while you work in other tabs.

## Limits

- Idly can't get past a **server-side absolute session limit**, for example a forced re-login after a fixed number of hours whatever you do.
- Some sites ignore synthetic events. On those, only the dialog auto-click helps.
- After you remove a domain, reload any open tabs on it to fully stop Idly there.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest; host access is requested per domain at runtime |
| `background.js` | Registers the content script for enabled domains, runs the alarm tick, sets the badge |
| `content.js` | Simulates activity and dismisses session warnings |
| `popup.html` / `popup.js` | GUI: this-page toggle, domain list, interval setting |
| `shared.js` | Defaults, domain → match-pattern helpers |
