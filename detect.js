// Decides whether a dialog is a session-timeout warning and which button keeps the
// session alive. Pure logic with no DOM access: content.js gathers the facts, and
// test/detect.test.mjs runs this under Node. Loaded after words.js, before content.js.
//
// A dialog is only acted on when all of these hold:
//   1. The user has been idle (no trusted input) for at least MIN_IDLE_MS. A payment
//      confirmation or "save changes?" dialog appears right after a click, so this is
//      also the main guard against clicking the wrong dialog.
//   2. It looks like a dialog (ARIA role, aria-modal, <dialog>, or a fixed modal).
//   3. At least one piece of evidence: a countdown, an English class/id hint, or
//      session wording in a known language.
// The button is the one whose label reads as "stay"; failing that, the only button
// left after removing leave (log out) and dismiss (close/cancel) buttons. If that's
// ambiguous, nothing is clicked. In the worst case a wrong click logs you out a
// minute early, which the warning was about to do anyway.

(() => {
  const MIN_IDLE_MS = 60 * 1000;

  const languages = Object.values(globalThis.IdlyWords);
  const all = (kind) => [...new Set(languages.flatMap((l) => l[kind]))];
  const WORDS = { session: all("session"), stay: all("stay"), leave: all("leave"), dismiss: all("dismiss") };

  const normalize = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const words = (list) => list.map(escape).join("|");

  // "Starts with, as whole words": "ja" matches "ja, fortsett" but not "jakke".
  const STAY = new RegExp(`^(${words(WORDS.stay)})(?![\\p{L}\\p{N}])`, "u");
  const DISMISS = new RegExp(`^(${words(WORDS.dismiss)})(?![\\p{L}\\p{N}])|^[×✕✖x]$`, "u");
  const LEAVE = new RegExp(`(^|[^\\p{L}])(${words(WORDS.leave)})(?![\\p{L}])`, "u");
  const HINT = new RegExp(globalThis.IdlyHints.map(escape).join("|"), "i");

  const hasSessionWords = (text) => WORDS.session.some((w) => text.includes(w));

  function classify(label) {
    const l = normalize(label);
    if (!l) return "unlabelled";
    if (LEAVE.test(l)) return "leave";
    if (DISMISS.test(l)) return "dismiss";
    if (STAY.test(l)) return "stay";
    return "other";
  }

  // Numbers in a text, with mm:ss and hh:mm:ss read as seconds.
  function numbers(text) {
    return [...String(text ?? "").matchAll(/\d+(?::\d{2}){0,2}/g)].map(([m]) =>
      m.split(":").reduce((acc, part) => acc * 60 + Number(part), 0));
  }

  // True when a number at the same position went down by 1–15 between two samples
  // taken a second or two apart: a ticking countdown, in any language.
  function countingDown(before, after) {
    const a = numbers(before);
    const b = numbers(after);
    return a.some((n, i) => b[i] !== undefined && n - b[i] >= 1 && n - b[i] <= 15);
  }

  // facts: { idleMs, dialogLike, text, hints, countdown, buttons: [label, ...] }
  // Returns { index, reason } with index null when nothing should be clicked.
  function decide(facts) {
    const skip = (reason) => ({ index: null, reason });
    if (!(facts.idleMs >= MIN_IDLE_MS)) return skip("user was active in the last minute");
    if (!facts.dialogLike) return skip("not a dialog");

    const evidence = [
      facts.countdown && "countdown",
      HINT.test(facts.hints ?? "") && "class/id hint",
      hasSessionWords(normalize(facts.text)) && "session wording",
    ].filter(Boolean);
    if (!evidence.length) return skip("no sign of a session warning");

    const kinds = facts.buttons.map(classify);
    const stay = kinds.indexOf("stay");
    if (stay !== -1) return { index: stay, reason: `"stay" button; evidence: ${evidence.join(", ")}` };
    const others = kinds.flatMap((k, i) => (k === "other" ? [i] : []));
    if (others.length === 1) return { index: others[0], reason: `only remaining button; evidence: ${evidence.join(", ")}` };
    return skip(others.length ? "several unknown buttons" : "no button to keep the session");
  }

  globalThis.IdlyDetect = { decide, classify, countingDown, numbers, MIN_IDLE_MS };
})();
