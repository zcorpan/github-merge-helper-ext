"""Small AMO API client shared by release.py and amo_listing.py: the API
credentials from the macOS Keychain, HS256 JWT auth, and throttle handling."""

import base64
import hashlib
import hmac
import json
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ADDON = "github-merge-helper@zcorpan"
API = f"https://addons.mozilla.org/api/v5/addons/addon/{ADDON}/"
KEYCHAIN_SERVICE = "github-merge-helper-amo"
USER_AGENT = "github-merge-helper-ext release scripts"


def keychain(account):
    result = subprocess.run(
        ["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        sys.exit(f"No AMO {account} in the keychain (service {KEYCHAIN_SERVICE}). See RELEASING.md.")
    return result.stdout.strip()


def credentials():
    return keychain("jwt-issuer"), keychain("jwt-secret")


def _b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def jwt(issuer, secret):
    # AMO's API auth: HS256, a unique jti, and at most 5 minutes until exp.
    now = int(time.time())
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = _b64url(json.dumps({"iss": issuer, "jti": secrets.token_hex(16), "iat": now, "exp": now + 60}).encode())
    signature = hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
    return f"{header}.{payload}.{_b64url(signature)}"


class Client:
    """dry_run: print write requests instead of sending them (GETs still go out,
    unauthenticated if there are no credentials)."""

    def __init__(self, creds=None, dry_run=False):
        self.creds = creds
        self.dry_run = dry_run

    def request(self, method, url, body=None, content_type=None, missing_ok=False):
        print(f"{method} {url}" + (f" ({content_type.split(';')[0]}, {len(body)} bytes)" if body else ""), flush=True)
        if self.dry_run and method != "GET":
            return None
        headers = {"User-Agent": USER_AGENT}
        if content_type:
            headers["Content-Type"] = content_type
        for attempt in range(4):
            if self.creds:
                headers["Authorization"] = f"JWT {jwt(*self.creds)}"
            try:
                req = urllib.request.Request(url, data=body, method=method, headers=headers)
                with urllib.request.urlopen(req, timeout=120) as response:
                    data = response.read()
                return json.loads(data) if data else None
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors="replace")[:500]
                if e.code == 404 and missing_ok:
                    return None
                # AMO throttles API writes, sometimes for many minutes; wait for short ones only.
                wait = int(e.headers.get("Retry-After") or 60) + 2
                if e.code == 429 and attempt < 3 and wait <= 300:
                    print(f"Throttled; retrying in {wait} s", flush=True)
                    time.sleep(wait)
                    continue
                sys.exit(f"{e.code} from {method} {url}: {detail}")

    def json(self, method, url, value):
        return self.request(method, url, json.dumps(value).encode(), "application/json")

    def multipart(self, method, url, field, path, mime="image/png"):
        boundary = uuid.uuid4().hex
        body = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{path.name}\"\r\n"
            f"Content-Type: {mime}\r\n\r\n"
        ).encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
        return self.request(method, url, body, f"multipart/form-data; boundary={boundary}")

    def version(self, number):
        """The version as AMO has it, or None if AMO has no such version."""
        return self.request("GET", f"{API}versions/v{number}/", missing_ok=True)
