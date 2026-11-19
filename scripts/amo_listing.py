#!/usr/bin/env python3
"""Uploads the parts of the AMO listing that `web-ext sign --amo-metadata`
can't set: the privacy policy, the icon, and the screenshots (all from amo/).
Run it when one of them changes. See RELEASING.md.

    python3 -I scripts/amo_listing.py [--dry-run] [policy] [icon] [screenshots]

Uses the AMO API credentials in the macOS Keychain. Screenshots are replaced:
existing ones are deleted, then amo/screenshot-*.png are uploaded in name
order. AMO throttles writes, sometimes for many minutes; if it says to wait
longer than 5 minutes, this stops, and you can rerun it later with only the
parts that are left.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from amo_api import API, Client, credentials  # noqa: E402

AMO = Path(__file__).resolve().parent.parent / "amo"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="print the write requests without sending them")
    parser.add_argument("parts", nargs="*", choices=["policy", "icon", "screenshots"], help="what to upload (default: all)")
    args = parser.parse_args()
    parts = set(args.parts or ["policy", "icon", "screenshots"])
    client = Client(None if args.dry_run else credentials(), dry_run=args.dry_run)

    if "policy" in parts:
        policy = (AMO / "privacy-policy.md").read_text().strip()
        current = None if args.dry_run else ((client.request("GET", API + "eula_policy/") or {}).get("privacy_policy") or {}).get("en-US")
        if current == policy:
            print("Privacy policy unchanged.")
        else:
            client.json("PATCH", API + "eula_policy/", {"privacy_policy": {"en-US": policy}})
    if "icon" in parts:
        client.multipart("PATCH", API, "icon", AMO / "icon-128.png")
    if "screenshots" in parts:
        existing = [] if args.dry_run else (client.request("GET", API) or {}).get("previews", [])
        for preview in existing:
            client.request("DELETE", f"{API}previews/{preview['id']}/")
        for path in sorted(AMO.glob("screenshot-*.png")):
            client.multipart("POST", API + "previews/", "image", path)
    print("Dry run; nothing sent." if args.dry_run else "Done.")


if __name__ == "__main__":
    main()
