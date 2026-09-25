// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseInput, planAdd, covers, patternFor, stripWww, hasWildcardPrefix, clampInterval, MESSAGES,
} from "../shared.js";

test("parseInput cleans hosts out of URLs", () => {
  assert.deepEqual(parseInput("bank.com"), { host: "bank.com", wildcard: false });
  assert.deepEqual(parseInput("  Bank.COM  "), { host: "bank.com", wildcard: false });
  assert.deepEqual(parseInput("https://www.bank.com/login?x=1#top"), { host: "www.bank.com", wildcard: false });
  assert.deepEqual(parseInput("http://user:pw@auth.bank.com:8443/"), { host: "auth.bank.com", wildcard: false });
  assert.deepEqual(parseInput("bank.com."), { host: "bank.com", wildcard: false });
  assert.deepEqual(parseInput("bank.co.uk"), { host: "bank.co.uk", wildcard: false });
});

test("parseInput recognises a *. prefix, with or without a scheme", () => {
  assert.deepEqual(parseInput("*.bank.com"), { host: "bank.com", wildcard: true });
  assert.deepEqual(parseInput("https://*.Bank.com/login"), { host: "bank.com", wildcard: true });
});

test("parseInput converts internationalised names to punycode", () => {
  assert.deepEqual(parseInput("bølgen.no"), { host: "xn--blgen-vua.no", wildcard: false });
});

test("parseInput rejects empty input", () => {
  for (const s of ["", "   ", "https://", null, undefined]) assert.deepEqual(parseInput(s), { error: "empty" }, String(s));
});

test("parseInput rejects hosts without a TLD, IPs and malformed names", () => {
  for (const s of [
    "netbank", "localhost", "http://localhost:3000", "*.", "*.com", "*bank.com", "bank .com",
    "192.168.1.1", "1.2", "[::1]", "bank.123", "bank.c", "-bank.com", "bank-.com", "ba_nk.com",
    "bank..com", `${"a".repeat(64)}.com`, `${"a.".repeat(127)}com`, "*.*.bank.com",
  ]) assert.deepEqual(parseInput(s), { error: "invalid" }, s);
});

test("covers: exact entries match one host, wildcards match the domain and subdomains", () => {
  assert.ok(covers("bank.com", "bank.com"));
  assert.ok(!covers("bank.com", "www.bank.com"));
  for (const h of ["bank.com", "www.bank.com", "a.b.bank.com"]) assert.ok(covers("*.bank.com", h), h);
  for (const h of ["notbank.com", "bank.com.evil.io", "com"]) assert.ok(!covers("*.bank.com", h), h);
});

test("patternFor builds Chrome match patterns", () => {
  assert.equal(patternFor("bank.com"), "*://bank.com/*");
  assert.equal(patternFor("*.bank.com"), "*://*.bank.com/*");
});

test("stripWww removes www. only when a domain remains", () => {
  assert.equal(stripWww("www.bank.com"), "bank.com");
  assert.equal(stripWww("www.com"), "www.com");
  assert.equal(stripWww("auth.bank.com"), "auth.bank.com");
});

test("hasWildcardPrefix", () => {
  assert.ok(hasWildcardPrefix("*.bank.com"));
  assert.ok(hasWildcardPrefix(" https://*.bank.com"));
  assert.ok(!hasWildcardPrefix("bank.com"));
});

test("planAdd adds new entries", () => {
  assert.deepEqual(planAdd([], "bank.com", false), { entry: "bank.com", replaced: [], sites: ["bank.com"] });
  assert.deepEqual(planAdd(["a.org"], "bank.com", true), { entry: "*.bank.com", replaced: [], sites: ["a.org", "*.bank.com"] });
});

test("planAdd strips www. from wildcards only", () => {
  assert.equal(planAdd([], "www.bank.com", true).entry, "*.bank.com");
  assert.equal(planAdd([], "www.bank.com", false).entry, "www.bank.com");
});

test("planAdd refuses duplicates", () => {
  assert.deepEqual(planAdd(["bank.com"], "bank.com", false), { error: MESSAGES.duplicate });
  assert.deepEqual(planAdd(["*.bank.com"], "bank.com", true), { error: MESSAGES.duplicate });
  assert.deepEqual(planAdd(["*.bank.com"], "www.bank.com", true), { error: MESSAGES.duplicate });
});

test("planAdd refuses entries a wildcard already covers", () => {
  assert.deepEqual(planAdd(["*.bank.com"], "bank.com", false), { error: "Already covered by *.bank.com." });
  assert.deepEqual(planAdd(["*.bank.com"], "auth.bank.com", false), { error: "Already covered by *.bank.com." });
  assert.deepEqual(planAdd(["*.bank.com"], "a.bank.com", true), { error: "Already covered by *.bank.com." });
});

test("planAdd lets a wildcard replace the entries it covers", () => {
  const r = planAdd(["x.org", "bank.com", "auth.bank.com", "*.a.bank.com", "notbank.com"], "bank.com", true);
  assert.equal(r.entry, "*.bank.com");
  assert.deepEqual(r.replaced, ["bank.com", "auth.bank.com", "*.a.bank.com"]);
  assert.deepEqual(r.sites, ["x.org", "notbank.com", "*.bank.com"]);
  assert.equal(MESSAGES.replaced(r.replaced, r.entry), "Replaced bank.com, auth.bank.com and *.a.bank.com with *.bank.com.");
  assert.equal(MESSAGES.replaced(["bank.com"], "*.bank.com"), "Replaced bank.com with *.bank.com.");
});

test("clampInterval keeps the nudge interval sane", () => {
  assert.equal(clampInterval("1"), 1);
  assert.equal(clampInterval(0), 0.5);
  assert.equal(clampInterval(0.7), 0.5);
  assert.equal(clampInterval(0.8), 1);
  assert.equal(clampInterval(999), 60);
  assert.equal(clampInterval("abc"), 1);
  assert.equal(clampInterval(""), 0.5);
});
