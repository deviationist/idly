Design the popup UI for **Idly**, a Chrome extension that keeps chosen websites (for example an online bank) from logging the user out for inactivity. The popup opens from the toolbar icon.

**Constraints**
- Chrome extension popup: fixed width of 320–360px, height grows with content, maximum of about 600px.
- Deliver one `popup.html` with inline `<style>`. Use plain HTML and CSS only: no frameworks, no external fonts or CDNs (extension CSP), no JavaScript.
- Support light and dark mode through `prefers-color-scheme`, using CSS custom properties on `:root`.
- Calm, trustworthy, minimal. It sits next to a banking site, so no playful gimmicks. A subtle "alive" motif, like a soft pulse on the active state, is welcome.

**Sections, top to bottom**
1. **Header:** the name "Idly" with a small mark.
2. **This page:** the current hostname (can be long, like `netbank.example.com`), a status line, and one full-width button. Two states:
   - Not active: status "Not active", primary button "Keep me logged in".
   - Active: status "Staying logged in", or "Staying logged in (via example.com)" when a parent domain covers it; secondary button "Stop keeping me logged in", or "Stop for all of example.com" when a parent domain covers it.
   - A third state for pages it can't run on (like `chrome://`): the message "Idly can't run on this page." and no button.
3. **Active domains:** a list of domains, each with a Remove action, and an empty state ("No domains yet."). Below the list, an inline form with a text input (placeholder "Add a domain, e.g. example.com") and an Add button. Add a hint, "A domain also covers all of its subdomains.", and an inline error line such as "That doesn't look like a domain." or "Permission was declined."
4. **Settings:** "Nudge every (minutes)", a number input with a minimum of 0.5 and a step of 0.5.

**Keep these element IDs exactly.** The existing `popup.js` depends on them:
`current-host`, `current-status`, `current-btn`, `sites` (a `<ul>` that the script fills with `<li><span>domain</span><button>Remove</button></li>`), `add` (a `<form>`), `domain` (text input), `error`, `interval` (number input).
The script also switches these classes, so style them: `#current-status.on` (the active state), `#current-btn.primary` (primary compared with secondary), `li.muted` (the empty-state item), and `.error:empty` (hidden when there's no error). Load the script with `<script type="module" src="popup.js"></script>` at the end of `<body>`.
