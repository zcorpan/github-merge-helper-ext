import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkMessage,
  cleanSuggestion,
  cleanTrailer,
  closingRefs,
  extractRefs,
  issueLinks,
  stripInvisible,
  validPullRef,
} from "../src/safety.js";

const known = (text) => extractRefs(text, "whatwg", "html");

test("validPullRef rejects path tricks", () => {
  assert.ok(validPullRef("whatwg", "html", 1));
  assert.ok(validPullRef("web-platform-tests", "wpt", 63341));
  assert.ok(!validPullRef("..", "html", 1));
  assert.ok(!validPullRef("whatwg", "..", 1));
  assert.ok(!validPullRef("%2e%2e", "html", 1));
  assert.ok(!validPullRef("whatwg", "html/../../user", 1));
  assert.ok(!validPullRef("whatwg", "html", 0));
  assert.ok(!validPullRef("whatwg", "html", "1"));
});

test("stripInvisible removes bidi, zero-width, tag, and control characters", () => {
  const { text, removed } = stripInvisible("Fix‮ evil​\u{E0041}\u0007 thing\r\nok ");
  assert.equal(text, "Fix evil thing\nok");
  assert.equal(removed, 5);
});

test("closingRefs finds every GitHub closing keyword form", () => {
  const refs = closingRefs(
    "Fixes #1, fixes #2, and closes whatwg/dom#3.\nResolved: https://github.com/whatwg/html/issues/4. See #5.",
    "whatwg",
    "html",
  );
  assert.deepEqual(refs.sort(), ["whatwg/dom#3", "whatwg/html#1", "whatwg/html#2", "whatwg/html#4"]);
});

test("checkMessage flags references not in the PR", () => {
  const knownRefs = known("Fixes #12. Tests: https://github.com/web-platform-tests/wpt/pull/5. Follow-up to 36470c17827635ee0604554e3df33de71e69dc11.");
  const ok = checkMessage(
    {
      title: "Fix the thing",
      body: "Follow-up to 36470c1.\n\nTests: https://github.com/web-platform-tests/wpt/pull/5.\n\nFixes https://github.com/whatwg/html/issues/12.",
    },
    knownRefs,
    "whatwg",
    "html",
  );
  assert.deepEqual(ok, { closes: ["#12"], unknown: [] });

  const injected = checkMessage(
    { title: "Fix the thing", body: "Fixes #12, fixes #13. See https://evil.example/x?k=1 and @someone." },
    knownRefs,
    "whatwg",
    "html",
  );
  assert.deepEqual(injected.closes, ["#12", "#13"]);
  assert.deepEqual(injected.unknown.sort(), ["#13", "@someone", "https://evil.example/x?k=1"]);
});

test("checkMessage ignores backticked at-rules and emails", () => {
  const r = checkMessage({ title: "Support `@import` in sheets", body: "Thanks to a@b.example." }, [], "whatwg", "html");
  assert.deepEqual(r.unknown, []);
});

test("cleanSuggestion validates shape and strips invisible characters", () => {
  const { suggestion, removedChars } = cleanSuggestion({
    verdict: "generated",
    issues: [],
    title: "Add​ thing\nmore",
    body: "Body‮",
    notes: "",
  });
  assert.equal(suggestion.title, "Add thing more");
  assert.equal(suggestion.body, "Body");
  assert.equal(removedChars, 2);
  assert.throws(() => cleanSuggestion({ verdict: "merge_now", issues: [], title: "", body: "", notes: "" }));
  assert.throws(() => cleanSuggestion({ verdict: "ok", issues: "x", title: "", body: "", notes: "" }));
  assert.throws(() => cleanSuggestion({ verdict: "ok", issues: [], title: "x".repeat(201), body: "", notes: "" }));
});

test("cleanTrailer accepts only Name <email>", () => {
  assert.equal(cleanTrailer("co-authored-by: Jane Doe <jane@example.com>"), "Co-authored-by: Jane Doe <jane@example.com>");
  assert.equal(cleanTrailer("Co-authored-by: <script>@x"), null);
  assert.equal(cleanTrailer("Co-authored-by: Jane <jane@example.com> extra"), null);
  assert.equal(cleanTrailer("Co-authored-by: Ja‮ne <jane@example.com>"), "Co-authored-by: Jane <jane@example.com>");
});

test("reference extraction stays fast on hostile input", () => {
  const hostile = ["a".repeat(60_000), "a/".repeat(30_000), "fixes ".repeat(10_000), "<!--".repeat(16_000)].join(" ");
  const start = performance.now();
  extractRefs(hostile, "whatwg", "html");
  closingRefs(hostile, "whatwg", "html");
  stripInvisible(hostile);
  assert.ok(performance.now() - start < 1000);
});

test("issueLinks builds github.com URLs from validated parts only", () => {
  const text = "Supersedes #9457 and whatwg/dom#1185; see evil_org/x#1, a#b#2, javascript:alert(1)#3 and https://evil.example/#4.";
  const links = issueLinks(text, "whatwg", "html");
  assert.deepEqual(
    links.map((l) => [text.slice(l.start, l.end), l.href]),
    [
      ["#9457", "https://github.com/whatwg/html/issues/9457"],
      ["whatwg/dom#1185", "https://github.com/whatwg/dom/issues/1185"],
      ["#3", "https://github.com/whatwg/html/issues/3"],
    ],
  );
  for (const { href } of links) assert.match(href, /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/issues\/\d+$/);
});
