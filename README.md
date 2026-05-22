# Screenshot2Bug

Chrome MV3 extension for founders and product teams to capture screenshot or video bug reports with page context, console errors, browser details, typed repro steps, and AI-generated Markdown.

## Install In Chrome

### Option 1: Load the repo directly

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click Load unpacked
4. Select this repository folder

This path is useful for development and quick testing because the repo root includes a directly loadable extension.

### Option 2: Build and load `dist/`

Install dependencies, then build the extension:

```bash
npm install
npm run build
```

Load `dist/` as an unpacked extension from `chrome://extensions`.

## Permissions

Screenshot2Bug requests Chrome extension permissions for:

- Capturing the active tab screenshot or recording
- Reading page metadata, console events, and request evidence from the active page
- Saving reports and drafts in local extension storage
- Downloading ZIP exports
- Calling the OpenAI API when the user supplies an API key

No OpenAI API key is bundled with the extension. Users add their own key from the extension settings page. If no key is configured, Screenshot2Bug generates a structured template report locally.

## Capture Modes

- Full-tab screenshot: popup button or `Option+Shift+S`
- Selected-area screenshot: popup button or `Option+Shift+A`
- Full-tab video: popup button or `Option+Shift+V`
- Selected-area video: popup button or `Option+Shift+R`

Existing reports can be reopened from the popup and extended with full-tab or selected-area screenshots/videos. Screenshot evidence can be edited with crop, box, arrow, blur, and text tools before exporting. Saving or exporting a report closes its focus so the next capture starts a fresh report.

Chrome users can remap these shortcuts at `chrome://extensions/shortcuts`.

Reports stay in local extension storage until removed by a future cleanup feature. The popup lists previous reports so drafts can be reopened, and **Download ZIP** exports `report.md`, `metadata.json`, plus attached screenshot/video files.

## AI Reports

Open the extension settings page and save an OpenAI API key. If no key is saved, Screenshot2Bug still creates a structured Markdown template report from the captured context.

## GitHub Issues

Screenshot2Bug can create a GitHub issue from the current bug report.

1. Create a GitHub OAuth App and enable Device Flow.
2. Copy the OAuth App's public Client ID.
3. Open Screenshot2Bug settings and paste the Client ID.
4. Click **Connect GitHub**, authorize the device code, and select a repository.
5. Capture or open a report, then click **Create GitHub issue**.

The GitHub token is stored locally in Chrome extension storage. Screenshots and recordings are not uploaded to GitHub in this version; they remain available through the local ZIP export.

## Test Page

The repository includes `test-error-page.html`, a local fixture that intentionally creates console errors so extension capture can be tested.
