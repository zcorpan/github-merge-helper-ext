#!/usr/bin/env python3
"""Writes the source code package for AMO: every file git tracks, as it is in
the working tree (so a version bump that isn't committed yet is included).
There are no submodules. See BUILD.md and RELEASING.md.

Usage: python3 -I scripts/source-zip.py OUTPUT.zip
"""

import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_BYTES = 200 * 1024 * 1024  # AMO's limit for source packages


def main(output):
    files = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout.decode().split("\0")
    count = 0
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as z:
        for name in filter(None, files):
            path = ROOT / name
            if path.is_file():
                z.write(path, name)
                count += 1
    size = Path(output).stat().st_size
    if size > MAX_BYTES:
        sys.exit(f"{output} is {size} bytes, over AMO's 200 MB limit.")
    print(f"Wrote {output} ({count} files, {size} bytes)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
