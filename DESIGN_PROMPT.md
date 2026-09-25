# Claude Design prompt: Idly popup and icon

Paste everything below the line into Claude Design.

---

Design the toolbar popup and icon for **Idly**, a Chrome extension that stops websites from logging you out when you're idle.

## Who it's for and why

The user logs into their online bank, then spends a while in other tabs (a budgeting spreadsheet, email). When they come back to the bank tab they've been logged out and have to go through the full login again, often with a code from a phone or card reader. Idly fixes that. On the bank tab the user clicks the Idly icon, then **Keep me logged in**. From then on Idly quietly keeps that site's session alive in the background.

The popup is used in two moments:
1. **Turning it on:** "Keep me logged in on *this* site." This is the main action. It should be obvious and take one click.
2. **Checking or managing:** "Where is Idly active?" This shows the list of sites, where the user can remove one or add one by typing a domain.

People open it for a few seconds, next to their bank. It has to feel **calm, trustworthy and quiet**: closer to a system utility than a consumer app. Avoid playful mascots, loud gradients and anything that looks like a security warning. A gentle "alive" cue on the active state is welcome, such as a softly breathing dot or a slow pulse. Honour `prefers-reduced-motion`. All text is English.

## Deliverables

1. **`popup.html`**: one self-contained file with an inline `<style>`.
2. **An icon** as SVG that still reads at 16×16 in the toolbar, with sizes 16, 32, 48 and 128. It should suggest "staying awake" or "session kept alive", for example an open eye, a steady pulse or a small lit dot. It must not suggest a lock or a shield, because Idly isn't a security product. The icon sits next to a green **ON** badge (`#1b7d44`) that Chrome draws over its bottom-right corner on active sites, so leave room for it.

Please show mockups of every state listed below, in both light and dark mode.

## Technical constraints (Chrome extension)

- The popup width is fixed at **320–360px**. The height grows with content up to about 600px, after which the domain list scrolls rather than the whole popup.
- **Plain HTML and CSS only.** No JavaScript, no frameworks, and no external fonts, CDNs or remote images: the extension's content security policy blocks them. Use the system font stack. Icons inside the popup must be inline SVG.
- **Light and dark mode are both required.** Chrome follows the system or browser theme through `@media (prefers-color-scheme: dark)`, so no manual toggle is needed. Define colours as custom properties on `:root`, and set `color-scheme: light dark` so native controls (the checkbox, number input and scrollbars) match the theme.
- Text must meet WCAG AA contrast (4.5:1) in **both** themes, including the green active status and any text on a green button. The current green is `#1b7d44`, with `#4cc27d` for status text on dark.
- Hostnames can be long (`netbank.example.com`, `secure.online-banking.example.co.uk`). They must wrap or truncate cleanly without making the popup wider.
- Make it keyboard accessible, with visible focus rings and sufficient contrast.

## Layout, top to bottom

### 1. Header
The name "Idly" with the icon.

### 2. This page
This section is the focus of the popup. It shows the current tab's hostname, a status line and one full-width button. It has four states:

| State | Hostname line | Status line | Button |
|---|---|---|---|
| Not active | `netbank.example.com` | "Not active" | Primary: **Keep me logged in** |
| Active on this domain | `netbank.example.com` | "Staying logged in" (the active style) | Secondary: **Stop keeping me logged in** |
| Active through a wildcard entry | `netbank.example.com` | "Staying logged in (via *.example.com)" | Secondary: **Stop for all of *.example.com** |
| Unsupported page (for example `chrome://settings`) | "Idly can't run on this page." | empty | hidden |

### 3. Active domains
- A list of domains (such as `example.com` or `bank.example.org`), each with a small **Remove** action. It's usually 1–5 items, but it should handle 20 or more by scrolling.
- An empty state: "No domains yet."
- Below the list, an inline form with a text input (placeholder "Add a domain, e.g. example.com") and an **Add** button, plus an **Include subdomains** checkbox. When it's ticked, the entry is saved as `*.domain`.
- A short help block explaining the two ways to write an entry. Keep both lines, but style them to suit the design:
  - `example.com`: "Only example.com itself"
  - `*.example.com`: "example.com and all its subdomains, like www.example.com and auth.example.com"
- Entries in the list can be either form (`bank.example.org` or `*.example.com`). Make the `*.` wildcard readable at a glance, but keep it as plain text in the list.
- An inline error line, hidden when empty. Examples: "That doesn't look like a domain.", "Already in the list.", "Permission was declined."

Adding a domain opens Chrome's own permission prompt, which you don't need to design.

### 4. Settings
One low-key row: "Nudge every (minutes)", with a small number input (minimum 0.5, step 0.5, default 1). This is an advanced setting, so give it less weight than everything above.

## Contract with the existing script, so keep these exactly

`popup.js` fills in and toggles the markup, so the design has to keep these hooks exactly:

**Element IDs**
- `current-host`: the hostname, or the unsupported-page message
- `current-status`: the status line
- `current-btn`: the This page button. It starts with the `hidden` attribute, and the script sets its label.
- `sites`: an empty `<ul>`. The script fills it with `<li><span>example.com</span><button>Remove</button></li>` for each domain, or `<li class="muted">No domains yet.</li>` when there are none.
- `add`: the `<form>`. `domain` is its text input, with a submit button inside the form.
- `subdomains`: an "Include subdomains" checkbox inside the form. The script ticks it when the user types `*.`, removes the `*.` from the input when it's unticked, and resets it after a successful add.
- `error`: the error line
- `interval`: the number input

**Classes the script toggles** (please style all of them)
- `#current-status.on`: active. The script sets only the text, so the active dot or pulse must come from CSS, for example `::before`.
- `#current-btn.primary`: the primary button. Without the class it's the secondary or stop style.
- `li.muted`: the empty-state item
- `.error:empty`: must be hidden

Style `#sites li`, `#sites li span` and `#sites li button` through those selectors, because the script adds no classes to the list items.

End `<body>` with `<script type="module" src="popup.js"></script>`.
