# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Firefox extension (MV3) that adds a button next to GitHub's merge button. When clicked, it asks Claude to review a single commit's message or write a squash commit message, then fills GitHub's commit form; the user confirms the merge. README.md covers install, usage, and the security model.

## Commands

```sh
npm run build        # bundle src/ with esbuild into dist/ (load dist/manifest.json in about:debugging)
npm run watch        # rebuild on change
npm test             # JS unit tests (node:test, test/*.test.js)
node --test --test-name-pattern="closingRefs" test/safety.test.js   # single JS test
npm run test:native  # native host tests (needs native/.venv, created by native/install.py)
native/.venv/bin/python -I -m unittest discover -s native -k test_rejects_bad_values   # single native test
npm run lint         # build + web-ext lint
npm run package      # build + zip into web-ext-artifacts/
python3 native/install.py   # set up venv, register native host with Firefox, store API key in keychain
```

## Architecture

Request flow: content script → background script → GitHub REST API (read-only) + native messaging host → Claude API.

- `src/content.js` (github.com content script): state is per PR, not per URL, so it survives tab switches. It runs on every PR tab and finds GitHub's merge buttons by label (outside user content), grouped into surfaces by container: the Overview tab's merge card (`[data-testid="for-you-item-row"]`), the "Merge status" side panel (`[data-testid="mergebox-border-container"]`, inline commit editor), and the modal confirm dialog the card opens (`[role="dialog"]`). Each card/side surface gets our button after the Primer `[data-component="ButtonGroup"]`; squash commit editors get "Fill in suggested message" next to Cancel once there's a suggestion (dialogs only then, since the panel is inert behind them); rebase and merge-commit editors get nothing. Our buttons copy GitHub's `prc-Button-*` classes from the button next to them (`styleLike()`), so they match GitHub's current styles. The panel is kept and placed after the card container or the side panel's merge box, following the surface whose button was clicked last. GitHub navigates as an SPA, so a debounced MutationObserver re-runs `check()`, which must stay idempotent (it skips hidden tabs and re-checks on `visibilitychange` and bfcache `pageshow`). It fills React-controlled fields with the native `value` setter plus `input` events.
- `src/background.js`: validates messages by sender, fetches the PR, commits, diff and (for repos without built-in rules) the base branch's CONTRIBUTING.md, builds the prompt, and calls the native host via `browser.runtime.sendNativeMessage("github_merge_helper", …)` (every request carries `minHostVersion`; replies carry `hostVersion`). Results are cached per PR head SHA in memory and saved per PR in `storage.local` (`pr:owner/repo#N`; restored on revisit with one GitHub request, dropped after 30 days, when the PR isn't open, or when the panel is closed). The panel closes as soon as the PR header's `header [data-component="StateLabel"]` has `data-status` `pullMerged` or `pullClosed` (`pageSaysClosed()`); as a fallback, when the merge button disappears while a panel shows, `checkStillOpen()` asks the background (`prState`, a GitHub request, retried after 5 s and 15 s) and closes it if the PR isn't open. GitHub API requests use `cache: "no-cache"`, since GitHub sends `max-age=60`. `suggest` refuses PRs that aren't open before calling Claude, and concurrent requests per PR are merged. Mode is `review` for 1 commit, `generate` otherwise.
- `src/rules.js`: baked-in commit message rules (common, `whatwg/*`, `web-platform-tests/wpt`), the system prompt, the JSON output schema, and the user message. PR data is wrapped in a per-request random boundary tag.
- Squash cleanup: when a squash editor opens with GitHub's default title (ending in ` (#N)`), `cleanUpSquash()` asks the background whether it's enabled (`cleanupEnabled`) and drops the suffix (`stripPrRef()` in `safety.js`); it never touches the description. A caption under the title offers "Restore". The title field gets `data-gmh-cleanup` so a newer version injected after an update doesn't redo it.
- `src/issueref.js` + `src/redirect.js`: fixes up pasted URLs from the URL alone (`fixedUrl()`): `github.com/owner/repo#N` → `/owner/repo/issues/N`, and trailing punctuation is dropped from the hash, the repo name, or `/issues/N`/`/pull/N` (also matched at the URLs GitHub redirects those to: `/pull/new/N.`, `/compare/N.`, `/issues/created_by/N.`). Owners that are GitHub's reserved top-level names (`orgs`, `settings`, …) are skipped. `redirect.js` is a separate `document_start` content script, so it redirects before the page loads (`window.stop()` first: Firefox ignores `location.replace()` that early otherwise), and again on `hashchange`.
- `src/safety.js`: deterministic checks on model output (closing keywords, references not in the PR, invisible characters, trailer format, input validation). Shared by background and content.
- `native/host.py`: the native messaging host. It reads the API key from the macOS Keychain (`security`) or Linux `secret-tool`, rebuilds the request from a strict allowlist, and calls `client.beta.messages.create` with the pinned `anthropic` Python SDK. It exists because the API blocks browser (CORS) requests for orgs with custom retention, and it keeps the key out of the browser. `native/install.py` writes the venv, the launcher, and the Firefox host manifest (`allowed_extensions: ["github-merge-helper@zcorpan"]`).
- The extension bundle doesn't use the Anthropic JS SDK; only the Python host talks to the API. The extension's CSP only allows `connect-src https://api.github.com`.

Request shape changes need to land in both `src/background.js` and the allowlist in `native/host.py`. When the extension starts relying on new native host behavior, bump `HOST_VERSION` in `native/host.py` and `MIN_HOST_VERSION` in `src/background.js` together: users run the host from their own checkout, and older hosts (or ones whose installed packages don't match `requirements.txt`) make the extension tell them to `git pull` and re-run `install.py`.

## Publishing every change

After every change that affects the extension (`src/`, `manifest.json`, `build.mjs`, dependencies), commit it and run `npm run release` (patch bump by default), which submits it to AMO's listed channel with the source package (AMO reviews it; installs update from AMO), publishes GitHub release notes, and pushes `main`. See RELEASING.md. The maintainer has authorized this for every change, so don't ask first. For changes that don't affect the extension (docs, tests, `native/`, `scripts/`), just push `main`. A release needs the AMO credentials in the Keychain (see RELEASING.md); if they're missing, stop and say so. The listing's privacy policy, icon and screenshots are uploaded separately (`scripts/amo_listing.py`); run it when files in `amo/` change.

## Security review on every change

For any change to the code or new feature, check its impact on the security properties listed under "Security" in README.md, and fix any issues it introduces before calling the change done. Update that section if a property changes.

PR data (title, description, commits, author names, diff) is untrusted and may contain prompt injection, so model output is untrusted too. In particular, check that:

- model output is only ever inserted as text or form field values (no HTML sinks), and the extension never clicks GitHub's buttons or submits forms;
- the only thing done without a click, the squash title cleanup (`cleanUpSquash()` in `src/content.js`), stays model-free, only edits GitHub's untouched default title (never the description), and runs at most once per commit editor;
- the model has no tools, and `native/host.py` still rejects any request outside its allowlist;
- the API key stays out of the browser, out of prompts, and out of replies from the native host;
- the safety checks in `src/safety.js` (closing keywords, unknown references, invisible characters) run on all text that can reach GitHub's commit form;
- inputs used in URLs or the native host request are validated, untrusted text is size-capped, and patterns stay linear-time;
- the CSP, host permissions, and native host manifest stay as narrow as possible;
- clicks synthesized by page scripts stay ignored, and nothing can trigger paid requests without a user click.

Add or update tests in `test/` and `native/test_host.py` for security-relevant behavior, and run `npm test`, `npm run test:native`, and `npm run lint`.
