# Releasing to AMO

The add-on is listed on AMO: https://addons.mozilla.org/firefox/addon/github-merge-helper-ext/ (add-on ID `github-merge-helper@zcorpan`). Installs update from AMO. Every version is reviewed there, and its source package is uploaded with it, since `dist/` is bundled (see [BUILD.md](BUILD.md)).

## One-time setup

AMO API credentials from https://addons.mozilla.org/developers/addon/api/key/, stored in the macOS Keychain (each command prompts for the value; the keys are per account, so they're shared with other add-ons):

```sh
security add-generic-password -U -s github-merge-helper-amo -a jwt-issuer -w
security add-generic-password -U -s github-merge-helper-amo -a jwt-secret -w
```

## Each release

On a clean, up-to-date `main`:

```sh
npm run release            # patch; or: npm run release -- minor
```

[`scripts/release.py`](scripts/release.py):

1. bumps `version` in `manifest.json` and `package.json`;
2. runs `npm test`, `npm run test:native`, and `npm run lint` (AMO-hosted rules; expect 0 errors and 0 warnings);
3. commits "Release X.Y.Z";
4. writes the source package (`scripts/source-zip.py`, every tracked file) to `web-ext-artifacts/`;
5. submits `dist/` to the listed channel with `web-ext sign`, along with the source package and `amo/listing.json` (summary, description, categories, license, reviewer notes, plus the source commit);
6. tags, pushes, and creates a GitHub release with the notes.

It doesn't wait for review, so it may take a while before the version shows up on AMO. The version must be higher than any AMO has seen, including rejected ones; for a release in between, use a fourth component (`0.4.0.1`). If submission fails, the script asks AMO whether it got the version anyway. If not, it undoes the release commit and the version bump; if so, the number is used up, so it keeps the commit and prints the commands to finish by hand.

AMO throttles API writes, sometimes for many minutes. The scripts wait out short throttles and stop on long ones (it says how long); rerun later.

Before submitting, check the package contents:

```sh
npm run build && npx web-ext build -s dist --overwrite-dest && unzip -l web-ext-artifacts/github_merge_helper-*.zip
```

To check that the source package rebuilds the submission: unzip it in an empty directory, run `npm ci && npm run build`, and `diff -r dist <repo>/dist`.

## Listing

`amo/listing.json` goes with every submission. The privacy policy (`amo/privacy-policy.md`), the icon (`amo/icon-128.png`, rendered from `src/icon.svg`), and the screenshots (`amo/screenshot-*.png`) are uploaded separately. After changing them:

```sh
python3 -I scripts/amo_listing.py --dry-run
python3 -I scripts/amo_listing.py              # or only some: policy icon screenshots
```

Screenshots must not show personal data: replace the commit author's email in the merge dialog, and hide avatars.

## The native helper

`native/` isn't part of the add-on. Users run it from their checkout, so `git pull` updates its code; `requirements.txt` changes need `python3 native/install.py` to be re-run. When the extension starts relying on new helper behavior, bump `HOST_VERSION` in `native/host.py` and `MIN_HOST_VERSION` in `src/background.js` together. Older helpers then make the extension say the helper is out of date, with the commands to update it. Installed packages that don't match `requirements.txt` do the same.

## Security review

Before each release, check the change against the "Security" section in README.md and the checklist in CLAUDE.md. Report security bugs privately (see [SECURITY.md](SECURITY.md)).
