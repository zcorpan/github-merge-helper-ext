// Deterministic checks on model output. The PR data sent to the model is
// untrusted (anyone can open a PR), so the model's answer may have been steered
// by prompt injection. Nothing here relies on the model behaving.

export const MAX_TITLE_CHARS = 200;

// Hard title length limits by repository owner (WHATWG's committer guidelines).
export function titleLimit(owner) {
  return owner.toLowerCase() === "whatwg" ? 72 : null;
}
export const MAX_BODY_CHARS = 10_000;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export function validPullRef(owner, repo, number) {
  return (
    typeof owner === "string" &&
    typeof repo === "string" &&
    OWNER.test(owner) &&
    REPO.test(repo) &&
    repo !== "." &&
    repo !== ".." &&
    Number.isSafeInteger(number) &&
    number > 0
  );
}

// Strip control and invisible formatting characters (bidi overrides,
// zero-width characters, Unicode tag characters, private use, etc.), which
// could hide text in a commit message. Keeps newlines; tabs become spaces.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u2028\u2029]/gu;

export function stripInvisible(text) {
  let removed = 0;
  const cleaned = text.replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(INVISIBLE, (c) => {
    if (c === "\n") return c;
    removed++;
    return "";
  });
  return { text: cleaned, removed };
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]{1,2000}/gi;
// Quantifiers are bounded (GitHub's owner/repo name limits) so matching stays
// linear on long attacker-controlled input.
const ISSUE_PATTERN = /(?<![\w/#&.-])((?:[A-Za-z0-9][\w-]{0,38}\/[\w.-]{1,100})?#\d{1,10})\b/g;
const SHA_PATTERN = /(?<![\w/])[0-9a-f]{7,40}(?![\w/])/gi;
const MENTION_PATTERN = /(?<![\w`.@/])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\b/g;
const CLOSING_PATTERN =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s{1,20}((?:[A-Za-z0-9][\w-]{0,38}\/[\w.-]{1,100})?#\d{1,10}|https:\/\/github\.com\/[\w-]{1,39}\/[\w.-]{1,100}\/(?:issues|pull)\/\d{1,10})/gi;
const GITHUB_ISSUE_URL = /^https:\/\/github\.com\/([\w-]{1,39})\/([\w.-]{1,100})\/(?:issues|pull)\/(\d{1,10})$/i;

function trimUrl(url) {
  return url.replace(/[.,;:!?)\]]+$/, "");
}

function normalizeIssue(ref, owner, repo) {
  const url = ref.match(GITHUB_ISSUE_URL);
  if (url) return `${url[1]}/${url[2]}#${url[3]}`.toLowerCase();
  return (ref.startsWith("#") ? `${owner}/${repo}${ref}` : ref).toLowerCase();
}

// All references in a piece of text, normalized for comparison.
export function extractRefs(text, owner, repo) {
  const refs = new Set();
  for (const m of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(m[0]);
    refs.add(url.match(GITHUB_ISSUE_URL) ? normalizeIssue(url, owner, repo) : url);
  }
  for (const m of text.matchAll(ISSUE_PATTERN)) refs.add(normalizeIssue(m[1], owner, repo));
  for (const m of text.matchAll(SHA_PATTERN)) if (/\d/.test(m[0])) refs.add(m[0].toLowerCase());
  for (const m of text.matchAll(MENTION_PATTERN)) refs.add(`@${m[1].toLowerCase()}`);
  return refs;
}

// Issue references ("#N", "owner/repo#N") in text, with GitHub URLs built from
// the validated parts. Used to link them in the panel; other URLs in model
// output are never turned into links.
export function issueLinks(text, owner, repo) {
  const links = [];
  for (const m of text.matchAll(ISSUE_PATTERN)) {
    const [, refOwner = owner, refRepo = repo, number] = m[1].match(/^(?:([^/]+)\/([^#]+))?#(\d+)$/);
    if (!validPullRef(refOwner, refRepo, Number(number))) continue;
    links.push({ start: m.index, end: m.index + m[1].length, href: `https://github.com/${refOwner}/${refRepo}/issues/${number}` });
  }
  return links;
}

// What GitHub will close when this message lands on the default branch.
export function closingRefs(text, owner, repo) {
  const refs = new Set();
  for (const m of text.matchAll(CLOSING_PATTERN)) refs.add(normalizeIssue(trimUrl(m[1]), owner, repo));
  return [...refs];
}

// Display form: same-repo issues as "#N".
export function displayRef(ref, owner, repo) {
  const prefix = `${owner}/${repo}#`.toLowerCase();
  return ref.startsWith(prefix) ? `#${ref.slice(prefix.length)}` : ref;
}

// References in the message that don't appear in the PR title, description, or
// commit messages (the text the maintainer can see on the PR page). SHAs may
// be abbreviated, so a SHA counts as known if it is a prefix of a known one or
// vice versa.
export function unknownRefs(message, knownRefs, owner, repo) {
  const known = knownRefs instanceof Set ? knownRefs : new Set(knownRefs);
  const knownShas = [...known].filter((r) => /^[0-9a-f]{7,40}$/.test(r));
  const unknown = [];
  for (const ref of extractRefs(message, owner, repo)) {
    if (known.has(ref)) continue;
    if (/^[0-9a-f]{7,40}$/.test(ref) && knownShas.some((k) => k.startsWith(ref) || ref.startsWith(k))) continue;
    unknown.push(ref);
  }
  return unknown;
}

export function checkMessage({ title, body }, knownRefs, owner, repo) {
  const message = `${title}\n\n${body}`;
  return {
    closes: closingRefs(message, owner, repo).map((r) => displayRef(r, owner, repo)),
    unknown: unknownRefs(message, knownRefs, owner, repo).map((r) => displayRef(r, owner, repo)),
  };
}

// Validate and clean the model's JSON answer.
export function cleanSuggestion(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Claude's answer has the wrong shape.");
  const { verdict, issues, title, body, notes } = raw;
  if (!["ok", "needs_changes", "generated"].includes(verdict)) throw new Error("Claude's answer has an invalid verdict.");
  if (typeof title !== "string" || typeof body !== "string" || typeof notes !== "string" || !Array.isArray(issues)) {
    throw new Error("Claude's answer has the wrong shape.");
  }
  if (title.length > MAX_TITLE_CHARS || body.length > MAX_BODY_CHARS) throw new Error("Claude's answer is too long.");
  let removed = 0;
  const clean = (s) => {
    const r = stripInvisible(s);
    removed += r.removed;
    return r.text;
  };
  const result = {
    verdict,
    title: clean(title).replace(/\n/g, " ").trim(),
    body: clean(body).trim(),
    notes: clean(notes).trim().slice(0, 2000),
    issues: issues.filter((i) => typeof i === "string").slice(0, 20).map((i) => clean(i).trim().slice(0, 500)),
  };
  return { suggestion: result, removedChars: removed };
}

// "Co-authored-by: Name <email>" with a sane name and email, or null.
export function cleanTrailer(line) {
  const m = stripInvisible(line).text.trim().match(/^co-authored-by:\s*([^<>\n]{1,100}?)\s*<([^<>\s@]+@[^<>\s@]+)>$/i);
  return m ? `Co-authored-by: ${m[1]} <${m[2]}>` : null;
}
