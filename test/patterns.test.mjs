// Checks the session-warning word lists in content.js. Content scripts can't be
// modules, so the patterns are read from the source rather than imported.
// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../content.js", import.meta.url), "utf8");
const pattern = (name) => {
  const literal = src.match(new RegExp(`const ${name} =\\s*(\\/.+\\/[a-z]*);`))?.[1];
  assert.ok(literal, `${name} not found in content.js`);
  return new Function(`return ${literal}`)();
};
const SESSION_TEXT = pattern("SESSION_TEXT");
const CONTINUE_TEXT = pattern("CONTINUE_TEXT");

test("session warnings are recognised", () => {
  for (const text of [
    "Du har vært inaktiv i nettbanken en stund. Vi logger deg ut om 60 sekunder.", // real-world, Norwegian
    "Du blir snart logget ut",
    "Your session is about to expire",
    "You will be logged out due to inactivity",
    "Vi logger deg ut om 60 sekunder", // the same warning, without "inaktiv"
    "Du kommer snart att loggas ut",
    "Vi loggar dig ut om 60 sekunder",
    "Vi logger dig ud om 60 sekunder",
    "Du bliver logget ud om lidt",
    "Istuntosi vanhenee pian",
  ]) assert.ok(SESSION_TEXT.test(text), text);
});

test("ordinary dialogs aren't treated as session warnings", () => {
  for (const text of ["Bekreft betaling på 5000 kr", "Confirm payment", "Do you want to save changes?"])
    assert.ok(!SESSION_TEXT.test(text), text);
});

test("stay-logged-in buttons are recognised", () => {
  for (const label of [
    "Hold meg innlogget", // real-world, Norwegian
    "Fortsett", "Forbli innlogget", "Bli innlogget",
    "Håll mig inloggad", "Fortsätt", "Hold mig logget ind", "Fortsæt",
    "Jatka", "Pysy kirjautuneena",
    "Continue", "Stay signed in", "Keep me logged in", "Extend session", "I'm still here",
  ]) assert.ok(CONTINUE_TEXT.test(label), label);
});

test("logout, close and cancel buttons are never recognised", () => {
  for (const label of ["Logg ut", "Log out", "Logga ut", "Log ud", "Kirjaudu ulos", "Close", "Lukk", "Avbryt", "Cancel", "Sign out"])
    assert.ok(!CONTINUE_TEXT.test(label), label);
});
