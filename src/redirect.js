// Fixes up GitHub URLs pasted from text (see issueref.js). Runs at
// document_start and only needs the URL, so it redirects before the page
// loads. replace() keeps the URL being fixed out of history, so going back
// doesn't loop.

import { fixedUrl } from "./issueref.js";

// GitHub's background and color scheme as last seen with the OS in light or
// dark mode (GitHub's theme can follow it). Kept in the page's localStorage
// so it can be read synchronously while redirecting. The page can write it
// too, so it's only ever assigned to these two CSS properties.
const THEME_KEY = "gmh-theme-";

function osMode() {
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function saveTheme() {
  const root = document.documentElement;
  const body = document.body;
  if (!root || !body) return;
  const transparent = "rgba(0, 0, 0, 0)";
  let bg = getComputedStyle(root).backgroundColor;
  if (bg === transparent) bg = getComputedStyle(body).backgroundColor;
  if (bg === transparent) return;
  const value = JSON.stringify({ bg, scheme: getComputedStyle(root).colorScheme });
  try {
    const key = THEME_KEY + osMode();
    if (localStorage.getItem(key) !== value) localStorage.setItem(key, value);
  } catch {}
}

function savedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY + osMode());
    if (!value || value.length > 200) return null;
    const { bg, scheme } = JSON.parse(value);
    return typeof bg === "string" && typeof scheme === "string" ? { bg, scheme } : null;
  } catch {
    return null;
  }
}

function redirect() {
  const url = fixedUrl(location.pathname, location.search, location.hash);
  if (!url) return;
  // Firefox ignores a navigation started this early unless the current load is
  // stopped first; stopping it also saves loading the page.
  window.stop();
  // The stopped page stays up until the new one arrives; paint it like
  // GitHub's pages so it doesn't flash. Invalid values are ignored.
  const root =
    document.documentElement ??
    document.appendChild(document.createElement("html"));
  const theme = savedTheme();
  root.style.colorScheme = theme?.scheme ?? "light dark";
  if (theme) root.style.backgroundColor = theme.bg;
  location.replace(url);
}

redirect();
// Typing the reference into an open repository page.
window.addEventListener("hashchange", redirect);
window.addEventListener("load", saveTheme);
