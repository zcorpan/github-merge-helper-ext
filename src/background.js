import { OUTPUT_SCHEMA, buildSystemPrompt, buildUserMessage, cleanDescription, repoRules } from "./rules.js";
import { MAX_BODY_CHARS, MAX_TITLE_CHARS, cleanSuggestion, cleanTrailer, extractRefs, stripInvisible, validPullRef } from "./safety.js";
import { DEFAULTS } from "./defaults.js";

// Name of the native messaging host installed by native/install.py, which holds
// the API key and makes the request (browser requests are blocked for some orgs).
const NATIVE_HOST = "github_merge_helper";
const MAX_DIFF_CHARS = 300_000;
const MAX_CONTRIBUTING_CHARS = 30_000;

// Keyed by "owner/repo#number"; reused while the PR head is unchanged.
const cache = new Map();
// Requests in progress, by the same key, so repeated clicks don't pay twice.
const inflight = new Map();

// Results are also saved per PR, so the panel comes back after switching tabs
// or revisiting the PR. Dropped after 30 days, when the PR is no longer open,
// or when the panel is closed.
const SAVED_PREFIX = "pr:";
const SAVED_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

// Earlier versions stored the API key here; it now lives in the OS keychain.
browser.storage.local.remove("apiKey");
pruneSaved();

browser.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== browser.runtime.id) return undefined;
  // The settings page may test the connection.
  if (message?.type === "testConnection" && sender.url === browser.runtime.getURL("options.html")) {
    return callHost({ type: "ping" }).then(() => ({ ok: true }), (e) => ({ error: describeError(e) }));
  }
  // Only our own content script on github.com may ask for anything else.
  if (!sender.tab?.url?.startsWith("https://github.com/")) return undefined;
  if (message?.type === "openOptions") return browser.runtime.openOptionsPage();
  const { owner, repo, number } = message ?? {};
  if (!validPullRef(owner, repo, number)) return Promise.resolve({ error: "Invalid pull request reference." });
  const key = `${owner}/${repo}#${number}`;
  if (message.type === "restore") return restoreSaved({ owner, repo, number, key }).catch(() => null);
  if (message.type === "saveEdits") return saveEdits(key, message.title, message.body).catch(() => undefined);
  if (message.type === "forget") return browser.storage.local.remove(SAVED_PREFIX + key);
  if (message.type === "squashDefaults") return squashDefaults({ owner, repo, number }).catch((e) => ({ error: describeError(e) }));
  if (message.type === "suggest") {
    if (inflight.has(key)) return inflight.get(key);
    const promise = suggest({ owner, repo, number, force: message.force === true })
      .catch((e) => ({ error: describeError(e), needsSettings: e.needsSetup === true }))
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }
  return undefined;
});

function githubFor(settings, owner, repo) {
  const api = (path, accept) => githubFetch(`https://api.github.com${path}`, settings.githubToken, accept);
  const gh = (path, accept) => api(`/repos/${owner}/${repo}${path}`, accept);
  return { api, gh };
}

async function suggest({ owner, repo, number, force }) {
  const settings = await browser.storage.local.get(DEFAULTS);
  const { api, gh } = githubFor(settings, owner, repo);
  const pr = await (await gh(`/pulls/${number}`)).json();
  const key = `${owner}/${repo}#${number}`;
  const cached = cache.get(key);
  if (!force && cached?.headSha === pr.head.sha) {
    await save(key, pr.head.sha, cached.response, { keepEdits: true });
    return cached.response;
  }

  const [commits, diffText, contributing] = await Promise.all([
    fetchCommits(gh, number),
    gh(`/pulls/${number}`, "application/vnd.github.diff").then((r) => r.text()),
    repoRules(owner, repo) ? null : fetchContributing(gh, pr.base.ref),
  ]);
  if (commits.length === 0) return { error: "This PR has no commits." };
  const diffTruncated = diffText.length > MAX_DIFF_CHARS;
  const diff = diffTruncated ? diffText.slice(0, MAX_DIFF_CHARS) : diffText;
  const mode = commits.length === 1 ? "review" : "generate";
  const boundary = `pr-data-${randomHex(16)}`;

  // No tools: the model can only return text, which is checked below and only
  // ever shown as text or put in GitHub's commit form for you to confirm. The
  // native host rejects requests with any other shape.
  const { response } = await callHost({
    type: "messages",
    params: {
      model: settings.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: settings.effort, format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      system: buildSystemPrompt({ owner, repo, contributing, extraInstructions: settings.extraInstructions, boundary }),
      messages: [
        { role: "user", content: buildUserMessage({ owner, repo, pr, commits, diff, diffTruncated, mode, boundary }) },
      ],
    },
  });

  if (response.stop_reason === "refusal") {
    return { error: `Claude declined the request (${response.stop_category ?? "no category"}).` };
  }
  if (response.stop_reason === "max_tokens") return { error: "Claude's response was cut off (max_tokens)." };
  let parsed;
  try {
    parsed = JSON.parse(String(response.text));
  } catch {
    return { error: "Claude returned malformed JSON." };
  }
  let { suggestion, removedChars } = cleanSuggestion(parsed);

  // If the single commit is fine as-is, use its actual text rather than the
  // model's copy, so "looks good" can't smuggle in changes.
  if (mode === "review" && suggestion.verdict === "ok") {
    const original = stripInvisible(commits[0].commit.message);
    const [firstLine, ...rest] = original.text.split("\n");
    suggestion = {
      ...suggestion,
      title: firstLine.trim(),
      body: rest.filter((l) => !/^co-authored-by:/i.test(l.trim())).join("\n").trim(),
    };
    removedChars += original.removed;
  }

  // References the maintainer can see on the PR page. HTML comments are
  // stripped first since they're invisible there.
  const visible = [pr.title, cleanDescription(pr.body ?? ""), ...commits.map((c) => c.commit.message)].join("\n");

  const result = {
    suggestion,
    removedChars,
    knownRefs: [...extractRefs(visible, owner, repo)],
    mode,
    commitCount: commits.length,
    trailers: await coAuthorTrailers(api, pr, commits),
    diffTruncated,
    model: String(response.model),
  };
  cache.set(key, { headSha: pr.head.sha, response: result });
  await save(key, pr.head.sha, result, { keepEdits: false });
  return result;
}

async function save(key, headSha, result, { keepEdits }) {
  const storageKey = SAVED_PREFIX + key;
  const previous = keepEdits ? (await browser.storage.local.get(storageKey))[storageKey] : null;
  const edits = previous?.headSha === headSha ? (previous.edits ?? null) : null;
  await browser.storage.local.set({ [storageKey]: { headSha, savedAt: Date.now(), result, edits } });
}

// The saved result for a PR that's still open, re-validated, with any edits
// made in the panel and whether the PR has new commits since. One GitHub API
// request, no Claude request.
async function restoreSaved({ owner, repo, number, key }) {
  const storageKey = SAVED_PREFIX + key;
  const entry = (await browser.storage.local.get(storageKey))[storageKey];
  if (!entry) return null;
  const forget = () => browser.storage.local.remove(storageKey).then(() => null);
  if (!(Date.now() - entry.savedAt < SAVED_MAX_AGE)) return forget();

  let result;
  try {
    const { result: r } = entry;
    const { suggestion } = cleanSuggestion(r.suggestion);
    if (!["review", "generate"].includes(r.mode) || !Array.isArray(r.knownRefs) || !Array.isArray(r.trailers)) throw new Error();
    result = {
      suggestion,
      removedChars: Number(r.removedChars) || 0,
      knownRefs: r.knownRefs.filter((ref) => typeof ref === "string"),
      mode: r.mode,
      commitCount: Number(r.commitCount) || 0,
      trailers: r.trailers.map(cleanTrailer).filter(Boolean),
      diffTruncated: r.diffTruncated === true,
      model: String(r.model),
    };
  } catch {
    return forget();
  }

  let stale = false;
  try {
    const settings = await browser.storage.local.get(DEFAULTS);
    const pr = await (await githubFor(settings, owner, repo).gh(`/pulls/${number}`)).json();
    if (pr.state !== "open") return forget();
    stale = pr.head.sha !== entry.headSha;
    if (!stale) cache.set(key, { headSha: entry.headSha, response: result });
  } catch {
    // Offline or rate-limited: show it anyway.
  }
  return { ...result, edits: validEdits(entry.edits), stale };
}

// For cleaning up GitHub's default squash message without Claude: the first
// commit's description (often the real one, the rest being fixups) and the
// Co-authored-by trailers from all commits. Read-only GitHub requests only.
async function squashDefaults({ owner, repo, number }) {
  const settings = await browser.storage.local.get(DEFAULTS);
  if (!settings.cleanUpSquash) return { disabled: true };
  const commits = await fetchCommits(githubFor(settings, owner, repo).gh, number);
  if (!commits.length) return { error: "This PR has no commits." };
  const isTrailer = (line) => /^co-authored-by:/i.test(line.trim());
  const [, ...rest] = commits[0].commit.message.split("\n");
  const trailers = commits.flatMap((c) => c.commit.message.split("\n").filter(isTrailer));
  return {
    description: rest.filter((line) => !isTrailer(line)).join("\n").trim().slice(0, MAX_BODY_CHARS),
    trailers: trailers.map(cleanTrailer).filter(Boolean),
  };
}

function validEdits(edits) {
  const { title, body } = edits ?? {};
  if (typeof title !== "string" || typeof body !== "string") return null;
  if (title.length > MAX_TITLE_CHARS || body.length > MAX_BODY_CHARS) return null;
  return { title, body };
}

async function saveEdits(key, title, body) {
  const edits = validEdits({ title, body });
  const storageKey = SAVED_PREFIX + key;
  const entry = (await browser.storage.local.get(storageKey))[storageKey];
  if (!edits || !entry) return;
  await browser.storage.local.set({ [storageKey]: { ...entry, edits, savedAt: Date.now() } });
}

async function pruneSaved() {
  const all = await browser.storage.local.get(null);
  const old = Object.keys(all).filter((k) => k.startsWith(SAVED_PREFIX) && !(Date.now() - all[k]?.savedAt < SAVED_MAX_AGE));
  if (old.length) await browser.storage.local.remove(old);
}

class HostError extends Error {
  constructor({ message, status, request_id }) {
    super(String(message ?? "Unknown error."));
    this.status = status;
    this.requestId = request_id;
  }
}

async function callHost(message) {
  let reply;
  try {
    reply = await browser.runtime.sendNativeMessage(NATIVE_HOST, message);
  } catch (e) {
    const error = new Error(
      `Couldn't start the native helper (${e?.message ?? e}). Run \`python3 native/install.py\` from the extension's source directory, then restart Firefox.`,
    );
    error.needsSetup = true;
    throw error;
  }
  if (!reply?.ok) throw new HostError(reply?.error ?? {});
  return reply;
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Read-only: GET requests to api.github.com, no cookies. The manifest's CSP
// also limits the extension to connecting to api.github.com and api.anthropic.com.
async function githubFetch(url, token, accept = "application/vnd.github+json") {
  if (!url.startsWith("https://api.github.com/")) throw new Error("Refusing non-GitHub API URL.");
  const headers = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { method: "GET", headers, credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) {
    if (response.status === 404) throw new Error("GitHub API 404. Private repo? Set a GitHub token in the extension settings.");
    if (response.status === 403 || response.status === 429) {
      throw new Error("GitHub API rate limit or permission error. Setting a GitHub token raises the limit.");
    }
    throw new Error(`GitHub API error ${response.status}.`);
  }
  return response;
}

async function fetchCommits(gh, number) {
  const commits = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await (await gh(`/pulls/${number}/commits?per_page=100&page=${page}`)).json();
    commits.push(...batch);
    if (batch.length < 100) break;
  }
  return commits;
}

// From the base branch, so the PR can't supply its own guidelines.
async function fetchContributing(gh, baseRef) {
  for (const path of ["CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md"]) {
    try {
      const url = `/contents/${path}?ref=${encodeURIComponent(baseRef)}`;
      const text = await (await gh(url, "application/vnd.github.raw")).text();
      return text.slice(0, MAX_CONTRIBUTING_CHARS);
    } catch {
      // Try the next location.
    }
  }
  return null;
}

// Co-authored-by trailers from commit messages, plus authors of commits other
// than the PR author, who becomes the squash commit's author. The content script
// merges these with any trailers already in the commit form and dedupes by email.
async function coAuthorTrailers(api, pr, commits) {
  // Commits whose email isn't linked to an account have no login; match the
  // PR author by name instead.
  let prAuthorName = null;
  if (commits.some((c) => !c.author)) {
    try {
      prAuthorName = (await (await api(`/users/${encodeURIComponent(pr.user.login)}`)).json()).name;
    } catch {
      // Without the name, unlinked commits count as co-authored.
    }
  }
  const trailers = [];
  for (const c of commits) {
    for (const match of c.commit.message.matchAll(/^co-authored-by:.*$/gim)) trailers.push(match[0]);
    const login = c.author?.login;
    const { name, email } = c.commit.author ?? {};
    if (login === pr.user?.login || login?.endsWith("[bot]") || (prAuthorName && name === prAuthorName)) continue;
    if (name && email) trailers.push(`Co-authored-by: ${name} <${email}>`);
  }
  // Drop anything that isn't a well-formed "Name <email>" trailer.
  return [...new Set(trailers.map(cleanTrailer).filter(Boolean))];
}

function describeError(e) {
  if (e instanceof HostError && e.status) {
    // Include the API's own explanation (e.g. why a key was rejected).
    const hint =
      { 401: "Claude API key was rejected", 403: "Claude API permission denied", 404: "Claude API 404 (unknown model?)", 429: "Claude API rate limit hit" }[e.status] ??
      (e.status >= 500 ? "Claude API is having trouble" : "Claude API rejected the request");
    const id = e.requestId ? ` (request ID ${e.requestId})` : "";
    return `${hint} (${e.status}): ${e.message}${id}`;
  }
  return e?.message ?? String(e);
}
