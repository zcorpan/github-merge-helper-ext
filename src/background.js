import Anthropic from "@anthropic-ai/sdk";
import { OUTPUT_SCHEMA, buildSystemPrompt, buildUserMessage, cleanDescription, repoRules } from "./rules.js";
import { cleanSuggestion, cleanTrailer, extractRefs, stripInvisible, validPullRef } from "./safety.js";
import { DEFAULTS } from "./defaults.js";

const MAX_DIFF_CHARS = 300_000;
const MAX_CONTRIBUTING_CHARS = 30_000;

// Keyed by "owner/repo#number"; reused while the PR head is unchanged.
const cache = new Map();

browser.runtime.onMessage.addListener((message, sender) => {
  // Only our own content script on github.com may ask.
  if (sender.id !== browser.runtime.id || !sender.tab?.url?.startsWith("https://github.com/")) return undefined;
  if (message?.type === "openOptions") return browser.runtime.openOptionsPage();
  if (message?.type === "suggest") {
    const { owner, repo, number, force } = message;
    if (!validPullRef(owner, repo, number)) return Promise.resolve({ error: "Invalid pull request reference." });
    return suggest({ owner, repo, number, force: force === true }).catch((e) => ({ error: describeError(e) }));
  }
  return undefined;
});

async function suggest({ owner, repo, number, force }) {
  const settings = { ...DEFAULTS, ...(await browser.storage.local.get(null)) };
  if (!settings.apiKey) return { error: "No Claude API key set.", needsSettings: true };

  const api = (path, accept) => githubFetch(`https://api.github.com${path}`, settings.githubToken, accept);
  const gh = (path, accept) => api(`/repos/${owner}/${repo}${path}`, accept);
  const pr = await (await gh(`/pulls/${number}`)).json();
  const key = `${owner}/${repo}#${number}`;
  const cached = cache.get(key);
  if (!force && cached?.headSha === pr.head.sha) return cached.response;

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
  // ever shown as text or put in GitHub's commit form for you to confirm.
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const response = await client.beta.messages.create({
    model: settings.model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: settings.effort, format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    system: buildSystemPrompt({ owner, repo, contributing, extraInstructions: settings.extraInstructions, boundary }),
    messages: [
      { role: "user", content: buildUserMessage({ owner, repo, pr, commits, diff, diffTruncated, mode, boundary }) },
    ],
  });

  if (response.stop_reason === "refusal") {
    return { error: `Claude declined the request (${response.stop_details?.category ?? "no category"}).` };
  }
  if (response.stop_reason === "max_tokens") return { error: "Claude's response was cut off (max_tokens)." };
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try {
    parsed = JSON.parse(text);
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
  return result;
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
  if (e instanceof Anthropic.AuthenticationError) return "Claude API key was rejected (401). Check the extension settings.";
  if (e instanceof Anthropic.PermissionDeniedError) return `Claude API permission denied: ${e.message}`;
  if (e instanceof Anthropic.NotFoundError) return `Claude API 404 (unknown model?): ${e.message}`;
  if (e instanceof Anthropic.RateLimitError) return "Claude API rate limit hit. Try again shortly.";
  if (e instanceof Anthropic.BadRequestError) return `Claude API rejected the request: ${e.message}`;
  if (e instanceof Anthropic.InternalServerError) return `Claude API is having trouble (${e.status}). Try again shortly.`;
  if (e instanceof Anthropic.APIConnectionError) return "Couldn't reach the Claude API.";
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status ?? ""}: ${e.message}`;
  return e?.message ?? String(e);
}
