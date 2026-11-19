// Turns github.com/owner/repo#91 into github.com/owner/repo/issues/91 (which
// GitHub redirects to /pull/91 for PRs). Only on a repository's front page,
// and not when the hash is a README heading like "## 2024". Punctuation copied
// along with the reference ("owner/repo#91," or "#91).") is ignored.

const REPO_ROOT = /^\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/?$/;
const ISSUE_HASH = /^#([1-9][0-9]{0,8})([.,;:!?)\]}>'"’”»…*_`]{0,8})$/u;
const NWO = 'meta[name="octolytics-dimension-repository_nwo"]';
// GitHub's page data, which has the README's HTML well before the README
// itself is in the page.
const PAGE_DATA = 'script[data-target="react-app.embeddedData"]';

// The issue reference in a repository front page URL, or null. exact: the hash
// is only digits, so it could also be a README heading.
export function parseIssueRef(pathname, hash) {
  const path = REPO_ROOT.exec(pathname);
  if (!path) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(hash);
  } catch {
    return null;
  }
  const match = ISSUE_HASH.exec(decoded);
  if (!match) return null;
  return { owner: path[1], repo: path[2], number: match[1], exact: match[2] === "" };
}

// What to do with the document parsed so far: the path to go to, null to stay,
// or undefined if it can't tell yet. complete: the document is fully parsed.
export function issueRefVerdict(ref, doc, complete) {
  // GitHub's own marker for repository pages; rules out /orgs/name and such.
  // It's in <head>, so once there's a <body> it isn't coming.
  const meta = doc.querySelector(NWO);
  if (!meta) return complete || doc.body ? null : undefined;
  if (meta.content?.toLowerCase() !== `${ref.owner}/${ref.repo}`.toLowerCase()) return null;
  const path = `/${ref.owner}/${ref.repo}/issues/${ref.number}`;
  // GitHub's heading anchors never end in punctuation.
  if (!ref.exact) return path;
  if (doc.getElementById(`user-content-${ref.number}`) || doc.getElementById(ref.number)) return null;
  const data = doc.querySelector(PAGE_DATA);
  if (data && (complete || parsedPast(data))) {
    const heading = readmeHasAnchor(data.textContent, ref.number);
    if (heading !== null) return heading ? null : path;
  }
  return complete ? path : undefined;
}

// Returns the path to go to from a fully parsed document, or null.
export function issueRefPath(pathname, hash, doc) {
  const ref = parseIssueRef(pathname, hash);
  return ref ? issueRefVerdict(ref, doc, true) : null;
}

// Whether the parser is done with the element (it has added something after it).
function parsedPast(el) {
  for (let node = el; node && node !== node.ownerDocument?.body; node = node.parentNode) {
    if (node.nextSibling) return true;
  }
  return false;
}

// Whether the README (or another overview file) in GitHub's page data has a
// heading with this anchor, or null if the data doesn't have the files.
function readmeHasAnchor(json, number) {
  let files;
  try {
    files = JSON.parse(json)?.payload?.codeViewRepoRoute?.overview?.overviewFiles;
  } catch {
    return null;
  }
  if (!Array.isArray(files)) return null;
  return files.some((file) => typeof file?.richText === "string" && file.richText.includes(`id="user-content-${number}"`));
}
