# GitHub Merge Helper

A Firefox extension that asks Claude to help with the commit message when you merge a GitHub pull request.

It adds a button next to the green merge button on PRs you can merge. The extension does nothing until you click it.

- **One commit:** "Review commit message" checks the commit message against the repository's rules (e.g. title length, imperative mood, `Editorial: ` prefix, a missing `Fixes #N.`). If it needs changes, you get a fixed version.
- **Several commits:** "Write squash commit message" writes a new message from the commits and the PR description. It's kept short, focuses on rationale rather than what the diff shows, and drops the `(#123)` PR reference from the title.

If GitHub's squash commit editor is open (you clicked "Squash and merge"), the message is filled in directly. Otherwise the button label changes to "Fill in commit message" once the editor is open. You can edit the suggestion in the panel, then use Fill in, Copy, Regenerate, or Undo (which restores what was in GitHub's form). Existing `Co-authored-by:` trailers are kept.

There's no button when you can't merge (no write access, or the merge button is disabled). If the button should be there but the extension can't find GitHub's merge button (GitHub changed its markup), it logs a warning to the console.

## Rules

Rules for these repositories are built in ([`src/rules.js`](src/rules.js)):

- `whatwg/*`: [WHATWG committer guidelines](https://github.com/whatwg/meta/blob/main/COMMITTING.md) (prefixes, closing keywords only for resolved issues, `Tests:` lines, a coherent squash description).
- `web-platform-tests/wpt`: the common rules, keeping `[area]` title prefixes.
- All repositories: title ≤72 characters, imperative mood, no trailing period, no PR reference in the title, short body (often none), code in backticks, nothing invented.

For other repositories it also fetches `CONTRIBUTING.md` (root, `.github/`, or `docs/`) and applies what it says about commit messages. You can add your own instructions in the settings.

## Build

Requires Node.js 20 or later.

```sh
npm install
npm run build      # outputs the extension to dist/
npm test           # unit tests for the safety checks and prompt building
npm run lint       # build + web-ext lint
npm run package    # build + zip into web-ext-artifacts/
npm run watch      # rebuild on change
```

## Install

Choose one:

- **Temporary (any Firefox):** go to `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on…", and pick `dist/manifest.json`. It stays until Firefox restarts. `npm start` does the same in Firefox Nightly with a fresh profile, which isn't logged in to GitHub.
- **Permanent, unsigned (Firefox Nightly or Developer Edition):** set `xpinstall.signatures.required` to `false` in `about:config`, run `npm run package`, then go to `about:addons` → gear menu → "Install Add-on From File…" and pick the zip in `web-ext-artifacts/`.
- **Permanent, signed (any Firefox, including release):** sign it as an unlisted add-on on addons.mozilla.org. This doesn't publish it. Get API credentials at <https://addons.mozilla.org/developers/addon/api/key/>, then run:

  ```sh
  npm run build
  npx web-ext sign -s dist --channel=unlisted --api-key=$AMO_JWT_ISSUER --api-secret=$AMO_JWT_SECRET
  ```

  Then install the `.xpi` it downloads into `web-ext-artifacts/`. Bump `version` in `manifest.json` before each re-sign.

On install, Firefox asks for access to `github.com`, `api.github.com`, and `api.anthropic.com`. If you load it temporarily and the button doesn't show up, check that these are allowed under the add-on's Permissions tab in `about:addons`.

## Settings

Open `about:addons` → GitHub Merge Helper → Preferences.

- **Claude API key** (required): create one at <https://platform.claude.com/settings/keys>.
- **Model:** default `claude-opus-5-5`.
- **Effort:** default `medium`. Use `high` for subtler reviews; `low` is cheaper and faster.
- **GitHub token** (optional): only for private repositories or if you hit the unauthenticated rate limit of 60 requests/hour (each click uses a few). Use a fine-grained token with read-only "Pull requests" and "Contents" access and nothing else.
- **Extra instructions** (optional): added to every prompt.

## Usage

1. Open a PR you can merge, on the Conversation tab.
2. Optionally choose "Squash and merge" in the merge method menu and click it, so the commit editor is open.
3. Click "Review commit message" or "Write squash commit message" next to the merge button.
4. Read the panel, edit the message if needed, and fill it in if it wasn't filled in already. Then confirm the merge yourself as usual.

Results are cached until the PR's head commit changes; "Regenerate" asks again.

## Security

Anyone can open a PR, so the PR title, description, commit messages, author names, and diff are untrusted, and may contain prompt injection ("ignore previous instructions…"). The extension is built so that clicking the button can't do anything beyond showing text and putting it in GitHub's commit form:

- **The model has no tools.** Its whole output is a JSON object with a title, body, verdict, and short notes, validated in [`src/safety.js`](src/safety.js). It can't make requests, run code, or call GitHub.
- **No HTML from the model, ever.** The panel builds DOM nodes and sets text only; there are no `innerHTML`-style sinks anywhere in the extension.
- **No GitHub actions.** The extension never clicks GitHub's buttons or submits forms. It only sets the values of the commit title and description fields, and you confirm the merge yourself. GitHub API requests are read-only `GET`s without cookies. The optional token should be a read-only fine-grained token; it's sent only to `api.github.com`.
- **Nothing to exfiltrate, nowhere to send it.** The API key and GitHub token are never put in the prompt. A content security policy limits the extension's pages to connecting to `api.anthropic.com` and `api.github.com`, and the content script makes no network requests at all.
- **Checks that don't rely on the model**, shown in the panel under "Checked by the extension, not by Claude":
  - every issue the message will close when merged (`Fixes #N`, `closes owner/repo#N`, issue URLs),
  - any link, issue/PR reference, commit SHA, or `@mention` in the message that doesn't appear in the PR title, visible description, or commit messages,
  - invisible or control characters (bidi overrides, zero-width characters, Unicode tag characters), which are always stripped.
  If anything is flagged, the message isn't filled in automatically; you have to click "Fill in" after reading it.
- **"Looks good" uses the real commit.** When the single commit's message passes review, the extension fills in the commit's own text, not the model's copy of it.
- **Prompt hardening.** PR data is wrapped in a block delimited by a random per-request tag the PR can't forge, and the model is told to treat it as data and to mention in its notes any text aimed at it.
- **Inputs are validated.** The owner, repository, and PR number taken from the URL are checked before building API URLs; the background script only accepts messages from the extension's own content script on github.com; clicks synthesized by page scripts are ignored; untrusted text is size-capped and matched with linear-time patterns.

What it can't prevent: a manipulated model writing a misleading or low-quality message, or a wrong verdict. Read the message before you merge, as you would without the extension. The model's issues and notes come from the model too, so they're only as trustworthy as the message.

## Privacy

Clicking the button sends the PR's title, description, commit messages, and diff (capped at 300,000 characters) to the Anthropic API using your key. Settings are stored in `browser.storage.local` (not synced). The extension makes no other requests besides read-only requests to `api.github.com`.
