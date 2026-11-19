"""Submit a new version to AMO (listed) and publish release notes on GitHub.

    python3 -I scripts/release.py [patch|minor|major]   (default: patch)

Bumps the version, runs the tests and lint, commits "Release X.Y.Z", then
submits dist/ with the source package (scripts/source-zip.py) and the listing
metadata (amo/listing.json, with the source commit added to the reviewer
notes) to AMO's listed channel. AMO reviews it and installs update from AMO.
It doesn't wait for approval. Then it tags, pushes, and creates a GitHub
release with the notes. See RELEASING.md.

Needs AMO API credentials in the macOS Keychain (see README, "Releasing"),
`gh` logged in with push access, and a clean, up-to-date main.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = "zcorpan/github-merge-helper-ext"
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
    ARTIFACTS.mkdir(exist_ok=True)
    source = ARTIFACTS / f"github-merge-helper-source-{new}.zip"

    committed = False
    try:
        manifest["version"] = new
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
        run("npm", "version", new, "--no-git-tag-version", "--allow-same-version")

        run("npm", "test")
        if (ROOT / "native" / ".venv" / "bin" / "python").exists():
            run("npm", "run", "test:native")
        run("npm", "run", "lint")

        # Commit first, so the source package and the reviewer notes name an exact commit.
        run("git", "add", "manifest.json", "package.json", "package-lock.json")
        run("git", "commit", "-q", "-m", f"Release {new}")
        committed = True
        commit = run("git", "rev-parse", "HEAD", capture=True)
        run(sys.executable, "-I", str(ROOT / "scripts" / "source-zip.py"), str(source))

        metadata = json.loads((ROOT / "amo" / "listing.json").read_text())
        metadata["version"]["approval_notes"] += (
            f"\n\nThis version's source: commit {commit} (https://github.com/{REPO}/commit/{commit}), tag v{new}."
        )
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(metadata, f)
        run(
            "npx", "web-ext", "sign", "--channel", "listed", "--approval-timeout", "0",
            "--source-dir", "dist", "--artifacts-dir", str(ARTIFACTS),
            "--amo-metadata", f.name, "--upload-source-code", str(source),
            env=env,
        )
    except BaseException:
        # Nothing was submitted (or the submission failed); undo the release commit and the version bump.
        if committed:
            subprocess.run(["git", "reset", "-q", "--soft", "HEAD~1"], cwd=ROOT, check=False)
            subprocess.run(["git", "restore", "--staged", "manifest.json", "package.json", "package-lock.json"], cwd=ROOT, check=False)
        subprocess.run(["git", "checkout", "--", "manifest.json", "package.json", "package-lock.json"], cwd=ROOT, check=False)
        raise

    run("git", "tag", "-a", f"v{new}", "-m", f"Version {new}")
    run("git", "push", "-q", "origin", f"v{new}")
    run("gh", "release", "create", f"v{new}", "--repo", REPO, "--title", new, "--notes", release_notes(new))
    run("git", "push", "-q", "origin", "main")
    print(f"Submitted {new} to AMO: https://addons.mozilla.org/en-US/developers/addon/github-merge-helper/versions")


if __name__ == "__main__":
    main()
