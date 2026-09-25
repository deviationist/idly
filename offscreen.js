// Hidden offscreen document. Service workers have no matchMedia, so this page
// reports Chrome's light/dark theme to background.js, which swaps the toolbar icon.
const dark = matchMedia("(prefers-color-scheme: dark)");
const report = () => chrome.runtime.sendMessage({ type: "idly:scheme", dark: dark.matches });
dark.addEventListener("change", report);
report();
