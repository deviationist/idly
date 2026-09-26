// Tests the session-warning decision in detect.js, fed with the facts content.js
// would gather from a page. Real-world cases are anonymised: generic wording only.
// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";

await import("../words.js");
await import("../detect.js");
const { decide, classify, countingDown } = globalThis.IdlyDetect;

const IDLE = 4 * 60 * 1000;
const warning = (over) => ({ idleMs: IDLE, dialogLike: true, text: "", hints: "", countdown: false, buttons: [], ...over });
const clicks = (facts, label) => {
  const d = decide(facts);
  assert.equal(d.index === null ? null : facts.buttons[d.index], label, d.reason);
};

test("a real Norwegian bank warning (anonymised)", () => {
  clicks(warning({
    text: "Inaktivitetsmelding Du har vært inaktiv i nettbanken en stund. Vi logger deg ut om 60 sekunder.",
    hints: "session-timeout-modal modal__body",
    countdown: true,
    buttons: ["Close", "Hold meg innlogget"],
  }), "Hold meg innlogget");
});

test("warnings in other languages", () => {
  clicks(warning({ text: "Your session will expire in 2 minutes.", buttons: ["Log out", "Stay signed in"] }), "Stay signed in");
  clicks(warning({ text: "Du loggas snart ut på grund av inaktivitet.", buttons: ["Logga ut", "Fortsätt"] }), "Fortsätt");
  clicks(warning({ text: "Ihre Sitzung läuft in 60 Sekunden ab.", buttons: ["Abmelden", "Angemeldet bleiben"] }), "Angemeldet bleiben");
  clicks(warning({ text: "Votre session va expirer.", buttons: ["Se déconnecter", "Rester connecté"] }), "Rester connecté");
  clicks(warning({ text: "Istuntosi vanhenee pian.", buttons: ["Kirjaudu ulos", "Jatka"] }), "Jatka");
});

test("an unknown language, recognised by countdown and class names alone", () => {
  clicks(warning({
    text: "Blorf zaxon 0:59",
    hints: "session-expiry-dialog",
    countdown: true,
    buttons: ["×", "Zorp klang"],
  }), "Zorp klang");
});

test("never clicks while the user is active", () => {
  clicks(warning({ idleMs: 5000, text: "Your session will expire", buttons: ["Continue"] }), null);
});

test("never clicks ordinary dialogs", () => {
  // A payment confirmation right after a click: not idle, and no session evidence.
  clicks(warning({ idleMs: 3000, text: "Bekreft betaling på 5000 kr", buttons: ["Avbryt", "Fortsett"] }), null);
  // Even after a long idle, without any session evidence.
  clicks(warning({ text: "Bekreft betaling på 5000 kr", buttons: ["Avbryt", "Fortsett"] }), null);
  clicks(warning({ text: "Do you want to save your changes?", buttons: ["Don't save", "Save"] }), null);
  clicks(warning({ dialogLike: false, text: "Your session will expire", buttons: ["Continue"] }), null);
});

test("never clicks log out, close or cancel", () => {
  clicks(warning({ text: "Your session has expired.", buttons: ["Log out"] }), null);
  clicks(warning({ text: "Vi logger deg ut om 60 sekunder.", buttons: ["Logg ut", "Lukk"] }), null);
  clicks(warning({ text: "Session timeout", buttons: ["Cancel", "Close"] }), null);
});

test("leaves ambiguous dialogs alone", () => {
  clicks(warning({ text: "Session timeout", hints: "timeout", buttons: ["Zorp", "Blip"] }), null);
});

test("classify", () => {
  assert.equal(classify("Ja, fortsett"), "stay");
  assert.equal(classify("Jakke"), "other");
  assert.equal(classify("Yes, log me out"), "leave");
  assert.equal(classify("Nei"), "dismiss");
  assert.equal(classify("×"), "dismiss");
  assert.equal(classify(""), "unlabelled");
  for (const l of ["Logg ut", "Log out", "Logga ut", "Log ud", "Kirjaudu ulos", "Abmelden", "Sign out"]) assert.equal(classify(l), "leave", l);
  for (const l of ["Close", "Lukk", "Avbryt", "Cancel", "Stäng", "Schließen"]) assert.equal(classify(l), "dismiss", l);
});

test("countingDown spots ticking numbers, including mm:ss", () => {
  assert.ok(countingDown("Vi logger deg ut om 60 sekunder", "Vi logger deg ut om 58 sekunder"));
  assert.ok(countingDown("Logging out in 1:00", "Logging out in 0:59"));
  assert.ok(!countingDown("Balance 5000", "Balance 5000"));
  assert.ok(!countingDown("Step 2 of 3", "Step 3 of 3"));
  assert.ok(!countingDown("Balance 5000", "Balance 3000"));
});
