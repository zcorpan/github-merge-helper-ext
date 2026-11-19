// Fixes up GitHub URLs pasted from text (see issueref.js). Runs at
// document_start and only needs the URL, so it redirects before the page
// loads. replace() keeps the URL being fixed out of history, so going back
// doesn't loop.

import { fixedUrl } from "./issueref.js";

function redirect() {
  const url = fixedUrl(location.pathname, location.search, location.hash);
  if (!url) return;
  // Firefox ignores a navigation started this early unless the current load is
  // stopped first; stopping it also saves loading the page.
  window.stop();
  location.replace(url);
}

redirect();
// Typing the reference into an open repository page.
window.addEventListener("hashchange", redirect);
