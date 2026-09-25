# Handoff: Idly popup, icon and domain rules

## Overview
Idly is a Chrome extension (MV3) that stops websites from logging the user out when idle. This bundle contains the toolbar popup, the toolbar icon, and the behaviour rules the popup's script (`popup.js`) needs to implement.

## About the design files
- **`popup.html` is production-ready.** It is plain HTML + inline CSS written for the extension's CSP (no JS, no external fonts/CDNs, system font stack, inline SVG). Drop it into the extension as-is and adjust `popup.js` to the hooks below.
- **`reference/`** holds design references only: `Idly Mockups.dc.html` (every state, light and dark; open in a browser with `support.js` next to it) and the original brief `DESIGN_PROMPT.md`. Do not ship these. The mockups re-implement the popup's styling for display; `popup.html` is the source of truth.

## Fidelity
High-fidelity. Colours, type, spacing and copy are final.

## Icon: pending choice
Three colour options, same geometry (open eye, centred, on a rounded tile):
- `a`: slate tile `#23282b`, cream eye `#f4f1ea`, green pupil `#3fbf74`
- `b`: deep green tile `#14543a`, cream eye `#f4f1ea`, light green pupil `#8fe3b0`
- `c`: pale green tile `#e3f1e8`, green eye and pupil `#1f8a4c`

Files: `icons/png/{a,b,c}/icon-{16,32,48,128}.png` and `icons/svg/{a,b,c}-{16,32,48,128}.svg`. Copy the chosen set to `icons/icon-N.png`. Each size has its own stroke weight tuned for legibility; don't just scale the 128.

**Also update the inline SVG in `popup.html`'s `<header>`** to the chosen colours (it currently uses the monochrome version: tile `#23282b`, eye and pupil `#f4f1ea`).

Chrome's ON badge: `chrome.action.setBadgeText({text:'ON'})`, `setBadgeBackgroundColor({color:'#1f8a4c'})`, and white text.

```json
"icons": { "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" },
"action": { "default_popup": "popup.html", "default_icon": { "16": "icons/icon-16.png", "32": "icons/icon-32.png" } }
```

## Popup layout (340px wide, max 600px tall)
1. **Header**: 20px icon + "Idly" (14px/600). Padding 14px 16px 12px.
2. **This page** card: margin 0 12px, padding 14px, surface bg, 1px border, radius 10px. Label "THIS PAGE" (11px/600, 0.06em tracking, uppercase, muted). Hostname 15px/600 (wraps with `overflow-wrap:anywhere`). Status 12.5px. Full-width 36px button, radius 8px.
3. **Active websites**: padding 18px 16px 0. List max-height 222px, scrolls; rows min-height 36px, 1px dividers, hostname truncates with ellipsis, "Remove" is a 12px muted text button. Then the add row (32px input field + 32px "Add" button, gap 6px, vertically centred), `#error`, `#notice`, the "Include subdomains" checkbox, and the scope hint.
4. **Footer**: top border, "Nudge every (minutes)" 12px muted + 64×26px number input.

## Element hooks (keep exactly)
Existing: `#current-host`, `#current-status` (+ `.on`), `#current-btn` (+ `.primary`, starts `hidden`), `#sites` (script fills `<li><span>…</span><button>Remove</button></li>` or `<li class="muted">…</li>`), `#add` form, `#domain` input, `#error`, `#interval`.

**New:**
- `#subdomains`: checkbox, checked by default.
- `#notice`: neutral info line (hidden when empty), for non-error feedback.
- `.wild`: the `*.` prefix inside the field. Pure CSS: it shows while typing with `#subdomains` checked (`:has()`). There's no JS needed for it.
- `.scope-all` / `.scope-exact`: the two hint lines, toggled by CSS from the checkbox state.

## Copy
- This page: "Not active" / "Staying logged in" / "Staying logged in (via *.example.com)" / "Idly can't run on this page."
- Buttons: "Keep me logged in" (primary) / "Stop keeping me logged in" / "Stop for all of example.com"
- Empty list: "No websites yet."
- Placeholder: "Add a website, e.g. bank.com"
- Checkbox: "Include subdomains"
- Hints: "Also covers its subdomains, such as www. and auth." / "Covers only the exact website you type."
- Errors: "That doesn't look like a website address." / "Already in the list." / "Already covered by *.{parent}." / "Permission was declined."
- Notice: "Replaced {host} with *.{host}."

## Behaviour for `popup.js`

### Entry types
- `bank.com` matches **only** `bank.com`.
- `*.bank.com` matches `bank.com` **and** every subdomain (`www.bank.com`, `auth.bank.com`, …).
- "Via parent" occurs only through wildcard entries: the status shows the matching entry, e.g. "Staying logged in (via *.example.com)", and the button says "Stop for all of example.com" (removes that wildcard entry).

### Input sanitisation (on paste, and again on submit)
1. Trim and lowercase.
2. If it starts with `*.`, strip it and set `#subdomains.checked = true`.
3. If there's no `://`, prepend `https://`, then take `new URL(v).hostname`. This drops the scheme, credentials, port, path, query and hash.
4. Strip a trailing `.`.
5. Write the cleaned hostname back into `#domain` so the user sees the result (e.g. pasting `https://www.bank.com/login?x=1` → `www.bank.com`).
6. Reject with "That doesn't look like a website address." if there's no dot, it's an IP address, `localhost`, or `URL` throws.
7. Open question: whether to strip a leading `www.` when subdomains are on.

### Saving
Stored value = `#subdomains.checked ? '*.' + host : host`.

### Duplicate / overlap rules (check in this order)
1. Exact same stored value already exists → error "Already in the list."
2. Adding exact `host` and some wildcard `*.p` covers it (`host === p` or `host.endsWith('.' + p)`) → error "Already covered by *.p."
3. Adding `*.host` while exact `host` (or exact subdomains of it) exist → replace them with `*.host`, and show the notice "Replaced {host} with *.{host}."
4. Otherwise add.
Clear `#error` and `#notice` on input and after each successful add.

### Permissions
Handled on the implementation side; request should match the entry type (`*://bank.com/*` vs `*://*.bank.com/*`).

### Motion
The active dot (`#current-status.on::before`) breathes: opacity 0.4→1 and scale 0.8→1, 2.8s ease-in-out, infinite. It's disabled under `prefers-reduced-motion`.

## Design tokens (CSS custom properties on `:root`)
| token | light | dark |
|---|---|---|
| --bg | #fbfaf8 | #1b1c1e |
| --surface | #f2f0ec | #232427 |
| --field | #ffffff | #17181a |
| --fg | #1d1c1a | #ecebe8 |
| --muted | #64605a | #a3a19c |
| --placeholder | #8a867f | #7f7d79 |
| --border | #e3e0da | #313235 |
| --border-strong | #cdc9c1 | #47494d |
| --hover | #ebe8e3 | #2c2d31 |
| --ink / --ink-hover | #1d1c1a / #34322f | #ecebe8 / #ffffff |
| --on-ink | #fbfaf8 | #1b1c1e |
| --on (status text) | #1b7340 | #62c98e |
| --dot | #1f8a4c | #3fbf74 |
| --err | #b3261e | #f08a80 |
| --focus | #3a6fd8 | #7aa5ff |

Type: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`, 13px/1.4 base. Radii are 10 (card), 8 (main button), 7 (field/Add), 6 (number input) and 5 (Remove). Focus is a 2px `--focus` outline with a 2px offset (`:focus-visible`; the field uses `:focus-within`).

## Files
- `popup.html`: ship it.
- `icons/png/`, `icons/svg/`: icon options.
- `reference/Idly Mockups.dc.html`: all 13 states in light and dark (reference only).
- `reference/DESIGN_PROMPT.md`: the original brief.
