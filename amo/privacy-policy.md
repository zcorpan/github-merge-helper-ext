GitHub Merge Helper sends data only when you click one of its buttons ("Review commit message", "Write squash commit message"). It then sends the pull request's title, description, commit messages (including the commit authors' names and email addresses in them), and diff (capped at 300,000 characters) to the Anthropic API (Claude), using your own API key. The request goes through the native helper program you install from the source repository, which reads your API key from the macOS Keychain or the Linux keyring. Anthropic's handling of that data is covered by your agreement with Anthropic and its privacy policy (https://www.anthropic.com/legal/privacy).

To get that pull request data, the extension makes read-only requests to api.github.com, without cookies. If you set a GitHub token in the options, it's sent only to api.github.com.

The extension stores its settings, and the last result for each pull request you used it on (the suggestion, your edits to it, and references from the pull request, kept for up to 30 days), in the browser's local extension storage. That storage isn't synced and isn't sent anywhere.

The extension collects no analytics or telemetry, and the developer receives no data from it.
