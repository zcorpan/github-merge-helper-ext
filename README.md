# GitHub Merge Helper

A Firefox extension that asks Claude to help with the commit message when you merge a GitHub pull request.

It adds a button next to the green merge button on PRs you can merge. The extension does nothing until you click it.

Requests to the Claude API go through a small local helper program (a [native messaging host](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)) that keeps your API key in the macOS Keychain or the Linux keyring. The key never enters the browser, and this also works for organizations where the API blocks browser (CORS) requests, such as those with custom data-retention settings. macOS and Linux only.

- **One commit:** "Review commit message" checks the commit message against the repository's rules (e.g. title length, imperative mood, `Editorial: ` prefix, a missing `Fixes #N.`). If it needs changes, you get a fixed version.
- **Several commits:** "Write squash commit message" writes a new message from the commits and the PR description. It's kept short, focuses on rationale rather than what the diff shows, and drops the `(#123)` PR reference from the title.

If GitHub's squash commit editor is open (you clicked "Squash and merge"), the message is filled in directly. Otherwise the button label changes to "Fill in commit message" once the editor is open. You can edit the suggestion in the panel, then use Fill in, Copy, Regenerate, or Undo (which restores what was in GitHub's form). Existing `Co-authored-by:` trailers are kept.

Without Claude, the extension also cleans up GitHub's default squash message when you open the squash commit editor: it removes the `(#123)` GitHub adds to the title and uses the first commit's description, plus `Co-authored-by:` lines from all commits (deduped), as the description. Often the first commit has the real description and the rest are fixups. It only touches GitHub's untouched default, a "Restore GitHub's message" button next to the merge button undoes it, and you can turn it off in the options.

The button is there whenever GitHub shows a merge button, even while GitHub has it disabled (e.g. while checking whether the PR can be merged), so there's none without write access. If the button should be there but the extension can't find GitHub's merge button (GitHub changed its markup), it logs a warning to the console.

## Rules

Rules for these repositories are built in ([`src/rules.js`](src/rules.js)), calibrated against recent commit history (excluding exports from browser engines):

- `whatwg/*`: [WHATWG committer guidelines](https://github.com/whatwg/meta/blob/main/COMMITTING.md) as applied in practice (`Editorial: `/`Meta: ` prefixes, closing keywords only for resolved issues, a coherent squash description).
- `web-platform-tests/wpt`: no formal policy; short or no descriptions, area prefixes like `HTML parser:` or `[css-grid]`.

Reviewing a contributor's message is lenient: a long description that's substance, titles a bit over 72 characters (except in `whatwg/*`, where 72 is a hard limit, also checked by the extension itself), backticks or not, `Fixes` or `Closes`, and no `Tests:` line are all fine. It flags real problems: padded or AI-style verbose text, PR template or GitHub squash leftovers, a title that doesn't describe the change or has a PR reference, and missing or wrong issue references. Messages the extension writes itself follow a stricter, shorter style: title at most 72 characters, short rationale-focused description, nothing invented.

For other repositories it also fetches `CONTRIBUTING.md` (root, `.github/`, or `docs/`) and applies what it says about commit messages. You can add your own instructions in the settings.

## Build

Requires Node.js 20 or later and Python 3.10 or later.

```sh
npm install
npm run build        # outputs the extension to dist/
npm test             # unit tests for the safety checks and prompt building
npm run test:native  # unit tests for the native helper (after installing it)
npm run lint         # build + web-ext lint
npm run package    # build + zip into web-ext-artifacts/
npm run watch      # rebuild on change
```

## Install

### 1. The native helper

From this directory:

```sh
python3 native/install.py
```

This creates a virtualenv in `native/.venv` with the pinned `anthropic` Python package, and registers the helper with Firefox by writing `github_merge_helper.json` to `~/Library/Application Support/Mozilla/NativeMessagingHosts/` (macOS) or `~/.mozilla/native-messaging-hosts/` (Linux). Only this extension's ID may start it. It then asks for your Claude API key (create one at <https://platform.claude.com/settings/keys>) at the keychain tool's own prompt, so the key doesn't end up in your shell history.

- Change the key: `python3 native/install.py --set-key`
- Remove the helper and the key: `python3 native/install.py --uninstall`

The registration points at this checkout, so don't move or delete the directory afterwards (or re-run the installer if you do). Restart Firefox after installing.

### 2. The extension

Choose one:

- **Temporary (any Firefox):** go to `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on…", and pick the `manifest.json` file inside `dist/` (not the folder). It stays until Firefox restarts. `npm start` does the same in Firefox Nightly with a fresh profile, which isn't logged in to GitHub.
- **Permanent, unsigned (Firefox Nightly or Developer Edition):** set `xpinstall.signatures.required` to `false` in `about:config`, run `npm run package`, then go to `about:addons` → gear menu → "Install Add-on From File…" and pick the zip in `web-ext-artifacts/`.
- **Permanent, signed (any Firefox, including release):** sign it as an unlisted add-on on addons.mozilla.org. This doesn't publish it. Get API credentials at <https://addons.mozilla.org/developers/addon/api/key/>, then run:

  ```sh
  npm run build
  npx web-ext sign -s dist --channel=unlisted --api-key=$AMO_JWT_ISSUER --api-secret=$AMO_JWT_SECRET
  ```

  Then install the `.xpi` it downloads into `web-ext-artifacts/`. Bump `version` in `manifest.json` before each re-sign.

On install, Firefox asks for access to `github.com` and `api.github.com`, and to "exchange messages with programs other than Firefox" (the native helper). If you load it temporarily and the button doesn't show up, check that these are allowed under the add-on's Permissions tab in `about:addons`.

## Settings

In `about:addons`, click the `…` menu next to GitHub Merge Helper and choose "Options" (it opens in a new tab).

- **Test connection:** checks that the native helper runs and the API key works (a free request that lists one model).
- **Model:** default `claude-opus-5-5`.
- **Effort:** default `medium`. Use `high` for subtler reviews; `low` is cheaper and faster.
- **GitHub token** (optional): only for private repositories or if you hit the unauthenticated rate limit of 60 requests/hour (each click uses a few). Use a fine-grained token with read-only "Pull requests" and "Contents" access and nothing else.
- **Extra instructions** (optional): added to every prompt.

## Usage

1. Open a PR you can merge, on the Conversation tab.
2. Optionally choose "Squash and merge" in the merge method menu and click it, so the commit editor is open.
3. Click "Review commit message" or "Write squash commit message" next to the merge button.
4. Read the panel, edit the message if needed, and fill it in if it wasn't filled in already. Then confirm the merge yourself as usual.

Once shown, the panel stays: when GitHub re-renders the merge box, when you switch to "Files changed" and back, and when you come back to the PR later, with any edits you made in it. Saved results are dropped when you close the panel (×), when the PR is merged or closed (checked on your next visit), or after 30 days. If the PR got new commits since, the panel says so; "Regenerate" asks again. A restored panel never fills in GitHub's form by itself.

After you update the extension, open PR pages keep working with a lone button replaced. If a suggestion or error panel was showing, it stays readable but inactive, with a note to reload the page.

## Security

Anyone can open a PR, so the PR title, description, commit messages, author names, and diff are untrusted, and may contain prompt injection ("ignore previous instructions…"). The extension is built so that clicking the button can't do anything beyond showing text and putting it in GitHub's commit form:

- **The model has no tools.** Its whole output is a JSON object with a title, body, verdict, and short notes, validated in [`src/safety.js`](src/safety.js). It can't make requests, run code, or call GitHub.
- **No HTML from the model, ever.** The panel builds DOM nodes and sets text only; there are no `innerHTML`-style sinks anywhere in the extension. Issue references like `#123` and `owner/repo#123` in the panel are linked to `https://github.com/owner/repo/issues/123`, with the URL built from the validated owner, repository, and number; URLs in the model's text are never made into links.
- **No GitHub actions.** The extension never clicks GitHub's buttons or submits forms. It only sets the values of the commit title and description fields, and you confirm the merge yourself. The one thing it does without a click is the squash message cleanup, which uses no model and only GitHub's own commit data: it only replaces GitHub's untouched default, only if you didn't type in the meantime, at most once per commit editor (marked on the title field, so an updated version doesn't redo it), and it can be undone or turned off. GitHub API requests are read-only `GET`s without cookies. The optional token should be a read-only fine-grained token; it's sent only to `api.github.com`.
- **Nothing to exfiltrate, nowhere to send it.** The API key never enters the browser: it's in the OS keychain and only the native helper reads it. The GitHub token is never put in the prompt. A content security policy limits the extension's pages to connecting to `api.github.com`, and the content script makes no network requests at all.
- **The native helper only does one thing.** [`native/host.py`](native/host.py) rebuilds each request from an allowlist (model, a single user text message, system prompt, JSON output format, effort, max tokens) and rejects anything else, such as tools, files, or other endpoints. It always talks to `https://api.anthropic.com`, ignoring `ANTHROPIC_*` environment variables (e.g. a gateway `ANTHROPIC_BASE_URL` you use for other tools), and it never returns the key. The worst a caller can do is spend your API credit on ordinary text requests.
- **Who can start the helper.** Firefox only starts it for the extension ID in the host manifest, `github-merge-helper@zcorpan`. Extension IDs are self-declared, so any extension you install that claims this ID could also use the helper, within the limits above. To reserve the ID, sign the extension as unlisted on AMO (see Install). The installer pins exact versions of `anthropic` and its dependencies and installs wheels only, so no package build code runs; the launcher it writes quotes its paths.
- **What's out of scope.** Any program running as your user can read the key from the keychain (as with any locally stored credential) or change the helper's files. The helper honors standard proxy environment variables such as `HTTPS_PROXY`, so a proxy you've configured system-wide sees the (TLS-encrypted) traffic.
- **Checks that don't rely on the model**, shown in the panel under "Checked by the extension, not by Claude":
  - every issue the message will close when merged (`Fixes #N`, `closes owner/repo#N`, issue URLs),
  - any link, issue/PR reference, commit SHA, or `@mention` in the message that doesn't appear in the PR title, visible description, or commit messages,
  - invisible or control characters (bidi overrides, zero-width characters, Unicode tag characters), which are always stripped.
  If anything is flagged, the message isn't filled in automatically; you have to click "Fill in" after reading it.
- **"Looks good" uses the real commit.** When the single commit's message passes review, the extension fills in the commit's own text, not the model's copy of it.
- **Prompt hardening.** PR data is wrapped in a block delimited by a random per-request tag the PR can't forge, and the model is told to treat it as data and to mention in its notes any text aimed at it.
- **Inputs are validated.** The owner, repository, and PR number taken from the URL are checked before building API URLs; the background script only accepts messages from the extension's own content script on github.com; saved results are re-validated when restored and never filled in without a click; clicks synthesized by page scripts are ignored, and concurrent requests for the same PR are merged so repeated clicks don't pay twice; untrusted text is size-capped and matched with linear-time patterns.

What it can't prevent: a manipulated model writing a misleading or low-quality message, or a wrong verdict. Read the message before you merge, as you would without the extension. The model's issues and notes come from the model too, so they're only as trustworthy as the message.

## Privacy

Clicking the button sends the PR's title, description, commit messages, and diff (capped at 300,000 characters) to the Anthropic API using your key, via the native helper. Settings, and the last result for each PR you used the extension on (the suggestion, your edits to it, and references from the PR, kept for up to 30 days as described in Usage), are stored in `browser.storage.local` (not synced). The extension makes no other requests besides read-only requests to `api.github.com`.
