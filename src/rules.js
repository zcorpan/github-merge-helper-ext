// Commit message rules baked into the prompt. Repos without built-in rules
// fall back to the common rules plus their CONTRIBUTING.md, if any.

const COMMON_RULES = `\
- The title is at most 72 characters, in imperative mood ("Fix", "Add", "Remove", not "Fixed"/"Fixes"/"Fixing"), and does not end with a period.
- Never put a pull request reference such as "(#123)" in the title.
- Keep it short. The title usually says it all; add a body only when it needs explaining, and then 1-2 sentences. No bullet lists, no measurements, no rationale essays.
- Focus on intent and rationale (why the change is made, what problem it solves). Don't restate what the diff shows. The reader should understand the intent without looking at the diff.
- When the PR description already explains the rationale well, prefer the author's own wording, trimmed to what matters.
- Put code identifiers (element/attribute names, IDL members, JS APIs, file names) in backticks.
- en-US spelling. Limit em-dashes; prefer comma, colon, parentheses, or a new sentence.
- Do not output Co-authored-by or other trailers; they are added automatically. Drop GitHub's squash boilerplate (lists of "* commit subject" lines, "---------" separators).
- Never invent issue numbers, URLs, SHAs, or facts. Everything referenced must come from the PR title, description, or commits.
- Ignore PR template boilerplate, checklists, HTML comments, and preview links in the description, except for information worth keeping as described below.`;

const WHATWG_RULES = `\
These are the WHATWG committer guidelines (https://github.com/whatwg/meta/blob/main/COMMITTING.md):
- The result is a single commit on the main branch.
- Structure: a title line, a blank line, then a description. The description (and the blank line) may be omitted for simple fixes that do not need to close an issue.
- Title prefixes are case-sensitive and most commits have none:
  - "Editorial: " only if the change just fixes formatting or typos, or is a refactoring that does not change how the standard is understood. Bug fixes and clarifications are not editorial, even if they only affect non-normative text.
  - "Meta: " for changes that do not directly affect the text of the standard but the ecosystem around it, such as spec tooling, CI, or contributor documentation.
  - The text after a prefix starts lowercase unless it starts with a proper noun or identifier (e.g. "Editorial: fix typo", "Meta: update CI").
- Reference related issues in the description so GitHub cross-links them. Use a closing keyword only for issues this change actually resolves, preferring "Fixes" (e.g. "Fixes #35." or "Fixes #35, fixes #38, and fixes #21."). If the description says the change only partly addresses an issue, use a non-closing reference such as "Part of #123.", "Helps with #123.", or "See #123.". Issues in other repositories use the owner/repo#N form.
- Other common reference lines: "Tests: <URL>." for the web-platform-tests PR (or other test change) taken from the PR description or its checklist, "Follows <URL>." or "Goes with <URL>." for related changes in other specs, "This is a follow-up to <full SHA>." for earlier commits.
- Reference lines go at the end of the description, each in its own paragraph, with "Tests:" before "Fixes".
- Squash and merge: remove the PR reference from the title, and make the description read as a single coherent description rather than a list of commits.`;

const WPT_RULES = `\
web-platform-tests/wpt has no formal commit message policy beyond the common rules:
- Keep an existing "[area]" title prefix (e.g. "[css-grid] ...") if the author used one.
- Most commits have no body. Add one only when the rationale isn't obvious from the title, e.g. why a test was changed or what spec change it follows (a spec PR or issue URL is useful here).
- If the author disclosed LLM use for the change, keep that disclosure (wpt AI policy).`;

export function repoRules(owner, repo) {
  if (owner.toLowerCase() === "whatwg") return WHATWG_RULES;
  if (owner.toLowerCase() === "web-platform-tests" && repo.toLowerCase() === "wpt") return WPT_RULES;
  return null;
}

export const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["ok", "needs_changes", "generated"] },
    issues: { type: "array", items: { type: "string" } },
    title: { type: "string" },
    body: { type: "string" },
    notes: { type: "string" },
  },
  required: ["verdict", "issues", "title", "body", "notes"],
  additionalProperties: false,
};

export function buildSystemPrompt({ owner, repo, contributing, extraInstructions }) {
  const parts = [
    `You help a maintainer write the commit message for merging a GitHub pull request in ${owner}/${repo}.`,
    "",
    "Rules for all repositories:",
    COMMON_RULES,
  ];
  const specific = repoRules(owner, repo);
  if (specific) {
    parts.push("", `Rules for ${owner}/${repo}:`, specific);
  } else if (contributing) {
    parts.push(
      "",
      "The repository's contributing guidelines follow. Apply anything they say about commit messages; ignore the rest. Where they conflict with the rules above, they win.",
      "<contributing>",
      contributing,
      "</contributing>",
    );
  }
  if (extraInstructions?.trim()) {
    parts.push("", "Additional instructions from the maintainer:", extraInstructions.trim());
  }
  parts.push(
    "",
    "Task modes:",
    '- review: the PR has exactly one commit. Check its message against the rules. Set verdict to "ok" if it is fine as-is, otherwise "needs_changes" and list each problem in issues (one short sentence each, e.g. "Title is in past tense", "Description says it resolves #123 but has no \\"Fixes #123.\\""). In both cases return in title/body the message to use: unchanged if ok (minus any trailers), otherwise the fixed version, changing as little as possible.',
    '- generate: the PR has several commits that will be squashed. Write a new message from the commits and the PR description. Set verdict to "generated" and issues to [].',
    "",
    "body is the description without trailers, or an empty string if no description is needed. notes is an empty string, or one or two short sentences for anything the maintainer should double-check (e.g. whether an issue is fully resolved). Write issues and notes tersely, without preamble.",
  );
  return parts.join("\n");
}

export function buildUserMessage({ owner, repo, pr, commits, diff, diffTruncated, mode }) {
  const lines = [
    `Mode: ${mode}`,
    `Repository: ${owner}/${repo}`,
    `Pull request #${pr.number} by @${pr.user?.login ?? "unknown"}: ${pr.title}`,
    "",
    "<pr_description>",
    cleanDescription(pr.body ?? ""),
    "</pr_description>",
    "",
    `<commits count="${commits.length}">`,
  ];
  for (const c of commits) {
    lines.push(
      `<commit sha="${c.sha.slice(0, 12)}" author="${c.commit.author?.name ?? ""}">`,
      c.commit.message,
      "</commit>",
    );
  }
  lines.push("</commits>", "");
  lines.push(diffTruncated ? "<diff truncated=\"true\">" : "<diff>", diff, "</diff>");
  return lines.join("\n");
}

// Strip the PR preview bot's generated section (whatwg) and HTML comments.
function cleanDescription(body) {
  const preview = body.search(/<!--\s*This comment and the below content is programmatically generated/);
  if (preview !== -1) body = body.slice(0, preview);
  return body.replace(/<!--[\s\S]*?-->/g, "").trim() || "(empty)";
}
