import { test } from "node:test";
import assert from "node:assert/strict";
import { issueRefPath } from "../src/issueref.js";

function fakeDoc(nwo, ids = []) {
  return {
    querySelector: (selector) =>
      nwo && selector === 'meta[name="octolytics-dimension-repository_nwo"]' ? { content: nwo } : null,
    getElementById: (id) => (ids.includes(id) ? {} : null),
  };
}

test("issueRefPath goes from a repo's front page to the issue", () => {
  const doc = fakeDoc("whatwg/spec-factory");
  assert.equal(issueRefPath("/whatwg/spec-factory", "#91", doc), "/whatwg/spec-factory/issues/91");
  assert.equal(issueRefPath("/whatwg/spec-factory/", "#91", doc), "/whatwg/spec-factory/issues/91");
  assert.equal(issueRefPath("/WHATWG/Spec-Factory", "#91", doc), "/WHATWG/Spec-Factory/issues/91");
});

test("issueRefPath ignores other hashes and pages", () => {
  const doc = fakeDoc("whatwg/html");
  for (const hash of ["", "#", "#0", "#091", "#tests", "#91a", "#1234567890", "#-1"]) {
    assert.equal(issueRefPath("/whatwg/html", hash, doc), null, hash);
  }
  for (const path of ["/whatwg/html/pulls", "/whatwg", "/", "/whatwg/html/issues/1", "//evil.example/x"]) {
    assert.equal(issueRefPath(path, "#91", doc), null, path);
  }
});

test("issueRefPath needs GitHub's repository marker for the same repo", () => {
  assert.equal(issueRefPath("/orgs/whatwg", "#91", fakeDoc(null)), null);
  assert.equal(issueRefPath("/whatwg/html", "#91", fakeDoc("whatwg/dom")), null);
});

test("issueRefPath leaves README heading anchors alone", () => {
  assert.equal(issueRefPath("/whatwg/html", "#2024", fakeDoc("whatwg/html", ["user-content-2024"])), null);
  assert.equal(issueRefPath("/whatwg/html", "#2024", fakeDoc("whatwg/html", ["2024"])), null);
});
