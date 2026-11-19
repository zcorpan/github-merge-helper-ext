import { test } from "node:test";
import assert from "node:assert/strict";
import { issueRefPath, issueRefVerdict, parseIssueRef } from "../src/issueref.js";

// A document parsed so far. data: GitHub's page data JSON, done: whether the
// parser got past it. body: whether <head> is done.
function fakeDoc(nwo, { ids = [], data = null, done = true, body = true } = {}) {
  const script = data === null ? null : { textContent: data, nextSibling: done ? {} : null, parentNode: null };
  return {
    body: body ? {} : null,
    querySelector: (selector) => {
      if (selector === 'meta[name="octolytics-dimension-repository_nwo"]') return nwo ? { content: nwo } : null;
      if (selector === 'script[data-target="react-app.embeddedData"]') return script;
      return null;
    },
    getElementById: (id) => (ids.includes(id) ? {} : null),
  };
}

const pageData = (...headings) =>
  JSON.stringify({
    payload: {
      codeViewRepoRoute: {
        overview: { overviewFiles: [{ richText: headings.map((h) => `<h2>${h}</h2><a id="user-content-${h}" href="#${h}"></a>`).join("") }] },
      },
    },
  });

test("issueRefPath goes from a repo's front page to the issue", () => {
  const doc = fakeDoc("whatwg/spec-factory");
  assert.equal(issueRefPath("/whatwg/spec-factory", "#91", doc), "/whatwg/spec-factory/issues/91");
  assert.equal(issueRefPath("/whatwg/spec-factory/", "#91", doc), "/whatwg/spec-factory/issues/91");
  assert.equal(issueRefPath("/WHATWG/Spec-Factory", "#91", doc), "/WHATWG/Spec-Factory/issues/91");
});

test("issueRefPath ignores punctuation copied after the reference", () => {
  const doc = fakeDoc("whatwg/html");
  for (const hash of ["#91,", "#91.", "#91)", "#91).", "#91:", "#91;", "#91!", "#91?", "#91]", "#91%22", "#91%3E", "#91%E2%80%A6", "#91%E2%80%9D", "#91*", "#91%60"]) {
    assert.equal(issueRefPath("/whatwg/html", hash, doc), "/whatwg/html/issues/91", hash);
  }
});

test("issueRefPath ignores other hashes and pages", () => {
  const doc = fakeDoc("whatwg/html");
  for (const hash of ["", "#", "#0", "#091", "#tests", "#91a", "#91,a", "#9 1", "#1234567890", "#-1", "#91.........", "#%ZZ", "#,91"]) {
    assert.equal(issueRefPath("/whatwg/html", hash, doc), null, hash);
  }
  for (const path of ["/whatwg/html/pulls", "/whatwg", "/", "/whatwg/html/issues/1", "//evil.example/x"]) {
    assert.equal(issueRefPath(path, "#91", doc), null, path);
  }
});

test("issueRefPath needs GitHub's repository marker for the same repo", () => {
  assert.equal(issueRefPath("/orgs/whatwg", "#91", fakeDoc(null)), null);
  assert.equal(issueRefPath("/whatwg/html", "#91", fakeDoc(null)), null);
  assert.equal(issueRefPath("/whatwg/html", "#91", fakeDoc("whatwg/dom")), null);
});

test("issueRefPath leaves README heading anchors alone", () => {
  assert.equal(issueRefPath("/whatwg/html", "#2024", fakeDoc("whatwg/html", { ids: ["user-content-2024"] })), null);
  assert.equal(issueRefPath("/whatwg/html", "#2024", fakeDoc("whatwg/html", { ids: ["2024"] })), null);
  assert.equal(issueRefPath("/whatwg/html", "#2024", fakeDoc("whatwg/html", { data: pageData("2024") })), null);
  // With punctuation it can't be a heading anchor.
  assert.equal(issueRefPath("/whatwg/html", "#2024,", fakeDoc("whatwg/html", { ids: ["user-content-2024"] })), "/whatwg/html/issues/2024");
});

test("parseIssueRef says whether the hash could be a heading", () => {
  assert.deepEqual(parseIssueRef("/whatwg/html", "#91"), { owner: "whatwg", repo: "html", number: "91", exact: true });
  assert.deepEqual(parseIssueRef("/whatwg/html", "#91,"), { owner: "whatwg", repo: "html", number: "91", exact: false });
});

test("issueRefVerdict decides as soon as the page parsed so far allows", () => {
  const exact = parseIssueRef("/whatwg/html", "#91");
  const punct = parseIssueRef("/whatwg/html", "#91.");
  // Still in <head>, before the repository marker.
  assert.equal(issueRefVerdict(punct, fakeDoc(null, { body: false }), false), undefined);
  // <head> is done without it.
  assert.equal(issueRefVerdict(punct, fakeDoc(null), false), null);
  // With punctuation, the marker is enough.
  assert.equal(issueRefVerdict(punct, fakeDoc("whatwg/html", { body: false }), false), "/whatwg/html/issues/91");
  // Digits only: wait for the page data.
  assert.equal(issueRefVerdict(exact, fakeDoc("whatwg/html", { body: false }), false), undefined);
  assert.equal(issueRefVerdict(exact, fakeDoc("whatwg/html", { data: pageData("91"), done: false }), false), undefined);
  assert.equal(issueRefVerdict(exact, fakeDoc("whatwg/html", { data: pageData("tests") }), false), "/whatwg/html/issues/91");
  assert.equal(issueRefVerdict(exact, fakeDoc("whatwg/html", { data: pageData("tests", "91") }), false), null);
  assert.equal(issueRefVerdict(exact, fakeDoc("whatwg/html", { data: pageData("910") }), false), "/whatwg/html/issues/91");
  // Page data without overview files, or broken: wait for the whole page.
  assert.equal(issueRefVerdict(exact, fakeDoc("whatwg/html", { data: "{}" }), false), undefined);
  assert.equal(issueRefVerdict(exact, fakeDoc("whatwg/html", { data: "{" }), false), undefined);
  assert.equal(issueRefVerdict(exact, fakeDoc("whatwg/html", { data: "{" }), true), "/whatwg/html/issues/91");
});
