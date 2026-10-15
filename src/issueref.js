// Turns github.com/owner/repo#91 into github.com/owner/repo/issues/91 (which
// GitHub redirects to /pull/91 for PRs). Only on a repository's front page,
// and not when the hash is a README heading like "## 2024".

const REPO_ROOT = /^\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/?$/;
const ISSUE_HASH = /^#([1-9][0-9]{0,8})$/;

// Returns the path to go to, or null.
export function issueRefPath(pathname, hash, doc) {
  const path = REPO_ROOT.exec(pathname);
  const number = ISSUE_HASH.exec(hash)?.[1];
  if (!path || !number) return null;
  const [, owner, repo] = path;
  // GitHub's own marker for repository pages; rules out /orgs/name and such.
  const nwo = doc.querySelector('meta[name="octolytics-dimension-repository_nwo"]')?.content;
  if (nwo?.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) return null;
  if (doc.getElementById(`user-content-${number}`) || doc.getElementById(number)) return null;
  return `/${owner}/${repo}/issues/${number}`;
}
