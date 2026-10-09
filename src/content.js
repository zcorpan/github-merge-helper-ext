// Adds a button next to GitHub's merge button that asks Claude to review or
// write the commit message. Nothing happens until the button is clicked.
//
// Security: the model's answer is untrusted (PR text can contain prompt
// injection). It is only ever inserted as text (never as HTML), only put into
// GitHub's commit form fields (never submitted; you confirm the merge), and
// checked by safety.js for closing keywords, unexpected references, and
// invisible characters. Clicks synthesized by page scripts are ignored.

import { checkMessage, cleanTrailer, issueLinks, stripInvisible, titleLimit, validPullRef } from "./safety.js";

const MERGE_LABEL =
  /^(?:Merge pull request|Squash and merge|Rebase and merge|Enable auto-merge(?: \(\w+\))?|Confirm (?:merge|squash and merge|rebase and merge|auto-merge(?: \(\w+\))?))$/i;
const MERGEBOX_TEXT =
  /This branch has no conflicts with the base branch|Merging is blocked|This branch has conflicts that must be resolved|can be automatically merged|Merging can be performed automatically/;
const NO_WRITE_ACCESS_TEXT = /Only those with write access to this repository can merge/;
// Any tab of a PR; the merge box is only on the Conversation tab (no 4th part).
const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(\/[^/]+.*)?\/?$/;
// Where GitHub renders user-written content; never treat buttons or fields in
// there as part of the merge box.
const USER_CONTENT = ".markdown-body, .comment-body, .js-comment-body, .comment-form-textarea, [data-testid='markdown-body']";

let state = null;
let warnTimer = null;

// Each run of this script tags the elements it creates. After an update,
// Firefox injects the new version into open tabs while the old version's
// elements stay in the page with handlers that no longer run.
const INSTANCE = crypto.randomUUID();
const OUR_ELEMENTS = ".gmh-button, .gmh-restore, .gmh-panel";

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

// State is per PR (not per tab of it), so the panel survives switching to
// "Files changed" and back.
function freshState(key, owner, repo, number) {
  return { key, owner, repo, number, result: null, loading: false, filled: null, button: null, panel: null,
    pageCommitCount: null, warned: false, noWriteAccess: false, lastScan: 0,
    cleanup: null, restoreButton: null, mergeSeen: false, goneTimer: null };
}

function check() {
  const match = location.pathname.match(PR_PATH);
  const pr = match && validPullRef(match[1], match[2], Number(match[3])) ? { owner: match[1], repo: match[2], number: Number(match[3]) } : null;
  const key = pr && `${pr.owner}/${pr.repo}#${pr.number}`;
  if (state?.key !== key) {
    // Another PR, or not a PR: drop our elements, and any a previous version left.
    if (state) for (const el of document.querySelectorAll(OUR_ELEMENTS)) el.remove();
    clearTimeout(warnTimer);
    warnTimer = null;
    state = pr ? freshState(key, pr.owner, pr.repo, pr.number) : null;
    if (state) restore(state);
  }
  if (!state || match[4] || handleStale()) return;

  // The button is there whenever the merge button is, even while GitHub has it
  // disabled (e.g. while checking mergeability).
  const merge = findMergeButton();
  if (merge) {
    clearTimeout(warnTimer);
    warnTimer = null;
    state.mergeSeen = true;
    clearTimeout(state.goneTimer);
    state.goneTimer = null;
    const button = (state.button ??= createButton());
    const group = buttonGroup(merge);
    if (button.previousElementSibling !== group) group.after(button);
    setText(button, state.loading ? "Asking Claude…" : buttonLabel(merge));
    button.disabled = state.loading;
    cleanUpSquash(merge);
    const restore = cleanupInEffect(merge) ? (state.restoreButton ??= createRestoreButton()) : null;
    if (restore && restore.previousElementSibling !== button) button.after(restore);
    if (!restore) state.restoreButton?.remove();
  } else {
    state.button?.remove();
    state.restoreButton?.remove();
    maybeWarn();
    // The merge button went away (e.g. the PR was just merged) while a panel
    // is showing: once it has stayed away for a moment, check the PR's state.
    if (state.mergeSeen && state.panel && !state.goneTimer) state.goneTimer = setTimeout(() => checkStillOpen(state), 1500);
  }

  // GitHub re-renders the merge box at times; put the panel back when it does.
  if (state.panel && !state.panel.isConnected) placePanel(merge, state.panel);
  if (state.panel) updatePanelControls();
}

// Removes the panel (and the saved result) if the PR is no longer open. Needs
// the merge button to come back before it checks again.
async function checkStillOpen(s) {
  s.goneTimer = null;
  if (state !== s || findMergeButton()) return;
  s.mergeSeen = false;
  let reply;
  try {
    reply = await browser.runtime.sendMessage({ type: "prState", owner: s.owner, repo: s.repo, number: s.number });
  } catch {
    return;
  }
  if (state !== s || reply?.open !== false) return;
  s.panel?.remove();
  s.panel = null;
  s.result = null;
}

// A saved result for this PR, from an earlier visit or another tab.
async function restore(s) {
  let saved = null;
  try {
    saved = await browser.runtime.sendMessage({ type: "restore", owner: s.owner, repo: s.repo, number: s.number });
  } catch {
    return;
  }
  if (state !== s || !saved || saved.error || s.result || s.loading) return;
  s.result = saved;
  showResult(findMergeButton(), saved.edits);
  check();
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

// Where our controls go: after GitHub's merge controls. With the merge method
// menu, that's the Primer split button's ButtonGroup. In the commit editor,
// the confirm button sits alone in a loading wrapper, in a row with Cancel, so
// it's that row's last control. Our own elements never count, so the anchor
// doesn't change when we insert them next to it.
const OUR_CONTROLS = ".gmh-button, .gmh-restore";

function buttonGroup(merge) {
  const group = merge.closest('[data-component="ButtonGroup"]');
  if (group) return group;
  const item = merge.closest("[data-loading-wrapper]") ?? merge;
  const row = item.parentElement;
  const theirs = row ? [...row.children].filter((c) => !c.matches(OUR_CONTROLS)) : [];
  if (theirs.length > 1 && theirs.length <= 3 && theirs.every((c) => c.matches("button") || c.querySelector("button"))) return theirs.at(-1);
  return item;
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

// Cleans up GitHub's default squash message without Claude, once per commit
// editor: drops the " (#N)" GitHub appends to the title, and uses the first
// commit's description plus deduped Co-authored-by trailers as the body. Only
// touches GitHub's untouched default (title still ends in " (#N)"), and only
// if it wasn't edited while the commits were fetched. Never submits anything.
// The title field is marked once tried, so a newer version injected after an
// update doesn't redo it (e.g. after "Restore GitHub's message").
function cleanUpSquash(merge) {
  if (mergeMethod(merge) !== "squash") return;
  const fields = commitFields(merge);
  if (!fields || fields.title.dataset.gmhCleanup) return;
  const prRef = new RegExp(`\\s*\\(#${state.number}\\)$`);
  if (!prRef.test(fields.title.value)) return;
  fields.title.dataset.gmhCleanup = "tried";
  const s = state;
  const before = { title: fields.title.value, body: fields.body.value };
  browser.runtime
    .sendMessage({ type: "squashDefaults", owner: s.owner, repo: s.repo, number: s.number })
    .then((reply) => {
      if (state !== s || !reply || reply.error || reply.disabled || !fields.title.isConnected) return;
      if (fields.title.value !== before.title || fields.body.value !== before.body) return;
      const existing = before.body.split("\n").filter((line) => /^co-authored-by:/i.test(line.trim()));
      const trailers = uniqueTrailers([...existing, ...reply.trailers]);
      const cleaned = {
        title: before.title.replace(prRef, ""),
        body: [String(reply.description).trim(), trailers.join("\n")].filter(Boolean).join("\n\n"),
      };
      setNativeValue(fields.title, cleaned.title);
      setNativeValue(fields.body, cleaned.body);
      s.cleanup = { fields, original: before, cleaned };
      check();
    })
    .catch(() => {});
}

// Whether the cleaned-up message is still what's in the open commit editor.
function cleanupInEffect(merge) {
  const c = state.cleanup;
  if (!c || !c.fields.title.isConnected) return false;
  const fields = commitFields(merge);
  return fields?.title === c.fields.title && fields.title.value === c.cleaned.title && fields.body.value === c.cleaned.body;
}

function createRestoreButton() {
  const button = h("button", { type: "button", className: "gmh-restore" }, "Restore GitHub’s message");
  button.dataset.gmhInstance = INSTANCE;
  onClick(button, () => {
    const c = state.cleanup;
    if (!c) return;
    setNativeValue(c.fields.title, c.original.title);
    setNativeValue(c.fields.body, c.original.body);
    state.cleanup = null;
    check();
  });
  return button;
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

// Below the merge box, as its sibling, even if the merge button is gone for
// the moment. Falls back to walking up from the merge button out of flex/grid
// rows so the panel gets its own full-width block. Returns whether it placed it.
function placePanel(merge, panel) {
  const placed = () => {
    panel.gmh?.resize();
    return true;
  };
  const boxes = [...document.querySelectorAll('[data-testid="mergebox-border-container"]')].filter((b) => !b.closest(USER_CONTENT));
  if (boxes.length === 1) {
    boxes[0].after(panel);
    return placed();
  }
  if (!merge) return false;
  let el = buttonGroup(merge);
  for (let i = 0; i < 10 && el.parentElement && el.parentElement !== document.body; i++) {
    const display = getComputedStyle(el.parentElement).display;
    if (!/flex|grid|inline/.test(display)) break;
    el = el.parentElement;
  }
  el.after(panel);
  return placed();
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

// edits: the panel's title and description as last edited (when restored).
function showResult(merge, edits = null) {
  const s = state;
  const { suggestion, mode, diffTruncated, model, trailers, stale } = s.result;
  const heading =
    mode === "generate"
      ? "Suggested squash commit message"
      : suggestion.verdict === "ok"
        ? "Commit message looks good"
        : "Commit message needs changes";

  const title = h("input", { type: "text", className: "gmh-title", value: edits?.title ?? suggestion.title, spellcheck: true });
  const counter = h("span", { className: "gmh-counter" });
  const body = h("textarea", { className: "gmh-body", rows: 6, spellcheck: true });
  body.value = edits?.body ?? suggestion.body;
  const checks = h("div", { className: "gmh-checks" });
  // Grow the description to fit (CSS caps the height). Only works while the
  // panel is in the page, so placePanel() calls it again.
  const resize = () => {
    if (!body.isConnected) return;
    body.style.height = "auto";
    body.style.height = `${body.scrollHeight + 2}px`;
  };
  const onEdit = () => {
    resize();
    setText(counter, `${title.value.length}/72`);
    counter.classList.toggle("gmh-over", title.value.length > 72);
    renderChecks(checks);
    check();
  };
  let saveTimer;
  const saveEdits = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      browser.runtime
        .sendMessage({ type: "saveEdits", owner: s.owner, repo: s.repo, number: s.number, title: title.value, body: body.value })
        .catch(() => {});
    }, 500);
  };
  for (const field of [title, body]) {
    field.addEventListener("input", onEdit);
    field.addEventListener("input", saveEdits);
  }

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
    stale ? h("p", { className: "gmh-update-note" }, "This PR has new commits since this suggestion. Click “Regenerate” to update it.") : null,
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
  panel.gmh = { title, body, fillButton, undoButton, resize };
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
  const limit = titleLimit(state.owner);
  const length = finalMessage(title.value, "", []).title.length;
  result.titleTooLong = limit && length > limit ? { length, limit } : null;
  result.warnings = result.unknown.length > 0 || result.removed > 0 || result.titleTooLong !== null;
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
  if (result.titleTooLong) {
    const { length, limit } = result.titleTooLong;
    items.push(h("li", { className: "gmh-warning" }, `The title is ${length} characters; ${state.owner} allows at most ${limit}.`));
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
  // Closing also forgets the saved result, so it doesn't come back next visit.
  onClick(button, () => {
    state.panel?.remove();
    state.panel = null;
    browser.runtime.sendMessage({ type: "forget", owner: state.owner, repo: state.repo, number: state.number }).catch(() => {});
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

// GitHub renders the merge box, changes its buttons, and navigates without
// page loads, so re-check after DOM changes (debounced). Hidden tabs skip the
// work (GitHub keeps updating them) and check once when shown again.
let scheduled = false;
let missed = false;
new MutationObserver(() => {
  if (document.hidden) {
    missed = true;
    return;
  }
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    check();
  }, 250);
}).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "aria-disabled"] });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && missed) {
    missed = false;
    check();
  }
});
// Back/forward cache restores don't necessarily mutate the DOM.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) check();
});
check();
