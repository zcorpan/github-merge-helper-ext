import Anthropic from "@anthropic-ai/sdk";
import { OUTPUT_SCHEMA, buildSystemPrompt, buildUserMessage, repoRules } from "./rules.js";
import { DEFAULTS } from "./defaults.js";

const MAX_DIFF_CHARS = 300_000;
const MAX_CONTRIBUTING_CHARS = 30_000;

// Keyed by "owner/repo#number"; reused while the PR head is unchanged.
const cache = new Map();

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "openOptions") return browser.runtime.openOptionsPage();
  if (message?.type === "suggest") {
    return suggest(message).catch((e) => ({ error: describeError(e) }));
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
    repoRules(owner, repo) ? null : fetchContributing(gh),
  ]);
  const diffTruncated = diffText.length > MAX_DIFF_CHARS;
  const diff = diffTruncated ? diffText.slice(0, MAX_DIFF_CHARS) : diffText;
  const mode = commits.length === 1 ? "review" : "generate";

  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const response = await client.beta.messages.create({
    model: settings.model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: settings.effort, format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    system: buildSystemPrompt({ owner, repo, contributing, extraInstructions: settings.extraInstructions }),
    messages: [
      { role: "user", content: buildUserMessage({ owner, repo, pr, commits, diff, diffTruncated, mode }) },
    ],
  });

  if (response.stop_reason === "refusal") {
    return { error: `Claude declined the request (${response.stop_details?.category ?? "no category"}).` };
  }
  if (response.stop_reason === "max_tokens") return { error: "Claude's response was cut off (max_tokens)." };
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let suggestion;
  try {
    suggestion = JSON.parse(text);
  } catch {
    return { error: "Claude returned malformed JSON." };
  }

  const result = {
    suggestion,
    mode,
    commitCount: commits.length,
    trailers: await coAuthorTrailers(api, pr, commits),
    diffTruncated,
    model: response.model,
  };
  cache.set(key, { headSha: pr.head.sha, response: result });
  return result;
}

async function githubFetch(url, token, accept = "application/vnd.github+json") {
  const headers = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    if (response.status === 404) throw new Error(`GitHub API 404 for ${url}. Private repo? Set a GitHub token in the extension settings.`);
    if (response.status === 403 || response.status === 429) {
      throw new Error("GitHub API rate limit or permission error. Setting a GitHub token raises the limit.");
    }
    throw new Error(`GitHub API ${response.status} for ${url}`);
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

async function fetchContributing(gh) {
  for (const path of ["CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md"]) {
    try {
      const text = await (await gh(`/contents/${path}`, "application/vnd.github.raw")).text();
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
      prAuthorName = (await (await api(`/users/${pr.user.login}`)).json()).name;
    } catch {
      // Without the name, unlinked commits count as co-authored.
    }
  }
  const trailers = [];
  for (const c of commits) {
    for (const match of c.commit.message.matchAll(/^co-authored-by:\s*(.+)$/gim)) {
      trailers.push(`Co-authored-by: ${match[1].trim()}`);
    }
    const login = c.author?.login;
    const { name, email } = c.commit.author ?? {};
    if (login === pr.user?.login || login?.endsWith("[bot]") || (prAuthorName && name === prAuthorName)) continue;
    if (name && email) trailers.push(`Co-authored-by: ${name} <${email}>`);
  }
  return trailers;
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
