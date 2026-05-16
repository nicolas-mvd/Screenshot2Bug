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

```bash
rg -n --hidden -S "(api[_-]?key|secret|token|password|passwd|BEGIN .*PRIVATE KEY|ghp_|xox[baprs]-|sk-)" .
rg -n --hidden -S "(/Users/|/home/|C:\\\\Users\\\\|Documents/|Desktop/|Bearer )" .
```

## Release Rule

If a file contains customer data, account data, or anything you would not paste into a public issue, do not push it.
