"""Sign a new version with AMO (unlisted) and publish it on GitHub Releases.

    python3 -I scripts/release.py [patch|minor|major]   (default: patch)

Firefox installs that have the extension pick up the new version through
`update_url` in manifest.json, which points at updates.json on main.

Needs AMO API credentials in the macOS Keychain (see README, "Releasing"),
`gh` logged in with push access, and a clean, up-to-date main.

Order matters: the signed .xpi is attached to the GitHub release before main
(with the new updates.json) is pushed, so updates.json never points at a file
that doesn't exist yet.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = "zcorpan/github-merge-helper-ext"
ADDON_ID = "github-merge-helper@zcorpan"
KEYCHAIN_SERVICE = "github-merge-helper-amo"
ARTIFACTS = ROOT / "web-ext-artifacts"


def run(*cmd, env=None, capture=False):
    print("+", " ".join(cmd), flush=True)
    result = subprocess.run(cmd, cwd=ROOT, env=env, check=True, text=True, capture_output=capture)
    return result.stdout.strip() if capture else None


def keychain(account):
    result = subprocess.run(
        ["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        sys.exit(f"No AMO {account} in the keychain (service {KEYCHAIN_SERVICE}). See README, \"Releasing\".")
    return result.stdout.strip()


def bumped(version, level):
    major, minor, patch = (int(part) for part in version.split("."))
    if level == "major":
        return f"{major + 1}.0.0"
    if level == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def check_clean_main():
    if run("git", "status", "--porcelain", capture=True):
        sys.exit("The working tree isn't clean; commit or stash first.")
    if run("git", "rev-parse", "--abbrev-ref", "HEAD", capture=True) != "main":
        sys.exit("Release from main.")
    run("git", "fetch", "-q", "origin")
    if run("git", "rev-list", "--count", "main..origin/main", capture=True) != "0":
        sys.exit("origin/main has commits that main doesn't; pull first.")


def release_notes(new):
    tags = run("git", "tag", "--list", "v*", "--sort=-v:refname", capture=True).split()
    previous = next((tag for tag in tags if tag != f"v{new}"), None)
    if not previous:
        return "First signed release."
    lines = run("git", "log", "--no-merges", "--pretty=format:- %s", f"{previous}..HEAD~1", capture=True)
    return lines or "Maintenance release."


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("level", nargs="?", choices=["patch", "minor", "major"], default="patch")
    args = parser.parse_args()

    check_clean_main()
    # Passed to web-ext through the environment, never on a command line.
    env = {**os.environ, "WEB_EXT_API_KEY": keychain("jwt-issuer"), "WEB_EXT_API_SECRET": keychain("jwt-secret")}

    manifest_path = ROOT / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    new = bumped(manifest["version"], args.level)
    print(f"Releasing {manifest['version']} -> {new}")

    try:
        manifest["version"] = new
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
        run("npm", "version", new, "--no-git-tag-version", "--allow-same-version")

        run("npm", "test")
        if (ROOT / "native" / ".venv" / "bin" / "python").exists():
            run("npm", "run", "test:native")
        run("npm", "run", "lint")

        run("npx", "web-ext", "sign", "--channel", "unlisted", "--source-dir", "dist", "--artifacts-dir", str(ARTIFACTS), env=env)
    except BaseException:
        # Nothing was published yet; undo the version bump.
        subprocess.run(["git", "checkout", "--", "manifest.json", "package.json", "package-lock.json"], cwd=ROOT, check=False)
        raise

    xpis = sorted(ARTIFACTS.glob(f"*-{new}.xpi"), key=lambda p: p.stat().st_mtime)
    if not xpis:
        sys.exit(f"web-ext sign didn't produce a {new} .xpi in {ARTIFACTS}.")
    xpi = xpis[-1]
    digest = hashlib.sha256(xpi.read_bytes()).hexdigest()
    updates = {
        "addons": {
            ADDON_ID: {
                "updates": [
                    {
                        "version": new,
                        "update_link": f"https://github.com/{REPO}/releases/download/v{new}/{xpi.name}",
                        "update_hash": f"sha256:{digest}",
                    }
                ]
            }
        }
    }
    (ROOT / "updates.json").write_text(json.dumps(updates, indent=2) + "\n")

    run("git", "add", "manifest.json", "package.json", "package-lock.json", "updates.json")
    run("git", "commit", "-q", "-m", f"Release {new}")
    run("git", "tag", "-a", f"v{new}", "-m", f"Version {new}")
    run("git", "push", "-q", "origin", f"v{new}")
    run("gh", "release", "create", f"v{new}", str(xpi), "--repo", REPO, "--title", new, "--notes", release_notes(new))
    run("git", "push", "-q", "origin", "main")
    print(f"Released {new}: https://github.com/{REPO}/releases/tag/v{new}")


if __name__ == "__main__":
    main()
