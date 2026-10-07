"""Install the native messaging host for the GitHub Merge Helper extension.

    python3 native/install.py             # install (asks for the key if none is stored)
    python3 native/install.py --set-key   # replace the stored key
    python3 native/install.py --uninstall # remove the host manifest and the stored key

Creates a virtualenv in native/.venv with the pinned `anthropic` package,
a launcher script, and the Firefox host manifest that lets only this
extension start the host. The key goes in the macOS Keychain (or the Secret
Service keyring on Linux, via `secret-tool`), entered at the keychain tool's
own prompt so it never appears in shell history or process arguments.
"""

import argparse
import json
import os
import shlex
import stat
import subprocess
import sys
from pathlib import Path

HOST_NAME = "github_merge_helper"
EXTENSION_ID = "github-merge-helper@zcorpan"
KEYCHAIN_SERVICE = "github-merge-helper"
KEYCHAIN_ACCOUNT = "anthropic-api-key"

NATIVE_DIR = Path(__file__).resolve().parent
VENV_DIR = NATIVE_DIR / ".venv"
LAUNCHER = NATIVE_DIR / ".venv" / "github-merge-helper-host"


def manifest_dir():
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Mozilla" / "NativeMessagingHosts"
    if sys.platform.startswith("linux"):
        return Path.home() / ".mozilla" / "native-messaging-hosts"
    sys.exit("Only macOS and Linux are supported.")


def has_key():
    if sys.platform == "darwin":
        command = ["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]
    else:
        command = ["/usr/bin/secret-tool", "lookup", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT]
    return subprocess.run(command, capture_output=True, check=False).returncode == 0


def set_key():
    print("Paste your Claude API key (from https://platform.claude.com/settings/keys) at the prompt.")
    if sys.platform == "darwin":
        # `-w` as the last argument makes `security` prompt for the value.
        command = ["/usr/bin/security", "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-l", "GitHub Merge Helper: Claude API key", "-w"]
    else:
        command = ["/usr/bin/secret-tool", "store", "--label=GitHub Merge Helper: Claude API key", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT]
    subprocess.run(command, check=True)
    print("Key stored.")


def delete_key():
    if sys.platform == "darwin":
        command = ["/usr/bin/security", "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]
    else:
        command = ["/usr/bin/secret-tool", "clear", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT]
    subprocess.run(command, capture_output=True, check=False)


def install():
    if not VENV_DIR.exists():
        print(f"Creating virtualenv in {VENV_DIR}")
        subprocess.run([sys.executable, "-m", "venv", str(VENV_DIR)], check=True)
    python = VENV_DIR / "bin" / "python"
    # Exact versions, and wheels only so no package build code runs at install time.
    subprocess.run(
        [str(python), "-I", "-m", "pip", "install", "--quiet", "--only-binary=:all:", "-r", str(NATIVE_DIR / "requirements.txt")],
        check=True,
    )

    # -I: isolated mode, ignoring PYTHON* environment variables and not putting
    # the script's directory first on sys.path.
    LAUNCHER.write_text(f"#!/bin/sh\nexec {shlex.quote(str(python))} -I {shlex.quote(str(NATIVE_DIR / 'host.py'))}\n")
    LAUNCHER.chmod(stat.S_IRWXU)

    directory = manifest_dir()
    directory.mkdir(parents=True, exist_ok=True)
    manifest = {
        "name": HOST_NAME,
        "description": "GitHub Merge Helper: calls the Claude API",
        "path": str(LAUNCHER),
        "type": "stdio",
        "allowed_extensions": [EXTENSION_ID],
    }
    path = directory / f"{HOST_NAME}.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Wrote {path}")

    if not has_key():
        set_key()
    print("Done. In the extension's options (about:addons, … menu), click “Test connection”.")


def uninstall():
    path = manifest_dir() / f"{HOST_NAME}.json"
    if path.exists():
        path.unlink()
        print(f"Removed {path}")
    delete_key()
    print(f"Removed the stored key. You can also delete {VENV_DIR}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--set-key", action="store_true", help="store or replace the Claude API key")
    group.add_argument("--uninstall", action="store_true", help="remove the host manifest and the stored key")
    args = parser.parse_args()
    if os.geteuid() == 0:
        sys.exit("Run this as your normal user, not root.")
    if args.uninstall:
        uninstall()
    elif args.set_key:
        set_key()
    else:
        install()


if __name__ == "__main__":
    main()
