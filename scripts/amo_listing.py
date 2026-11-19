#!/usr/bin/env python3
"""Uploads the parts of the AMO listing that `web-ext sign --amo-metadata`
can't set: the privacy policy, the icon, and the screenshots (all from amo/).
Run it when one of them changes. See RELEASING.md.

    python3 -I scripts/amo_listing.py [--dry-run]

Uses the same AMO API credentials from the macOS Keychain as release.py.
Screenshots are replaced: existing ones are deleted, then amo/screenshot-*.png
are uploaded in name order.
"""

import argparse
import base64
import hashlib
import hmac
import json
import secrets
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AMO = ROOT / "amo"
ADDON = "github-merge-helper@zcorpan"
API = f"https://addons.mozilla.org/api/v5/addons/addon/{ADDON}/"
KEYCHAIN_SERVICE = "github-merge-helper-amo"


def keychain(account):
    result = subprocess.run(
        ["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        sys.exit(f"No AMO {account} in the keychain (service {KEYCHAIN_SERVICE}). See README, \"Releasing\".")
    return result.stdout.strip()


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def jwt(issuer, secret):
    # AMO's API auth: HS256, a unique jti, and at most 5 minutes until exp.
    now = int(time.time())
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = b64url(json.dumps({"iss": issuer, "jti": secrets.token_hex(16), "iat": now, "exp": now + 60}).encode())
    signature = hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
    return f"{header}.{payload}.{b64url(signature)}"


class Client:
    def __init__(self, dry_run):
        self.dry_run = dry_run
        self.credentials = None if dry_run else (keychain("jwt-issuer"), keychain("jwt-secret"))

    def request(self, method, url, body=None, content_type=None):
        print(f"{method} {url}" + (f" ({content_type}, {len(body)} bytes)" if body else ""))
        if self.dry_run and method != "GET":
            return None
        headers = {"Authorization": f"JWT {jwt(*self.credentials)}"} if self.credentials else {}
        if content_type:
            headers["Content-Type"] = content_type
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        with urllib.request.urlopen(req) as response:
            data = response.read()
        return json.loads(data) if data else None

    def json(self, method, url, value):
        return self.request(method, url, json.dumps(value).encode(), "application/json")

    def multipart(self, method, url, field, path):
        boundary = uuid.uuid4().hex
        body = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{path.name}\"\r\n"
            f"Content-Type: image/png\r\n\r\n"
        ).encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
        return self.request(method, url, body, f"multipart/form-data; boundary={boundary}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="print the requests without sending changes")
    args = parser.parse_args()
    client = Client(args.dry_run)

    policy = (AMO / "privacy-policy.md").read_text().strip()
    client.json("PATCH", API + "eula_policy/", {"privacy_policy": {"en-US": policy}})
    client.multipart("PATCH", API, "icon", AMO / "icon-128.png")

    existing = [] if args.dry_run else (client.request("GET", API) or {}).get("previews", [])
    for preview in existing:
        client.request("DELETE", f"{API}previews/{preview['id']}/")
    for path in sorted(AMO.glob("screenshot-*.png")):
        client.multipart("POST", API + "previews/", "image", path)
    print("Done." if not args.dry_run else "Dry run; nothing sent.")


if __name__ == "__main__":
    main()
