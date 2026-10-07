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

- `src/content.js` (github.com content script): state is per PR, not per URL, so it survives tab switches; the panel element is kept and re-placed whenever GitHub re-renders the merge box. It finds GitHub's merge button by its label (exactly one, outside user content), inserts our button after the Primer `[data-component="ButtonGroup"]`, and puts the panel after `[data-testid="mergebox-border-container"]`. GitHub navigates as an SPA, so a debounced MutationObserver re-runs `check()`, which must stay idempotent. It fills React-controlled fields with the native `value` setter plus `input` events.
- `src/background.js`: validates messages by sender, fetches the PR, commits, diff and (for repos without built-in rules) the base branch's CONTRIBUTING.md, builds the prompt, and calls the native host via `browser.runtime.sendNativeMessage("github_merge_helper", …)`. Results are cached per PR head SHA in memory and saved per PR in `storage.local` (`pr:owner/repo#N`; restored on revisit with one GitHub request, dropped after 30 days, when the PR isn't open, or when the panel is closed), and concurrent requests per PR are merged. Mode is `review` for 1 commit, `generate` otherwise.
- `src/rules.js`: baked-in commit message rules (common, `whatwg/*`, `web-platform-tests/wpt`), the system prompt, the JSON output schema, and the user message. PR data is wrapped in a per-request random boundary tag.
- `src/safety.js`: deterministic checks on model output (closing keywords, references not in the PR, invisible characters, trailer format, input validation). Shared by background and content.
- `native/host.py`: the native messaging host. It reads the API key from the macOS Keychain (`security`) or Linux `secret-tool`, rebuilds the request from a strict allowlist, and calls `client.beta.messages.create` with the pinned `anthropic` Python SDK. It exists because the API blocks browser (CORS) requests for orgs with custom retention, and it keeps the key out of the browser. `native/install.py` writes the venv, the launcher, and the Firefox host manifest (`allowed_extensions: ["github-merge-helper@zcorpan"]`).
- The extension bundle doesn't use the Anthropic JS SDK; only the Python host talks to the API. The extension's CSP only allows `connect-src https://api.github.com`.

Request shape changes need to land in both `src/background.js` and the allowlist in `native/host.py`.

## Security review on every change

For any change to the code or new feature, check its impact on the security properties listed under "Security" in README.md, and fix any issues it introduces before calling the change done. Update that section if a property changes.

PR data (title, description, commits, author names, diff) is untrusted and may contain prompt injection, so model output is untrusted too. In particular, check that:

- model output is only ever inserted as text or form field values (no HTML sinks), and the extension never clicks GitHub's buttons or submits forms;
- the model has no tools, and `native/host.py` still rejects any request outside its allowlist;
- the API key stays out of the browser, out of prompts, and out of replies from the native host;
- the safety checks in `src/safety.js` (closing keywords, unknown references, invisible characters) run on all text that can reach GitHub's commit form;
- inputs used in URLs or the native host request are validated, untrusted text is size-capped, and patterns stay linear-time;
- the CSP, host permissions, and native host manifest stay as narrow as possible;
- clicks synthesized by page scripts stay ignored, and nothing can trigger paid requests without a user click.

Add or update tests in `test/` and `native/test_host.py` for security-relevant behavior, and run `npm test`, `npm run test:native`, and `npm run lint`.
