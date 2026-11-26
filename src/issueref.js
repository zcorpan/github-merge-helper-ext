// Fixes up GitHub URLs pasted from text, from the URL alone (no page needed):
// - github.com/owner/repo#91 goes to github.com/owner/repo/issues/91 (which
//   GitHub redirects to /pull/91 for PRs);
// - github.com/owner/repo@1a2b3c4 goes to github.com/owner/repo/commit/1a2b3c4;
// - punctuation copied along with a URL is dropped: owner/repo#91, or
//   owner/repo. or owner/repo/pull/91). or owner/repo/commit/1a2b3c4. (GitHub
//   has nothing at those URLs).

// Characters that end a sentence or close a bracket, quote, or Markdown span.
const PUNCT = "[.,;:!?)\\]}>'\"’”»…*_`]{1,8}";
// The same after a repository name or number, minus "_", which repository
// names can end with.
const PATH_PUNCT = "[.,;:!?)\\]}>'\"’”»…*`]{1,8}";
const OWNER = "[A-Za-z0-9-]{1,39}";
const REPO = "[A-Za-z0-9._-]{1,100}?";
const REPO_ROOT = new RegExp(`^/(${OWNER})/(${REPO})(${PATH_PUNCT})?/?$`, "u");
// GitHub itself redirects /pull/91. to /pull/new/91. (signed out) or
// /compare/91.?expand=1 (signed in), and /issues/91. to /issues/created_by/91.
const NUMBERED = new RegExp(
  `^/(${OWNER})/(${REPO})/(issues|issues/created_by|pull|pull/new|compare)/([1-9][0-9]{0,8})${PATH_PUNCT}$`,
  "u",
);
const KIND = { issues: "issues", "issues/created_by": "issues", pull: "pull", "pull/new": "pull", compare: "pull" };
// owner/repo@sha (GitHub's commit reference syntax) or a commit URL. GitHub
// finds commits by 7 or more hex digits.
const COMMIT = new RegExp(`^/(${OWNER})/(${REPO})(@|/commit/)([0-9a-fA-F]{7,64})(${PATH_PUNCT})?$`, "u");
const ISSUE_HASH = new RegExp(`^#([1-9][0-9]{0,8})(?:${PUNCT})?$`, "u");

// GitHub's own top-level pages; no user or organization has these names.
const RESERVED = new Set(
  ("about account apps blog codespaces collections contact copilot customer-stories dashboard discussions enterprise " +
    "enterprises events explore features github-copilot issues login logout marketplace new notifications orgs " +
    "organizations partners pricing pulls readme repos resources search security sessions settings signup site " +
    "solutions sponsors stars team topics trending users watching").split(" "),
);

// The URL (path, query, and hash) to go to instead, or null.
export function fixedUrl(pathname, search, hash) {
  let path, fragment;
  try {
    path = decodeURIComponent(pathname);
    fragment = decodeURIComponent(hash);
  } catch {
    return null;
  }
  const numbered = NUMBERED.exec(path);
  if (numbered) {
    const [, owner, repo, kind, number] = numbered;
    if (RESERVED.has(owner.toLowerCase())) return null;
    // The query on GitHub's redirect targets is GitHub's (?expand=1), not the pasted URL's.
    const query = KIND[kind] === kind ? search : "";
    return `/${owner}/${repo}/${KIND[kind]}/${number}${query}${hash}`;
  }
  const commit = COMMIT.exec(path);
  if (commit) {
    const [, owner, repo, sep, sha, punct] = commit;
    if (RESERVED.has(owner.toLowerCase()) || (sep !== "@" && !punct)) return null;
    return `/${owner}/${repo}/commit/${sha}${search}${hash}`;
  }
  const root = REPO_ROOT.exec(path);
  if (!root || RESERVED.has(root[1].toLowerCase())) return null;
  const [, owner, repo, punct] = root;
  const issue = ISSUE_HASH.exec(fragment)?.[1];
  if (issue) return `/${owner}/${repo}/issues/${issue}`;
  return punct ? `/${owner}/${repo}${search}${hash}` : null;
}
