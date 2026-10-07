// Adds a button next to GitHub's merge button that asks Claude to review or
// write the commit message. Nothing happens until the button is clicked.

const MERGE_LABEL =
  /^(?:Merge pull request|Squash and merge|Rebase and merge|Enable auto-merge(?: \(\w+\))?|Confirm (?:merge|squash and merge|rebase and merge|auto-merge(?: \(\w+\))?))$/i;
const MERGEBOX_TEXT =
  /This branch has no conflicts with the base branch|Merging is blocked|This branch has conflicts that must be resolved|can be automatically merged|Merging can be performed automatically/;
const NO_WRITE_ACCESS_TEXT = /Only those with write access to this repository can merge/;
const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;

let state = null;
let warnTimer = null;

function freshState(path, [, owner, repo, number]) {
  return { path, owner, repo, number: Number(number), result: null, loading: false, filled: null, button: null, panel: null,
    pageCommitCount: null, warned: false, noWriteAccess: false, lastScan: 0 };
}

function check() {
  const match = location.pathname.match(PR_PATH);
  if (state?.path !== location.pathname) {
    state?.button?.remove();
    state?.panel?.remove();
    clearTimeout(warnTimer);
    warnTimer = null;
    state = match ? freshState(location.pathname, match) : null;
  }
  if (!state) return;

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

function findMergeButton() {
  for (const b of document.querySelectorAll("button")) {
    if (b.classList.contains("gmh-button")) continue;
    if (MERGE_LABEL.test(normalized(b.textContent)) && b.getClientRects().length) return b;
  }
  return null;
}

function isDisabled(button) {
  return button.disabled || button.getAttribute("aria-disabled") === "true";
}

// The merge button usually sits in a split-button group (or next to Cancel when
// confirming); put our button after the whole group.
function buttonGroup(merge) {
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

// Title input and description textarea of the open commit editor, if any.
function commitFields(merge) {
  if (!isConfirming(merge)) return null;
  const classicTitle = document.getElementById("merge_title_field");
  const classicBody = document.getElementById("merge_message_field");
  if (classicTitle?.getClientRects().length && classicBody) return { title: classicTitle, body: classicBody };
  let el = merge;
  for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
    const title = [...el.querySelectorAll('input[type="text"], input:not([type])')].find(
      (i) => i.getClientRects().length && !i.closest(".gmh-panel"),
    );
    const body = [...el.querySelectorAll("textarea")].find((t) => t.getClientRects().length && !t.closest(".gmh-panel"));
    if (title && body) return { title, body };
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
  if (state.result && canFill(merge) && !state.filled) return "Fill in commit message";
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
  button.addEventListener("click", onButtonClick);
  return button;
}

async function onButtonClick() {
  const merge = findMergeButton();
  if (!merge) return;
  // With the suggestion already showing, the button only fills it in, keeping
  // any edits made in the panel. Otherwise ask the background, which reuses its
  // cached answer while the PR head is unchanged.
  if (state.result && state.panel?.gmh) {
    if (canFill(merge)) fill(merge);
    state.panel.scrollIntoView({ block: "nearest" });
    return;
  }
  await request(merge, false);
}

async function request(merge, force) {
  const s = state;
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
    if (canFill(merge)) fill(merge);
  }
  check();
}

function placePanel(merge, panel) {
  // Walk up out of flex/grid rows so the panel gets its own full-width block.
  let el = buttonGroup(merge);
  for (let i = 0; i < 10 && el.parentElement && el.parentElement !== document.body; i++) {
    const display = getComputedStyle(el.parentElement).display;
    if (!/flex|grid|inline/.test(display)) break;
    el = el.parentElement;
  }
  el.after(panel);
}

function replacePanel(merge, panel) {
  state.panel?.remove();
  state.panel = panel;
  placePanel(merge, panel);
}

function showError(merge, { error, needsSettings }) {
  const children = [h("p", { className: "gmh-error" }, error)];
  if (needsSettings) {
    const link = h("button", { type: "button", className: "gmh-link" }, "Open settings");
    link.addEventListener("click", () => browser.runtime.sendMessage({ type: "openOptions" }));
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
  const updateCounter = () => {
    setText(counter, `${title.value.length}/72`);
    counter.classList.toggle("gmh-over", title.value.length > 72);
  };
  title.addEventListener("input", updateCounter);
  updateCounter();
  const body = h("textarea", { className: "gmh-body", rows: 6, spellcheck: true });
  body.value = suggestion.body;

  const fillButton = h("button", { type: "button", className: "gmh-action gmh-fill" }, "Fill in");
  fillButton.addEventListener("click", () => fill(findMergeButton()));
  const undoButton = h("button", { type: "button", className: "gmh-action gmh-undo" }, "Undo");
  undoButton.addEventListener("click", undo);
  const copyButton = h("button", { type: "button", className: "gmh-action" }, "Copy");
  copyButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(composeMessage(title.value, body.value, trailers));
    setText(copyButton, "Copied");
    setTimeout(() => setText(copyButton, "Copy"), 1500);
  });
  const regenerateButton = h("button", { type: "button", className: "gmh-action" }, "Regenerate");
  regenerateButton.addEventListener("click", () => request(findMergeButton(), true));

  const panel = h(
    "div",
    { className: "gmh-panel" },
    closeButton(),
    h("h3", { className: `gmh-heading gmh-${suggestion.verdict}` }, heading),
    suggestion.issues.length ? h("ul", { className: "gmh-issues" }, ...suggestion.issues.map((i) => h("li", {}, i))) : null,
    suggestion.notes ? h("p", { className: "gmh-notes" }, suggestion.notes) : null,
    h("p", { className: "gmh-hint" }),
    diffTruncated ? h("p", { className: "gmh-notes" }, "The diff was too large and was truncated before sending.") : null,
    h("label", { className: "gmh-label" }, "Title ", counter),
    title,
    h("label", { className: "gmh-label" }, "Description"),
    body,
    trailers.length ? h("p", { className: "gmh-trailers" }, `Added on fill/copy: ${trailers.join(", ")}`) : null,
    h("div", { className: "gmh-actions" }, fillButton, copyButton, regenerateButton, undoButton),
    h("p", { className: "gmh-model" }, model),
  );
  panel.gmh = { title, body, fillButton, undoButton };
  replacePanel(merge, panel);
  updatePanelControls();
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
  if (!fillable && merge) {
    const method = mergeMethod(merge);
    if (method !== "squash" && mode === "generate") {
      text = "This PR has several commits. Choose “Squash and merge” to use this message.";
    } else if (method !== "squash" && suggestion.verdict === "needs_changes") {
      text = "Choose “Squash and merge” to use the fixed message, or amend the commit.";
    } else if (method === "squash") {
      text = "Click “Squash and merge”, then “Fill in commit message”.";
    }
  }
  setText(hint, text);
  hint.hidden = !text;
}

function fill(merge) {
  const fields = merge && commitFields(merge);
  const controls = state.panel?.gmh;
  if (!fields || !controls) return;
  const original = { title: fields.title.value, body: fields.body.value };
  const existing = original.body.split("\n").filter((l) => /^co-authored-by:/i.test(l.trim()));
  setNativeValue(fields.title, controls.title.value.trim());
  setNativeValue(fields.body, composeBody(controls.body.value, [...existing, ...state.result.trailers]));
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

function composeBody(body, trailers) {
  const seen = new Set();
  const unique = [];
  for (const t of trailers) {
    const line = t.trim();
    const key = (line.match(/<([^>]+)>/)?.[1] ?? line).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(line.replace(/^co-authored-by:/i, "Co-authored-by:"));
  }
  return [body.trim(), unique.join("\n")].filter(Boolean).join("\n\n");
}

function composeMessage(title, body, trailers) {
  return [title.trim(), composeBody(body, trailers)].filter(Boolean).join("\n\n");
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
  button.addEventListener("click", () => {
    state.panel?.remove();
    state.panel = null;
  });
  return button;
}

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
