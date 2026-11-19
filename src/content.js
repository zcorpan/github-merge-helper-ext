// Adds a button next to GitHub's merge button that asks Claude to review or
// write the commit message. Nothing happens until the button is clicked.
//
// Security: the model's answer is untrusted (PR text can contain prompt
// injection). It is only ever inserted as text (never as HTML), only put into
// GitHub's commit form fields (never submitted; you confirm the merge), and
// checked by safety.js for closing keywords, unexpected references, and
// invisible characters. Clicks synthesized by page scripts are ignored.

import { checkMessage, cleanTrailer, issueLinks, stripInvisible, stripPrRef, titleLimit, validPullRef } from "./safety.js";

const MERGE_LABEL =
  /^(?:Merge pull request|Squash and merge|Rebase and merge|Enable auto-merge(?: \(\w+\))?|Confirm (?:merge|squash and merge|rebase and merge|auto-merge(?: \(\w+\))?))$/i;
// Any tab of a PR: the merge status side panel is on all of them.
const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/;
// Where GitHub renders user-written content; never treat buttons or fields in
// there as part of the merge controls.
const USER_CONTENT = ".markdown-body, .comment-body, .js-comment-body, .comment-form-textarea, [data-testid='markdown-body']";

// Where GitHub shows merge controls: the merge card on the Overview tab (its
// merge button opens a modal confirm dialog), and the "Merge status" side
// panel (its commit editor opens inline).
const CARD = '[data-testid="for-you-item-row"]';
const SIDE = '[data-testid="mergebox-border-container"]';
const DIALOG = '[role="dialog"]';
const SURFACES = { dialog: DIALOG, side: SIDE, card: CARD };
// GitHub's merge method menu, next to every merge button; only used to notice
// when the merge button can't be found.
const METHOD_MENU = '[data-dd-action-name="pull_requests.merge.open_method"]';

let state = null;
let warnTimer = null;

// Each run of this script tags the elements it creates. After an update,
// Firefox injects the new version into open tabs while the old version's
// elements stay in the page with handlers that no longer run.
const INSTANCE = crypto.randomUUID();
const OUR_ELEMENTS = ".gmh-button, .gmh-restore, .gmh-caption, .gmh-panel";
const OUR_CONTROLS = ".gmh-button, .gmh-restore";

// Deals with a previous version's leftovers: lone buttons are removed (ours
// replace them); a panel is kept, with its buttons disabled and a note to
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
    for (const button of el.matches("button") ? [el] : el.querySelectorAll("button")) setDisabled(button, true);
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
  return { key, owner, repo, number, result: null, loading: false, filled: null, buttons: {}, panel: null,
    panelSurface: null, warned: new Set(), cleanup: null, caption: null, mergeSeen: false, goneTimer: null, goneChecks: 0 };
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
  if (!state || handleStale()) return;

  // The PR header says it was just merged or closed: close the panel now,
  // without waiting for checkStillOpen() below.
  if (state.panel && pageSaysClosed()) {
    closePanelForClosedPr(state);
    return;
  }

  const surfaces = findSurfaces();
  maybeWarn(surfaces);
  if (Object.keys(surfaces).length) {
    state.mergeSeen = true;
    state.goneChecks = 0;
    clearTimeout(state.goneTimer);
    state.goneTimer = null;
  } else if (state.mergeSeen && state.panel?.isConnected && !state.goneTimer && state.goneChecks < GONE_CHECK_DELAYS.length) {
    // The merge button went away (e.g. the PR was just merged) while the panel
    // is showing: once it has stayed away for a moment, check the PR's state,
    // a few times in case GitHub's API lags behind the page.
    const s = state;
    s.goneTimer = setTimeout(() => checkStillOpen(s), GONE_CHECK_DELAYS[s.goneChecks]);
  }

  // Our button is there whenever a merge button is, even while GitHub has it
  // disabled (e.g. while checking mergeability, or without write access).
  for (const kind of Object.keys(SURFACES)) syncButton(kind, surfaces[kind]);
  for (const surface of Object.values(surfaces)) cleanUpSquash(surface.merge);
  syncCaption();

  // GitHub re-renders the merge controls at times; put the panel back when it does.
  if (state.panel) {
    placePanel(surfaces);
    updatePanelControls(surfaces);
  }
}

const GONE_CHECK_DELAYS = [1500, 5000, 15000];

// Removes the panel (and the saved result) if the PR is no longer open. After
// the last retry, needs the merge button to come back before checking again.
async function checkStillOpen(s) {
  if (state !== s || Object.keys(findSurfaces()).length) {
    s.goneTimer = null;
    return;
  }
  s.goneChecks++;
  let reply;
  try {
    reply = await browser.runtime.sendMessage({ type: "prState", owner: s.owner, repo: s.repo, number: s.number });
  } catch {
    reply = null;
  }
  s.goneTimer = null;
  if (state !== s) return;
  if (reply?.open !== false) {
    check();
    return;
  }
  closePanelForClosedPr(s);
}

// The PR header's state label (GitHub's Primer StateLabel): true if they all
// say merged or closed.
function pageSaysClosed() {
  const statuses = [...document.querySelectorAll('header [data-component="StateLabel"]')].map((el) => el.dataset.status);
  return statuses.length > 0 && statuses.every((status) => status === "pullMerged" || status === "pullClosed");
}

function closePanelForClosedPr(s) {
  clearTimeout(s.goneTimer);
  s.goneTimer = null;
  s.panel?.remove();
  s.panel = null;
  s.result = null;
  browser.runtime.sendMessage({ type: "forget", owner: s.owner, repo: s.repo, number: s.number }).catch(() => {});
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
  showResult(saved.edits);
  check();
}

function warnOnce(id, message) {
  if (state.warned.has(id)) return;
  state.warned.add(id);
  console.warn(`[GitHub Merge Helper] ${message}`);
}

// The visible merge buttons outside user content, by where they are:
// { dialog, side, card }, each { kind, merge, container }. A surface with more
// than one merge button is left out.
function findSurfaces() {
  const found = {};
  const ambiguous = new Set();
  for (const b of document.querySelectorAll("button")) {
    if (!MERGE_LABEL.test(normalized(b.textContent)) || !b.getClientRects().length || b.closest(`.gmh-panel, ${USER_CONTENT}`)) continue;
    const kind = Object.keys(SURFACES).find((k) => b.closest(SURFACES[k]));
    if (!kind) {
      warnOnce("unknown", "Found a merge button outside the merge card, side panel, and confirm dialog; ignoring it.");
      continue;
    }
    if (found[kind]) ambiguous.add(kind);
    found[kind] = { kind, merge: b, container: b.closest(SURFACES[kind]) };
  }
  for (const kind of ambiguous) {
    warnOnce(`ambiguous-${kind}`, `Found more than one merge button in the ${kind}; not adding anything there.`);
    delete found[kind];
  }
  return found;
}

// The open commit editor that our message can go into, if any. A modal dialog
// comes first: the rest of the page is inert while it's open.
function editorSurface(surfaces = findSurfaces()) {
  return [surfaces.dialog, surfaces.side, surfaces.card].find((s) => s && canFill(s.merge)) ?? null;
}

// GitHub shows a merge method menu but we found no merge button next to it:
// warn once, if that lasts (the merge controls render asynchronously).
function maybeWarn(surfaces) {
  if (state.warned.has("missing") || warnTimer || !menuWithoutMergeButton(surfaces)) return;
  warnTimer = setTimeout(() => {
    warnTimer = null;
    if (state && menuWithoutMergeButton(findSurfaces())) {
      warnOnce("missing", "Found GitHub's merge method menu but not the merge button; GitHub's markup may have changed.");
    }
  }, 3000);
}

function menuWithoutMergeButton(surfaces) {
  const groups = Object.values(surfaces).map((s) => s.merge.closest('[data-component="ButtonGroup"]'));
  return [...document.querySelectorAll(METHOD_MENU)].some(
    (menu) => menu.getClientRects().length && !menu.closest(USER_CONTENT) && !groups.includes(menu.closest('[data-component="ButtonGroup"]')),
  );
}

// Setting `disabled` to its current value still counts as a DOM change, which
// would re-run check().
function setDisabled(el, disabled) {
  if (el.disabled !== disabled) el.disabled = disabled;
}

// Where our button goes: after GitHub's merge controls. Next to the merge
// method menu, that's the Primer split button's ButtonGroup. In a commit
// editor, the confirm button sits in a loading wrapper in a row with Cancel,
// so it's that row's last control. Our own elements never count, so the anchor
// doesn't change when we insert them next to it.
function controlsAnchor(merge) {
  const group = merge.closest('[data-component="ButtonGroup"]');
  if (group) return group;
  const item = merge.closest("[data-loading-wrapper]") ?? merge;
  const theirs = item.parentElement ? [...item.parentElement.children].filter((c) => !c.matches(OUR_CONTROLS)) : [];
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

// Title input and description textarea of the commit editor the confirm
// button is in: exactly one visible text input and one visible textarea in
// its dialog or merge box, none of them in user content.
function commitFields(merge) {
  if (!isConfirming(merge)) return null;
  const scope = merge.closest(`${DIALOG}, ${SIDE}`);
  if (!scope) return null;
  const usable = (el) => el.getClientRects().length && !el.closest(`.gmh-panel, ${USER_CONTENT}`);
  const titles = [...scope.querySelectorAll('input[type="text"], input:not([type])')].filter(usable);
  const bodies = [...scope.querySelectorAll("textarea")].filter(usable);
  return titles.length === 1 && bodies.length === 1 ? { title: titles[0], body: bodies[0] } : null;
}

function canFill(merge) {
  return mergeMethod(merge) === "squash" && commitFields(merge) !== null;
}

// Whether we filled in the commit editor these fields belong to (not one that
// was closed since).
function filledHere(fields) {
  return Boolean(fields && state.filled?.title === fields.title && fields.title.isConnected);
}

// The PR's commit count, from the Commits tab's counter.
function pageCommitCount() {
  const counter = document.querySelector(`a[href$="/pull/${state.number}/commits"] [data-component="CounterLabel"]`);
  const count = counter && Number(counter.textContent.trim());
  return Number.isInteger(count) && count > 0 ? count : null;
}

// Our button's label for a surface, or null for no button. Commit editors only
// get one for squash merges (rebase has no message; merge commits aren't
// filled in), and a dialog only once there's a suggestion to fill in, since
// the panel can't be used while the dialog is open.
function buttonLabel({ kind, merge }) {
  if (isConfirming(merge)) {
    if (!canFill(merge)) return null;
    if (state.result && state.panel?.gmh) return filledHere(commitFields(merge)) ? "Undo fill in" : "Fill in suggested message";
    if (kind === "dialog") return null;
  }
  if (state.loading) return "Asking Claude…";
  const count = state.result?.commitCount ?? pageCommitCount();
  if (count === 1) return "Review commit message";
  if (count > 1) return "Write squash commit message";
  return "Write commit message";
}

function syncButton(kind, surface) {
  const label = surface ? buttonLabel(surface) : null;
  let button = state.buttons[kind];
  if (!label) {
    button?.remove();
    return;
  }
  button ??= state.buttons[kind] = createButton(kind);
  const anchor = controlsAnchor(surface.merge);
  if (button.previousElementSibling !== anchor) anchor.after(button);
  styleLike(button, surface.merge);
  setText(button.gmhLabel, label);
  setDisabled(button, state.loading);
}

// A button with Primer's markup (content and text spans). styleLike() gives
// it GitHub's own classes.
function primerButton(className, label) {
  const text = h("span", {}, label);
  const content = h("span", {}, text);
  const button = h("button", { type: "button", className }, content);
  button.dataset.gmhInstance = INSTANCE;
  button.dataset.gmhClass = className;
  button.gmhLabel = text;
  button.gmhContent = content;
  return button;
}

// Copies GitHub's Primer button classes from one of its buttons (only the
// prc-Button-* ones, not layout utilities), so ours look the same as GitHub's
// current buttons, at the same size, in the secondary style. Without a model
// to copy from, content.css styles it.
function styleLike(button, model, size = model?.dataset.size || "medium") {
  const primer = (el) => [...(el?.classList ?? [])].filter((c) => c.startsWith("prc-Button-") && !c.startsWith("prc-Button-IconButton"));
  const base = primer(model);
  const content = primer(model?.querySelector('[data-component="buttonContent"]'));
  const text = primer(model?.querySelector('[data-component="text"]'));
  const copied = base.length > 0 && content.length > 0 && text.length > 0;
  const className = [button.dataset.gmhClass, ...(copied ? ["gmh-primer", ...base] : [])].join(" ");
  if (button.className !== className) button.className = className;
  const contentClass = content.join(" ");
  if (button.gmhContent.className !== contentClass) button.gmhContent.className = contentClass;
  const textClass = text.join(" ");
  if (button.gmhLabel.className !== textClass) button.gmhLabel.className = textClass;
  Object.assign(button.dataset, { size, variant: "default", noVisuals: "true" });
  button.gmhContent.dataset.align = "center";
}

// A GitHub button to copy styles from when none is next to ours.
function anyPrimerButton(surfaces) {
  return (
    Object.values(surfaces)[0]?.merge ??
    document.querySelector('button[data-component="Button"][data-variant="default"]:not([data-gmh-instance])')
  );
}

function createButton(kind) {
  const button = primerButton("gmh-button", "");
  onClick(button, () => onButtonClick(kind));
  return button;
}

// Cleans up GitHub's default squash title without Claude, once per commit
// editor: drops the " (#N)" GitHub appends. Only touches GitHub's untouched
// default, only if it wasn't edited while the setting was read, and never the
// description. Never submits anything. The title field is marked once tried,
// so a newer version injected after an update doesn't redo it (e.g. after
// "Restore").
function cleanUpSquash(merge) {
  if (mergeMethod(merge) !== "squash") return;
  const fields = commitFields(merge);
  if (!fields || fields.title.dataset.gmhCleanup) return;
  const before = fields.title.value;
  const cleaned = stripPrRef(before, state.number);
  if (cleaned === before) return;
  fields.title.dataset.gmhCleanup = "tried";
  const s = state;
  browser.runtime
    .sendMessage({ type: "cleanupEnabled", owner: s.owner, repo: s.repo, number: s.number })
    .then((reply) => {
      if (state !== s || reply?.enabled !== true || !fields.title.isConnected || fields.title.value !== before) return;
      setNativeValue(fields.title, cleaned);
      s.cleanup = { title: fields.title, original: before, cleaned };
      check();
    })
    .catch(() => {});
}

// While the cleaned-up title is in the editor, a caption under it says so and
// offers to restore GitHub's.
function syncCaption() {
  const c = state.cleanup;
  if (c && !c.title.isConnected) state.cleanup = null;
  if (!state.cleanup || c.title.value !== c.cleaned) {
    state.caption?.remove();
    return;
  }
  if (!state.caption) {
    const restore = h("button", { type: "button", className: "gmh-link" }, "Restore");
    onClick(restore, () => {
      const cleanup = state.cleanup;
      if (!cleanup?.title.isConnected) return;
      setNativeValue(cleanup.title, cleanup.original);
      state.cleanup = null;
      check();
    });
    state.caption = h("div", { className: "gmh-caption" }, `Removed “(#${state.number})” from the title. `, restore);
    state.caption.dataset.gmhInstance = INSTANCE;
  }
  const anchor = c.title.closest('[data-component="TextInput"]') ?? c.title;
  if (state.caption.previousElementSibling !== anchor) anchor.after(state.caption);
}

async function onButtonClick(kind) {
  const surface = findSurfaces()[kind];
  if (!surface) return;
  // With a suggestion showing: in a commit editor, the button fills it in (or
  // undoes that), keeping any edits made in the panel; elsewhere it shows the
  // panel. Otherwise ask the background, which reuses its cached answer while
  // the PR head is unchanged.
  if (state.result && state.panel?.gmh) {
    const fields = commitFields(surface.merge);
    if (fields && canFill(surface.merge)) {
      if (filledHere(fields)) undo();
      else fill(surface.merge);
      return;
    }
    state.panelSurface = kind;
    placePanel(findSurfaces());
    state.panel.scrollIntoView({ block: "nearest" });
    return;
  }
  if (kind !== "dialog") state.panelSurface = kind;
  await request(false);
}

async function request(force) {
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
  if (response.error) {
    showError(response);
  } else {
    s.result = response;
    showResult();
    const editor = editorSurface();
    if (editor && !currentChecks()?.warnings) fill(editor.merge);
  }
  check();
}

// Below the merge card on the Overview tab, or below the merge box in the side
// panel: the surface whose button was clicked last, else the side panel if
// it's open. Stays where it is while only a dialog is found.
function placePanel(surfaces) {
  const panel = state.panel;
  const surface = surfaces[state.panelSurface] ?? surfaces.side ?? surfaces.card;
  if (!panel || !surface || surface.kind === "dialog") return;
  const card = surface.kind === "card" && surface.container.closest("section")?.parentElement;
  const anchor = card && card !== document.body ? card : surface.container;
  if (panel.previousElementSibling !== anchor) {
    anchor.after(panel);
    panel.gmh?.resize();
  }
  styleActions(surfaces);
}

// The panel's buttons get GitHub's small button style.
function styleActions(surfaces) {
  const model = anyPrimerButton(surfaces);
  for (const button of state.panel.querySelectorAll(".gmh-action")) styleLike(button, model, "small");
}

function replacePanel(panel) {
  panel.dataset.gmhInstance = INSTANCE;
  state.panel?.remove();
  state.panel = panel;
  placePanel(findSurfaces());
}

function action(label, handler) {
  const button = primerButton("gmh-action", label);
  onClick(button, handler);
  return button;
}

function panelHeader(heading, className = "") {
  return h("div", { className: "gmh-header" }, h("h3", { className: `gmh-heading ${className}` }, heading), closeButton());
}

function showError({ error, needsSettings }) {
  const content = [h("p", { className: "gmh-error" }, error)];
  if (needsSettings) content.push(h("div", { className: "gmh-actions" }, action("Open settings", () => browser.runtime.sendMessage({ type: "openOptions" }))));
  replacePanel(h("div", { className: "gmh-panel" }, panelHeader("Couldn’t get a suggestion", "gmh-needs_changes"), h("div", { className: "gmh-content" }, ...content)));
}

// edits: the panel's title and description as last edited (when restored).
function showResult(edits = null) {
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
  title.id = `gmh-title-${INSTANCE}`;
  body.id = `gmh-body-${INSTANCE}`;
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

  const fillButton = action("Fill in", () => {
    const editor = editorSurface();
    if (editor) fill(editor.merge);
  });
  const undoButton = action("Undo", undo);
  const copyButton = action("Copy", async () => {
    const message = finalMessage(title.value, body.value, trailers);
    await navigator.clipboard.writeText([message.title, message.body].filter(Boolean).join("\n\n"));
    setText(copyButton.gmhLabel, "Copied");
    setTimeout(() => setText(copyButton.gmhLabel, "Copy"), 1500);
  });
  const regenerateButton = action("Regenerate", () => request(true));

  const panel = h(
    "div",
    { className: "gmh-panel" },
    panelHeader(heading, `gmh-${suggestion.verdict}`),
    h(
      "div",
      { className: "gmh-content" },
      suggestion.issues.length ? h("ul", { className: "gmh-issues" }, ...suggestion.issues.map((i) => h("li", {}, ...linkified(i)))) : null,
      suggestion.notes ? h("p", { className: "gmh-notes" }, ...linkified(suggestion.notes)) : null,
      stale ? h("p", { className: "gmh-update-note" }, "This PR has new commits since this suggestion. Click “Regenerate” to update it.") : null,
      diffTruncated ? h("p", { className: "gmh-notes" }, "The diff was too large and was truncated before sending.") : null,
      h("label", { className: "gmh-label", htmlFor: title.id }, "Title ", counter),
      title,
      h("label", { className: "gmh-label", htmlFor: body.id }, "Description"),
      body,
      trailers.length ? h("p", { className: "gmh-trailers" }, `Added on fill/copy: ${uniqueTrailers(trailers).join(", ")}`) : null,
      checks,
      h("p", { className: "gmh-hint" }),
    ),
    h(
      "div",
      { className: "gmh-footer" },
      h("div", { className: "gmh-actions" }, fillButton, copyButton, regenerateButton, undoButton),
      h("p", { className: "gmh-model" }, `${model}. Claude's answer can be influenced by text in the PR; read it before merging.`),
    ),
  );
  panel.gmh = { title, body, fillButton, undoButton, resize };
  replacePanel(panel);
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

function updatePanelControls(surfaces) {
  const controls = state.panel?.gmh;
  if (!controls) return;
  const editor = editorSurface(surfaces);
  const filled = editor ? filledHere(commitFields(editor.merge)) : false;
  setDisabled(controls.fillButton, !editor);
  controls.undoButton.hidden = !filled;
  const hint = state.panel.querySelector(".gmh-hint");
  const { mode, suggestion } = state.result;
  const shown = surfaces[state.panelSurface] ?? surfaces.side ?? surfaces.card;
  let text = "";
  if (editor && !filled && currentChecks()?.warnings) {
    text = "Not filled in automatically because of the warnings above. Review, then click “Fill in”.";
  } else if (!editor && shown) {
    const method = mergeMethod(shown.merge);
    if (method !== "squash" && mode === "generate") {
      text = "This PR has several commits. Choose “Squash and merge” to use this message.";
    } else if (method !== "squash" && suggestion.verdict === "needs_changes") {
      text = "Choose “Squash and merge” to use the fixed message, or amend the commit.";
    } else if (method === "squash" && !isConfirming(shown.merge)) {
      text = `Click “${normalized(shown.merge.textContent)}”, then “Fill in suggested message”.`;
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
  if (!filledHere(fields)) state.filled = { title: fields.title, original };
  setNativeValue(fields.title, message.title);
  setNativeValue(fields.body, message.body);
  check();
}

function undo() {
  const editor = editorSurface();
  const fields = editor && commitFields(editor.merge);
  if (!filledHere(fields)) return;
  setNativeValue(fields.title, state.filled.original.title);
  setNativeValue(fields.body, state.filled.original.body);
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

const SVG = "http://www.w3.org/2000/svg";
// Octicon "x" (16px).
const X_PATH =
  "M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z";

function closeButton() {
  const svg = document.createElementNS(SVG, "svg");
  for (const [name, value] of Object.entries({ viewBox: "0 0 16 16", width: "16", height: "16", fill: "currentColor", "aria-hidden": "true" })) {
    svg.setAttribute(name, value);
  }
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", X_PATH);
  svg.append(path);
  const button = h("button", { type: "button", className: "gmh-close", title: "Close" }, svg);
  button.setAttribute("aria-label", "Close");
  // Closing also forgets the saved result, so it doesn't come back next visit.
  onClick(button, () => {
    state.panel?.remove();
    state.panel = null;
    browser.runtime.sendMessage({ type: "forget", owner: state.owner, repo: state.repo, number: state.number }).catch(() => {});
    check();
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

// GitHub renders the merge controls, changes its buttons, and navigates
// without page loads, so re-check after DOM changes (debounced). Hidden tabs
// skip the work (GitHub keeps updating them) and check once when shown again.
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

