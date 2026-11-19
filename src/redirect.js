// github.com/owner/repo#91 goes to the issue or PR. Runs at document_start, so
// it redirects while the repository page is still loading: right after <head>
// for "#91," and the like, and once GitHub's page data is in for "#91" (which
// could be a README heading). Meanwhile redirect.css hides the page, so it
// isn't laid out or painted. replace() keeps the redirecting URL out of
// history, so going back doesn't loop.

import { issueRefPath, issueRefVerdict, parseIssueRef } from "./issueref.js";

const HIDE = "gmhRedirect";

const ref = parseIssueRef(location.pathname, location.hash);
if (ref && document.documentElement) {
  const root = document.documentElement;
  let decided = false;
  let observer = null;
  const settle = (complete) => {
    if (decided) return;
    let verdict;
    try {
      verdict = issueRefVerdict(ref, document, complete);
    } catch {
      verdict = null;
    }
    if (verdict === undefined) return;
    decided = true;
    observer?.disconnect();
    if (verdict) location.replace(verdict);
    else delete root.dataset[HIDE];
  };
  root.dataset[HIDE] = "";
  settle(document.readyState !== "loading");
  if (!decided) {
    observer = new MutationObserver(() => settle(false));
    observer.observe(document, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", () => settle(true), { once: true });
  }
}

// Typing the reference into an open repository page.
window.addEventListener("hashchange", () => {
  const path = issueRefPath(location.pathname, location.hash, document);
  if (path) location.replace(path);
});
