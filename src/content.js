// Adds a button next to GitHub's merge button that asks Claude to review or
// write the commit message. Nothing happens until the button is clicked.
//
// Security: the model's answer is untrusted (PR text can contain prompt
// injection). It is only ever inserted as text (never as HTML), only put into
// GitHub's commit form fields (never submitted; you confirm the merge), and
// checked by safety.js for closing keywords, unexpected references, and
// invisible characters. Clicks synthesized by page scripts are ignored.

import { checkMessage, cleanTrailer, issueLinks, stripInvisible, validPullRef } from "./safety.js";

const MERGE_LABEL =
  /^(?:Merge pull request|Squash and merge|Rebase and merge|Enable auto-merge(?: \(\w+\))?|Confirm (?:merge|squash and merge|rebase and merge|auto-merge(?: \(\w+\))?))$/i;
const MERGEBOX_TEXT =
  /This branch has no conflicts with the base branch|Merging is blocked|This branch has conflicts that must be resolved|can be automatically merged|Merging can be performed automatically/;
const NO_WRITE_ACCESS_TEXT = /Only those with write access to this repository can merge/;
const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;
// Where GitHub renders user-written content; never treat buttons or fields in
// there as part of the merge box.
const USER_CONTENT = ".markdown-body, .comment-body, .js-comment-body, .comment-form-textarea, [data-testid='markdown-body']";

let state = null;
let warnTimer = null;

// Each run of this script tags the elements it creates. After an update,
// Firefox injects the new version into open tabs while the old version's
// elements stay in the page with handlers that no longer run.
const INSTANCE = crypto.randomUUID();
const OUR_ELEMENTS = ".gmh-button, .gmh-panel";

// Deals with a previous version's leftovers: a lone button is removed (ours
// replaces it); a panel is kept, with its buttons disabled and a note to
// reload. Returns true while such a panel is on the page, so this version
// stays out of the way until then.
function handleStale() {
  const stale = [...document.querySelectorAll(OUR_ELEMENTS)].filter(
    (el) => el.dataset.gmhInstance !== INSTANCE && !el.closest(USER_CONTENT),
  );
  const panels = stale.filter((el) => el.classList.contains("gmh-panel"));
  if (!panels.length) {
    for (const el of stale) el.remove();
    return false;
  }
  for (const el of stale) {
    for (const button of el.matches("button") ? [el] : el.querySelectorAll("button")) button.disabled = true;
  }
  for (const panel of panels) {
    if (!panel.querySelector(".gmh-update-note")) {
      panel.prepend(h("p", { className: "gmh-update-note", role: "status" }, "GitHub Merge Helper was updated. Reload the page to use the new version."));
    }
  }
  return true;
}

function freshState(path, [, owner, repo, number]) {
  return { path, owner, repo, number: Number(number), result: null, loading: false, filled: null, button: null, panel: null,
    pageCommitCount: null, warned: false, noWriteAccess: false, lastScan: 0 };
}

function check() {
  const match = location.pathname.match(PR_PATH);
  if (state?.path !== location.pathname) {
    // Navigated away: drop our elements, and any a previous version left.
    if (state) for (const el of document.querySelectorAll(OUR_ELEMENTS)) el.remove();
    clearTimeout(warnTimer);
    warnTimer = null;
    state = match && validPullRef(match[1], match[2], Number(match[3])) ? freshState(location.pathname, match) : null;
  }
  if (!state || handleStale()) return;

  const merge = findMergeButton();
  if (!merge || isDisabled(merge)) {
    state.button?.remove();
    if (!merge) maybeWarn();
    return;
  }
  clearTimeout(warnTimer);
  warnTimer = null;

  const button = (state.button ??= createButton());
  const group = buttonGroup(merge);
  if (button.previousElementSibling !== group) group.after(button);
  setText(button, state.loading ? "Asking Claude…" : buttonLabel(merge));
  button.disabled = state.loading;

  if (state.panel && !state.panel.isConnected) placePanel(merge, state.panel);
  if (state.panel) updatePanelControls();
}

// Exactly one visible merge button outside user content, or null.
function findMergeButton() {
  const found = [...document.querySelectorAll("button")].filter(
    (b) =>
      !b.classList.contains("gmh-button") &&
      !b.closest(`.gmh-panel, ${USER_CONTENT}`) &&
      MERGE_LABEL.test(normalized(b.textContent)) &&
      b.getClientRects().length,
  );
  if (found.length > 1 && !state.warnedAmbiguous) {
    state.warnedAmbiguous = true;
    console.warn("[GitHub Merge Helper] Found more than one merge button; not adding anything.");
  }
  return found.length === 1 ? found[0] : null;
}

function isDisabled(button) {
  return button.disabled || button.getAttribute("aria-disabled") === "true";
}

// The merge button usually sits in a split-button group (or next to Cancel when
// confirming); put our button after the whole group.
function buttonGroup(merge) {
  // GitHub's Primer split button: the merge button and the method menu are
  // separate items in one ButtonGroup.
  const group = merge.closest('[data-component="ButtonGroup"]');
  if (group) return group;
  const parent = merge.parentElement;
  const siblings = parent ? [...parent.children].filter((c) => c !== merge && !c.classList.contains("gmh-button")) : [];
  if (parent && siblings.length <= 2 && siblings.some((c) => c.matches("button") || c.querySelector("button"))) return parent;
  return merge;
}

function mergeMethod(merge) {
  const text = normalized(merge.textContent).toLowerCase();
  if (text.includes("squash")) return "squash";
  if (text.includes("rebase")) return "rebase";
  return "merge";
}

function isConfirming(merge) {
  return /^confirm /i.test(normalized(merge.textContent));
}

// Title input and description textarea of the open commit editor, if any:
// the closest ancestor of the confirm button with exactly one visible text
// input and one visible textarea, none of them in user content or a comment form.
function commitFields(merge) {
  if (!isConfirming(merge)) return null;
  const usable = (el) => el.getClientRects().length && !el.closest(`.gmh-panel, ${USER_CONTENT}`);
  const classicTitle = document.getElementById("merge_title_field");
  const classicBody = document.getElementById("merge_message_field");
  if (classicTitle && classicBody && usable(classicTitle) && usable(classicBody)) return { title: classicTitle, body: classicBody };
  let el = merge.parentElement;
  for (let i = 0; i < 6 && el && el !== document.body; i++, el = el.parentElement) {
    const titles = [...el.querySelectorAll('input[type="text"], input:not([type])')].filter(usable);
    const bodies = [...el.querySelectorAll("textarea")].filter(usable);
    if (titles.length + bodies.length === 0) continue;
    if (titles.length !== 1 || bodies.length !== 1) return null;
    if (el.querySelector("#new_comment_field, form.js-new-comment-form")) return null;
    return { title: titles[0], body: bodies[0] };
  }
  return null;
}

function pageCommitCount() {
  if (state.pageCommitCount == null) {
    const m = document.body.textContent.match(/wants to merge\s+(\d+)\s+commits?/);
    if (m) state.pageCommitCount = Number(m[1]);
  }
  return state.pageCommitCount;
}

function buttonLabel(merge) {
  if (state.result && canFill(merge) && !state.filled && !currentChecks()?.warnings) return "Fill in commit message";
  const count = state.result?.commitCount ?? pageCommitCount();
  if (count === 1) return "Review commit message";
  if (count > 1) return "Write squash commit message";
  return "Write commit message";
}

function canFill(merge) {
  return mergeMethod(merge) === "squash" && commitFields(merge) !== null;
}

function maybeWarn() {
  // GitHub keeps mutating the page (relative timestamps etc.), so don't scan
  // the page text more than every few seconds.
  if (state.warned || state.noWriteAccess || warnTimer || Date.now() - state.lastScan < 3000) return;
  state.lastScan = Date.now();
  const text = document.body.textContent;
  if (NO_WRITE_ACCESS_TEXT.test(text)) state.noWriteAccess = true;
  if (!MERGEBOX_TEXT.test(text) || state.noWriteAccess) return;
  // The merge box renders asynchronously; only warn if the button stays missing.
  warnTimer = setTimeout(() => {
    warnTimer = null;
    if (!state || state.warned || findMergeButton()) return;
    const text = document.body.textContent;
    if (MERGEBOX_TEXT.test(text) && !NO_WRITE_ACCESS_TEXT.test(text)) {
      state.warned = true;
      console.warn("[GitHub Merge Helper] Found the merge box but not the merge button; GitHub's markup may have changed.");
    }
  }, 3000);
}

function createButton() {
  const button = h("button", { type: "button", className: "gmh-button" });
  button.dataset.gmhInstance = INSTANCE;
  onClick(button, onButtonClick);
  return button;
}

async function onButtonClick() {
  const merge = findMergeButton();
  if (!merge) return;
  // With the suggestion already showing, the button only fills it in, keeping
  // any edits made in the panel. Otherwise ask the background, which reuses its
  // cached answer while the PR head is unchanged.
  if (state.result && state.panel?.gmh) {
    if (canFill(merge) && !currentChecks()?.warnings) fill(merge);
    state.panel.scrollIntoView({ block: "nearest" });
    return;
  }
  await request(merge, false);
}

async function request(merge, force) {
  const s = state;
  if (s.loading) return;
  s.loading = true;
  check();
  let response;
  try {
    response = await browser.runtime.sendMessage({ type: "suggest", owner: s.owner, repo: s.repo, number: s.number, force });
  } catch (e) {
    response = { error: e?.message ?? String(e) };
  }
  s.loading = false;
  if (state !== s) return;
  merge = findMergeButton() ?? merge;
  if (response.error) {
    showError(merge, response);
  } else {
    s.result = response;
    showResult(merge);
    if (canFill(merge) && !currentChecks()?.warnings) fill(merge);
  }
  check();
}

// Below the merge box, as its sibling. Falls back to walking up out of
// flex/grid rows so the panel gets its own full-width block.
function placePanel(merge, panel) {
  const box = merge.closest('[data-testid="mergebox-border-container"]');
  if (box) {
    box.after(panel);
    return;
  }
  let el = buttonGroup(merge);
  for (let i = 0; i < 10 && el.parentElement && el.parentElement !== document.body; i++) {
    const display = getComputedStyle(el.parentElement).display;
    if (!/flex|grid|inline/.test(display)) break;
    el = el.parentElement;
  }
  el.after(panel);
}

function replacePanel(merge, panel) {
  panel.dataset.gmhInstance = INSTANCE;
  state.panel?.remove();
  state.panel = panel;
  placePanel(merge, panel);
}

function showError(merge, { error, needsSettings }) {
  const children = [h("p", { className: "gmh-error" }, error)];
  if (needsSettings) {
    const link = h("button", { type: "button", className: "gmh-link" }, "Open settings");
    onClick(link, () => browser.runtime.sendMessage({ type: "openOptions" }));
    children.push(link);
  }
  replacePanel(merge, h("div", { className: "gmh-panel" }, closeButton(), ...children));
}

function showResult(merge) {
  const { suggestion, mode, diffTruncated, model, trailers } = state.result;
  const heading =
    mode === "generate"
      ? "Suggested squash commit message"
      : suggestion.verdict === "ok"
        ? "Commit message looks good"
        : "Commit message needs changes";

  const title = h("input", { type: "text", className: "gmh-title", value: suggestion.title, spellcheck: true });
  const counter = h("span", { className: "gmh-counter" });
  const body = h("textarea", { className: "gmh-body", rows: 6, spellcheck: true });
  body.value = suggestion.body;
  const checks = h("div", { className: "gmh-checks" });
  const onEdit = () => {
    // Grow the description to fit (CSS caps the height).
    body.style.height = "auto";
    body.style.height = `${body.scrollHeight + 2}px`;
    setText(counter, `${title.value.length}/72`);
    counter.classList.toggle("gmh-over", title.value.length > 72);
    renderChecks(checks);
    check();
  };
  title.addEventListener("input", onEdit);
  body.addEventListener("input", onEdit);

  const fillButton = h("button", { type: "button", className: "gmh-action gmh-fill" }, "Fill in");
  onClick(fillButton, () => fill(findMergeButton()));
  const undoButton = h("button", { type: "button", className: "gmh-action gmh-undo" }, "Undo");
  onClick(undoButton, undo);
  const copyButton = h("button", { type: "button", className: "gmh-action" }, "Copy");
  onClick(copyButton, async () => {
    const message = finalMessage(title.value, body.value, trailers);
    await navigator.clipboard.writeText([message.title, message.body].filter(Boolean).join("\n\n"));
    setText(copyButton, "Copied");
    setTimeout(() => setText(copyButton, "Copy"), 1500);
  });
  const regenerateButton = h("button", { type: "button", className: "gmh-action" }, "Regenerate");
  onClick(regenerateButton, () => request(findMergeButton(), true));

  const panel = h(
    "div",
    { className: "gmh-panel" },
    closeButton(),
    h("h3", { className: `gmh-heading gmh-${suggestion.verdict}` }, heading),
    suggestion.issues.length ? h("ul", { className: "gmh-issues" }, ...suggestion.issues.map((i) => h("li", {}, ...linkified(i)))) : null,
    suggestion.notes ? h("p", { className: "gmh-notes" }, ...linkified(suggestion.notes)) : null,
    diffTruncated ? h("p", { className: "gmh-notes" }, "The diff was too large and was truncated before sending.") : null,
    h("label", { className: "gmh-label" }, "Title ", counter),
    title,
    h("label", { className: "gmh-label" }, "Description"),
    body,
    trailers.length ? h("p", { className: "gmh-trailers" }, `Added on fill/copy: ${uniqueTrailers(trailers).join(", ")}`) : null,
    checks,
    h("p", { className: "gmh-hint" }),
    h("div", { className: "gmh-actions" }, fillButton, copyButton, regenerateButton, undoButton),
    h("p", { className: "gmh-model" }, `${model}. Claude's answer can be influenced by text in the PR; read it before merging.`),
  );
  panel.gmh = { title, body, fillButton, undoButton };
  replacePanel(merge, panel);
  onEdit();
}

// Problems found by safety.js (not by the model) in the panel's current text.
function currentChecks() {
  const controls = state.panel?.gmh;
  if (!controls || !state.result) return null;
  const { title, body } = controls;
  const result = checkMessage({ title: title.value, body: body.value }, state.result.knownRefs, state.owner, state.repo);
  const invisible = stripInvisible(title.value).removed + stripInvisible(body.value).removed;
  result.removed = state.result.removedChars + invisible;
  result.warnings = result.unknown.length > 0 || result.removed > 0;
  return result;
}

function renderChecks(container) {
  const result = currentChecks();
  if (!result) return;
  const items = [
    h("li", {}, ...linkified(result.closes.length ? `Merging closes ${result.closes.join(", ")}.` : "Merging closes no issues.")),
  ];
  if (result.unknown.length) {
    const text = `Not in the PR title, description, or commits: ${result.unknown.join(", ")}. Check these are legitimate.`;
    items.push(h("li", { className: "gmh-warning" }, ...linkified(text)));
  }
  if (result.removed) {
    items.push(h("li", { className: "gmh-warning" }, `${result.removed} invisible or control character(s) were or will be removed.`));
  }
  container.replaceChildren(h("p", { className: "gmh-checks-heading" }, "Checked by the extension, not by Claude:"), h("ul", {}, ...items));
}

function updatePanelControls() {
  const controls = state.panel?.gmh;
  if (!controls) return;
  const merge = findMergeButton();
  const fillable = merge ? canFill(merge) : false;
  controls.fillButton.disabled = !fillable;
  controls.undoButton.hidden = !state.filled;
  const hint = state.panel.querySelector(".gmh-hint");
  const { mode, suggestion } = state.result;
  let text = "";
  if (fillable && !state.filled && currentChecks()?.warnings) {
    text = "Not filled in automatically because of the warnings above. Review, then click “Fill in”.";
  } else if (!fillable && merge) {
    const method = mergeMethod(merge);
    if (method !== "squash" && mode === "generate") {
      text = "This PR has several commits. Choose “Squash and merge” to use this message.";
    } else if (method !== "squash" && suggestion.verdict === "needs_changes") {
      text = "Choose “Squash and merge” to use the fixed message, or amend the commit.";
    } else if (method === "squash") {
      text = "Click “Squash and merge”, then “Fill in”.";
    }
  }
  setText(hint, text);
  hint.hidden = !text;
}

// Only puts text in GitHub's form; never submits it.
function fill(merge) {
  const fields = merge && commitFields(merge);
  const controls = state.panel?.gmh;
  if (!fields || !controls) return;
  const original = { title: fields.title.value, body: fields.body.value };
  const existing = original.body.split("\n").filter((l) => /^co-authored-by:/i.test(l.trim()));
  const message = finalMessage(controls.title.value, controls.body.value, [...existing, ...state.result.trailers]);
  setNativeValue(fields.title, message.title);
  setNativeValue(fields.body, message.body);
  state.filled ??= original;
  check();
}

function undo() {
  const fields = commitFields(findMergeButton());
  if (!fields || !state.filled) return;
  setNativeValue(fields.title, state.filled.title);
  setNativeValue(fields.body, state.filled.body);
  state.filled = null;
  check();
}

// Well-formed trailers only, deduped by email.
function uniqueTrailers(trailers) {
  const seen = new Set();
  const unique = [];
  for (const t of trailers) {
    const line = cleanTrailer(t);
    if (!line) continue;
    const key = line.match(/<([^>]+)>$/)[1].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(line);
  }
  return unique;
}

// Title and body as they will be filled in, with invisible characters stripped.
function finalMessage(title, body, trailers) {
  return {
    title: stripInvisible(title).text.replace(/\n/g, " ").trim(),
    body: [stripInvisible(body).text.trim(), uniqueTrailers(trailers).join("\n")].filter(Boolean).join("\n\n"),
  };
}

// React tracks input values; use the native setter so it notices the change.
function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function closeButton() {
  const button = h("button", { type: "button", className: "gmh-close", title: "Close" }, "×");
  onClick(button, () => {
    state.panel?.remove();
    state.panel = null;
  });
  return button;
}

// Ignore clicks synthesized by page scripts, so the page can't spend your API
// credit or fill in the form.
function onClick(el, handler) {
  el.addEventListener("click", (event) => {
    if (event.isTrusted) handler(event);
  });
}

// Text with issue references turned into links to github.com. The hrefs come
// from issueLinks(), which builds them from validated owner/repo/number only.
function linkified(text) {
  const nodes = [];
  let pos = 0;
  for (const { start, end, href } of issueLinks(text, state.owner, state.repo)) {
    nodes.push(text.slice(pos, start), h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text.slice(start, end)));
    pos = end;
  }
  nodes.push(text.slice(pos));
  return nodes;
}

// Children are appended as text nodes; nothing here parses HTML.
function h(tag, props, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child != null) el.append(child);
  return el;
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function normalized(text) {
  return text.replace(/\s+/g, " ").trim();
}

let scheduled = false;
new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    check();
  }, 250);
}).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "aria-disabled"] });
check();
