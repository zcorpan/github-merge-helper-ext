import { test } from "node:test";
import assert from "node:assert/strict";
import { fixedUrl } from "../src/issueref.js";

const fix = (path, hash = "", search = "") => fixedUrl(path, search, hash);

test("an issue reference on a repo's front page goes to the issue", () => {
  assert.equal(fix("/whatwg/spec-factory", "#91"), "/whatwg/spec-factory/issues/91");
  assert.equal(fix("/whatwg/spec-factory/", "#91"), "/whatwg/spec-factory/issues/91");
  assert.equal(fix("/WHATWG/Spec-Factory", "#91"), "/WHATWG/Spec-Factory/issues/91");
  assert.equal(fix("/whatwg/html", "#91", "?tab=readme"), "/whatwg/html/issues/91");
});

test("punctuation copied after an issue reference is ignored", () => {
  for (const hash of ["#91,", "#91.", "#91)", "#91).", "#91:", "#91;", "#91!", "#91?", "#91]", "#91%22", "#91%3E", "#91%E2%80%A6", "#91%E2%80%9D", "#91*", "#91_", "#91%60"]) {
    assert.equal(fix("/whatwg/html", hash), "/whatwg/html/issues/91", hash);
  }
  assert.equal(fix("/whatwg/html.", "#91,"), "/whatwg/html/issues/91");
});

test("punctuation copied after a repo or issue URL is dropped", () => {
  assert.equal(fix("/whatwg/html."), "/whatwg/html");
  assert.equal(fix("/whatwg/html),"), "/whatwg/html");
  assert.equal(fix("/whatwg/html%E2%80%9D."), "/whatwg/html");
  assert.equal(fix("/whatwg/html.", "#readme", "?tab=x"), "/whatwg/html?tab=x#readme");
  assert.equal(fix("/whatwg/html/pull/123."), "/whatwg/html/pull/123");
  assert.equal(fix("/whatwg/html/issues/123),", "#issuecomment-1"), "/whatwg/html/issues/123#issuecomment-1");
  // Where GitHub redirects those to.
  assert.equal(fix("/whatwg/html/pull/new/123."), "/whatwg/html/pull/123");
  assert.equal(fix("/whatwg/html/compare/123).", "", "?expand=1"), "/whatwg/html/pull/123");
  assert.equal(fix("/whatwg/html/issues/created_by/123,"), "/whatwg/html/issues/123");
  assert.equal(fix("/whatwg/html/compare/main...feature"), null);
  assert.equal(fix("/whatwg/html/compare/123"), null);
  assert.equal(fix("/whatwg/html/issues/created_by/zcorpan"), null);
});

test("real repository names and other pages are left alone", () => {
  for (const path of ["/whatwg/html", "/whatwg/html/", "/whatwg/foo.js", "/whatwg/.github", "/whatwg/html_", "/whatwg/html-", "/whatwg/html/pull/123", "/whatwg/html/pulls."]) {
    assert.equal(fix(path), null, path);
  }
  for (const hash of ["", "#", "#0", "#091", "#tests", "#91a", "#91,a", "#9 1", "#1234567890", "#-1", "#91.........", "#,91"]) {
    assert.equal(fix("/whatwg/html", hash), null, hash);
  }
  for (const path of ["/whatwg/html/pulls", "/whatwg", "/", "/whatwg/html/issues/1", "//evil.example/x", "/whatwg/html/blob/main/x."]) {
    assert.equal(fix(path, "#91"), null, path);
  }
  assert.equal(fix("/whatwg/html", "#%ZZ"), null);
  assert.equal(fix("/whatwg/%ZZ."), null);
});

test("GitHub's own top-level pages aren't repositories", () => {
  for (const path of ["/orgs/whatwg", "/settings/profile", "/users/zcorpan", "/Marketplace/actions", "/sponsors/zcorpan"]) {
    assert.equal(fix(path, "#91"), null, path);
    assert.equal(fix(`${path}.`), null, path);
  }
  assert.equal(fix("/orgs/whatwg/issues/1."), null);
});
