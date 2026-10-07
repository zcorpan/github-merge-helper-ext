# Security review on every change

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
