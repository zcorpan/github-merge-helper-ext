// Fixes up GitHub URLs pasted from text (see issueref.js). Runs at
// document_start and only needs the URL, so it redirects before the page
// loads. replace() keeps the URL being fixed out of history, so going back
// doesn't loop.

import { fixedUrl } from "./issueref.js";

// GitHub's page background for the theme in its <html> attributes (present at
// document_start), following the OS when the mode is "auto". From
// --bgColor-default in GitHub's theme CSS.
function theme(root) {
  const { colorMode, darkTheme } = root.dataset;
  const dark =
    colorMode === "dark" ||
    (colorMode !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  if (!dark) return { scheme: "light", bg: "#fff" };
  const name = darkTheme ?? "";
  const bg = name.startsWith("dark_dimmed")
    ? "#212830"
    : name.endsWith("_high_contrast")
      ? "#010409"
      : "#0d1117";
  return { scheme: "dark", bg };
}

function redirect() {
  const url = fixedUrl(location.pathname, location.search, location.hash);
  if (!url) return;
  // Firefox ignores a navigation started this early unless the current load is
  // stopped first; stopping it also saves loading the page.
  window.stop();
  // The stopped page stays up until the new one arrives; paint it like
  // GitHub's pages so it doesn't flash.
  const root =
    document.documentElement ??
    document.appendChild(document.createElement("html"));
  const { scheme, bg } = theme(root);
  root.style.colorScheme = scheme;
  root.style.backgroundColor = bg;
  location.replace(url);
}

redirect();
// Typing the reference into an open repository page.
window.addEventListener("hashchange", redirect);
