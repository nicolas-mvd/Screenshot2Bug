# Publishing Checklist

Use this checklist before every push or release.

## Never Commit

- API keys, tokens, cookies, or private certificates
- `.env` files or local config overrides
- Exported bug reports that contain real customer data
- Screenshots, videos, or logs with personal or confidential information
- Machine-specific paths, usernames, or hostnames

## Before Pushing

1. Run a quick search for secrets and personal data.
2. Inspect changed files for real report content or local-only artifacts.
3. Verify `.gitignore` still covers `node_modules/`, `dist/`, and local environment files.
4. Make sure the README uses generic install instructions only.
5. Confirm that any sample data is fake and safe to publish.

## Suggested Checks

Before publishing, search the tracked files for:

- Real API credentials, tokens, passwords, private keys, or bearer credentials
- Absolute local filesystem paths or machine-specific usernames
- Exported report bundles, screenshots, recordings, or logs

Prefer running both broad text searches and a manual `git diff --cached` review before every public push.

## Release Rule

If a file contains customer data, account data, or anything you would not paste into a public issue, do not push it.
