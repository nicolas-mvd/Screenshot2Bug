# Screenshot2Bug

Chrome MV3 extension for founders and product teams to capture screenshot or video bug reports with page context, console errors, browser details, typed repro steps, and AI-generated Markdown.

## Development

This repo can be loaded directly as an unpacked extension while iterating:

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click Load unpacked
4. Select the project folder on your machine, or the built `dist/` folder after running the build

For a bundled production build, install dependencies, then build the extension:

```bash
npm install
npm run build
```

Load `dist/` as an unpacked extension from `chrome://extensions`.

## Capture Modes

- New screenshot report: popup button or `Option+Shift+S`
- Attach screenshot to current report: popup button or `Control+Shift+S`
- New video report: popup button or `Option+Shift+V`
- Attach video to current report: popup button or `Control+Shift+V`

Chrome users can remap these shortcuts at `chrome://extensions/shortcuts`.

Reports stay in local extension storage until removed by a future cleanup feature. The popup lists previous reports so drafts can be reopened, and **Download ZIP** exports `report.md`, `metadata.json`, plus attached screenshot/video files.

## AI Reports

Open the extension settings page and save your own OpenAI API key locally in the browser. The key is not committed to the repo and is never bundled into the extension source. If no key is saved, Screenshot2Bug still creates a structured Markdown template report from the captured context.

## Privacy Notes

- Captured screenshots, videos, console errors, and generated reports stay in local extension storage unless you export them.
- Do not commit exported reports or demo captures that contain real customer data.
- The extension requests broad page access because it captures page context and evidence from arbitrary sites.
