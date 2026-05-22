// src/shared/types.ts
var STORAGE_KEYS = {
  latestSessionId: "latestSessionId",
  settings: "settings",
  sessions: "sessions",
  consolePrefix: "console:",
  networkPrefix: "network:"
};
var DEFAULT_MODEL = "gpt-5";

// src/shared/storage.ts
async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return result[STORAGE_KEYS.settings] ?? {};
}
async function getSessions() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.sessions);
  return result[STORAGE_KEYS.sessions] ?? {};
}
async function getSortedSessions() {
  const sessions2 = await getSessions();
  return Object.values(sessions2).map(normalizeSession).filter((session2) => !!session2).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}
function normalizeSession(session2) {
  if (!session2) return session2;
  const screenshots = [...session2.screenshots ?? []];
  const recordings = [...session2.recordings ?? []];
  if (session2.screenshotDataUrl && !screenshots.some((item) => item.dataUrl === session2.screenshotDataUrl)) {
    screenshots.push({
      id: "legacy-screenshot",
      dataUrl: session2.screenshotDataUrl,
      createdAt: session2.updatedAt || session2.createdAt,
      url: session2.metadata?.url,
      title: session2.metadata?.title
    });
  }
  if (session2.recordingDataUrl && !recordings.some((item) => item.dataUrl === session2.recordingDataUrl)) {
    recordings.push({
      id: "legacy-recording",
      dataUrl: session2.recordingDataUrl,
      mimeType: session2.recordingMimeType || "video/webm",
      createdAt: session2.updatedAt || session2.createdAt,
      url: session2.metadata?.url,
      title: session2.metadata?.title
    });
  }
  return {
    ...session2,
    consoleErrors: session2.consoleErrors ?? [],
    networkRequests: session2.networkRequests ?? [],
    screenshots,
    recordings,
    screenshotDataUrl: screenshots.at(-1)?.dataUrl,
    recordingDataUrl: recordings.at(-1)?.dataUrl,
    recordingMimeType: recordings.at(-1)?.mimeType
  };
}

// src/shared/report.ts
function buildTemplateReport({ session: session2, steps: steps2, notes: notes2 }) {
  const normalized = normalizeSession(session2) ?? session2;
  const metadata = normalized.metadata;
  const title = metadata?.title || "Untitled page";
  const url = metadata?.url || "Unknown URL";
  const errorLines = normalized.consoleErrors.length ? normalized.consoleErrors.map((entry) => `- [${entry.timestamp}] ${entry.source}: ${entry.message}`).join("\n") : "- No console errors captured.";
  const networkLines = formatNetworkRequests(normalized);
  const screenshots = normalized.screenshots ?? [];
  const recordings = normalized.recordings ?? [];
  const attachments = [
    screenshots.length ? `- Screenshots: ${screenshots.length} PNG file${screenshots.length === 1 ? "" : "s"}${formatEvidenceDetails(screenshots)}` : "",
    recordings.length ? `- Recordings: ${recordings.length} WebM file${recordings.length === 1 ? "" : "s"}${formatEvidenceDetails(recordings)}` : ""
  ].filter(Boolean).join("\n");
  return `# Bug Report: ${title}

## Summary
Issue captured on ${url}.

## Environment
- URL: ${url}
- Browser: ${metadata?.userAgent ?? "Unknown"}
- Viewport: ${metadata ? `${metadata.viewport.width}x${metadata.viewport.height} @ ${metadata.viewport.devicePixelRatio}x` : "Unknown"}
- Screen: ${metadata ? `${metadata.screen.width}x${metadata.screen.height}` : "Unknown"}
- Captured at: ${normalized.createdAt}
- Capture mode: ${normalized.mode}

## Reproduction Steps
${steps2.trim() || "No steps provided."}

## Observed Behavior
${notes2.trim() || "No notes provided."}

## Console Errors
${errorLines}

## Network Requests
${networkLines}

## Attachments
${attachments || "- No binary attachments."}
`;
}
function formatNetworkRequests(session2) {
  if (!session2.networkRequests.length) return "- No network requests captured.";
  return coalesceNetworkRequests(session2.networkRequests).sort((first, second) => Number(isNetworkFailure(second)) - Number(isNetworkFailure(first))).slice(0, 20).map((entry) => {
    const status = entry.error ? `error: ${entry.error}` : typeof entry.status === "number" ? `${entry.status}${entry.statusText ? ` ${entry.statusText}` : ""}` : "no status";
    const duration = typeof entry.durationMs === "number" ? ` in ${entry.durationMs}ms` : "";
    const request = entry.requestBodyPreview ? `\n  request: ${singleLine(entry.requestBodyPreview)}` : "";
    const response = entry.responseBodyPreview
      ? `\n  response: ${singleLine(entry.responseBodyPreview)}`
      : entry.responseBodyUnavailableReason
        ? `\n  response: unavailable (${singleLine(entry.responseBodyUnavailableReason)})`
        : "";
    return `- [${entry.timestamp}] ${entry.method} ${entry.url} -> ${status}${duration}${request}${response}`;
  }).join("\n");
}
function coalesceNetworkRequests(entries) {
  const merged = [];
  for (const entry of entries) {
    const index = merged.findIndex((candidate) => isDuplicateNetworkEntry(candidate, entry));
    if (index === -1) {
      merged.push(entry);
      continue;
    }
    merged[index] = preferNetworkEntry(merged[index], entry);
  }
  return merged;
}
function isDuplicateNetworkEntry(first, second) {
  if (first.requestId && first.requestId === second.requestId) return true;
  if (first.method !== second.method || first.url !== second.url) return false;
  const firstTime = new Date(first.timestamp).getTime();
  const secondTime = new Date(second.timestamp).getTime();
  return !Number.isNaN(firstTime) && !Number.isNaN(secondTime) && Math.abs(firstTime - secondTime) < 5e3;
}
function preferNetworkEntry(first, second) {
  const primary = networkEntryScore(second) > networkEntryScore(first) ? second : first;
  const secondary = primary === first ? second : first;
  return {
    ...secondary,
    ...primary,
    requestHeaders: {
      ...secondary.requestHeaders ?? {},
      ...primary.requestHeaders ?? {}
    },
    responseHeaders: {
      ...secondary.responseHeaders ?? {},
      ...primary.responseHeaders ?? {}
    },
    requestBodyPreview: primary.requestBodyPreview ?? secondary.requestBodyPreview,
    responseBodyPreview: primary.responseBodyPreview ?? secondary.responseBodyPreview,
    responseBodyUnavailableReason: primary.responseBodyUnavailableReason ?? secondary.responseBodyUnavailableReason,
    responseContentType: primary.responseContentType ?? secondary.responseContentType,
    error: primary.error ?? secondary.error
  };
}
function networkEntryScore(entry) {
  return (entry.responseBodyPreview ? 8 : 0) + (entry.requestBodyPreview ? 4 : 0) + (entry.source === "page" ? 2 : 0) + (entry.responseHeaders ? 1 : 0);
}
function isNetworkFailure(entry) {
  return Boolean(entry.error || entry.ok === false || entry.status && entry.status >= 400);
}
function singleLine(value) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 500)}...` : compact;
}
function formatEvidenceDetails(items) {
  const selected = items.filter((item) => item.captureArea === "region").length;
  const edited = items.filter((item) => item.editedAt).length;
  const details = [
    selected ? `${selected} selected area` : "",
    edited ? `${edited} edited` : ""
  ].filter(Boolean);
  return details.length ? ` (${details.join(", ")})` : "";
}
async function generateAiReport(apiKey, model, input) {
  const fallback = buildTemplateReport(input);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Turn this captured browser bug context into a concise, founder/product-team friendly Markdown bug report. Start with one specific H1 title in the format "# Bug: <failing user action or symptom>" and avoid generic page titles. Keep the same facts, infer severity only if justified, and include actionable reproduction details.

${fallback}`
            }
          ]
        }
      ]
    })
  });
  if (!response.ok) {
    throw new Error(`OpenAI request failed with ${response.status}`);
  }
  const data = await response.json();
  const text = extractResponseText(data);
  if (!text) throw new Error("OpenAI response did not include text output.");
  return text;
}
function extractResponseText(data) {
  const outputText = data.output_text;
  if (outputText) return outputText;
  const output = data.output;
  return output?.flatMap((item) => item.content ?? []).map((content) => {
    const textContent = content;
    return textContent.type === "output_text" || textContent.text ? textContent.text ?? "" : "";
  }).join("").trim() ?? "";
}

// src/shared/zip.ts
async function buildReportZip({
  session: session2,
  report: report2
}) {
  const normalized = normalizeSession(session2) ?? session2;
  const modifiedAt = new Date(normalized.updatedAt || normalized.createdAt);
  const files = [
    { name: "report.md", bytes: textBytes(report2), modifiedAt },
    {
      name: "metadata.json",
      bytes: textBytes(JSON.stringify(normalized, null, 2)),
      modifiedAt
    }
  ];
  for (const [index, screenshot] of (normalized.screenshots ?? []).entries()) {
    files.push({
      name: `screenshots/screenshot-${index + 1}.png`,
      bytes: dataUrlBytes(screenshot.dataUrl),
      modifiedAt: new Date(screenshot.createdAt || normalized.updatedAt || normalized.createdAt)
    });
  }
  for (const [index, recording] of (normalized.recordings ?? []).entries()) {
    files.push({
      name: `recordings/recording-${index + 1}.webm`,
      bytes: dataUrlBytes(recording.dataUrl),
      modifiedAt: new Date(recording.createdAt || normalized.updatedAt || normalized.createdAt)
    });
  }
  return createZip(files);
}
function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = textBytes(file.name);
    const crc = crc32(file.bytes);
    const { time, date } = dosDateTime(file.modifiedAt);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 67324752, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, file.bytes.length, true);
    localView.setUint32(22, file.bytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, file.bytes);
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 33639248, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, file.bytes.length, true);
    centralView.setUint32(24, file.bytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);
    offset += localHeader.length + file.bytes.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 101010256, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  return new Blob([...localParts, ...centralParts, end], {
    type: "application/zip"
  });
}
function textBytes(value) {
  return new TextEncoder().encode(value);
}
function dataUrlBytes(dataUrl) {
  const base64 = dataUrl.split(",")[1] ?? "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
function dosDateTime(value) {
  const date = Number.isNaN(value.getTime()) ? /* @__PURE__ */ new Date() : value;
  const year = Math.max(1980, date.getFullYear());
  return {
    time: date.getHours() << 11 | date.getMinutes() << 5 | Math.floor(date.getSeconds() / 2),
    date: year - 1980 << 9 | date.getMonth() + 1 << 5 | date.getDate()
  };
}
function crc32(bytes) {
  let crc = 4294967295;
  for (const byte of bytes) {
    crc = crc >>> 8 ^ CRC_TABLE[(crc ^ byte) & 255];
  }
  return (crc ^ 4294967295) >>> 0;
}
var CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 3988292384 ^ value >>> 1 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

// src/shared/github.ts
var GITHUB_API_URL = "https://api.github.com";
async function createGitHubIssue(token, repo, issue) {
  return githubFetch(token, `/repos/${repo.owner}/${repo.name}/issues`, {
    method: "POST",
    body: JSON.stringify(issue)
  });
}
function buildGitHubIssue({
  session: session2,
  report: report2,
  labels = ["bug"]
}) {
  const title = buildIssueTitle(session2, report2);
  const body = `${report2.trim()}

---

## RAW Console
${formatRawConsole(session2.consoleErrors ?? [])}

## RAW Network
${formatRawNetwork(session2.networkRequests ?? [])}

---

Created with Screenshot2Bug.

Note: screenshots and recordings are kept in the local ZIP export for this report and are not uploaded to GitHub in this version.`;
  return {
    title,
    body,
    labels: labels.filter(Boolean)
  };
}
function buildIssueTitle(session2, report2) {
  const reportTitle = extractReportTitle(report2);
  if (reportTitle) return normalizeIssueTitle(reportTitle);
  const pageTitle = session2.metadata?.title?.trim();
  const url = session2.metadata?.url?.trim();
  if (pageTitle) return normalizeIssueTitle(pageTitle);
  if (url) return normalizeIssueTitle(url);
  return `Bug report ${session2.id.slice(0, 8)}`;
}
function extractReportTitle(report2) {
  const lines = report2.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const bugLine = lines.slice(0, 20).find((line) => /^#{0,6}\s*bug\s*:/i.test(line) && !/^#{0,6}\s*bug report\s*:/i.test(line));
  const heading = lines.find((line) => /^#{1,2}\s+\S/.test(line));
  const candidate = bugLine?.replace(/^#{1,6}\s+/, "") ?? heading?.replace(/^#{1,6}\s+/, "");
  return candidate?.replace(/^bug report\s*:\s*/i, "").trim();
}
function normalizeIssueTitle(title) {
  const normalized = title.replace(/\s+/g, " ").trim();
  const withPrefix = /^bug\s*:/i.test(normalized) ? normalized : `Bug: ${normalized}`;
  return withPrefix.slice(0, 256);
}
function formatRawConsole(entries) {
  if (!entries.length) return "_No raw console entries captured._";
  return fencedJson(entries);
}
function formatRawNetwork(entries) {
  if (!entries.length) return "_No raw network entries captured._";
  return fencedJson(entries);
}
function fencedJson(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
async function githubFetch(token, path, init2 = {}) {
  const response = await fetch(`${GITHUB_API_URL}${path}`, {
    ...init2,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init2.headers || {}
    }
  });
  return parseGitHubResponse(response);
}
async function parseGitHubResponse(response) {
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data.message || `GitHub request failed with ${response.status}`;
    throw new Error(message);
  }
  return data;
}

// src/popup/main.ts
var app = document.querySelector("#app");
if (!app) throw new Error("Missing app root.");
var root = app;
var session;
var sessions = [];
var steps = "";
var notes = "";
var report = "";
var busyLabel = "";
var statusMessage = "";
var githubStatusMessage = "";
var pollHandle;
var editState;
void init();
async function init() {
  const sessionId = new URLSearchParams(window.location.search).get("sessionId") ?? void 0;
  if (sessionId) {
    await request({ type: "SET_ACTIVE_SESSION", sessionId });
    session = await request({ type: "GET_SESSION", sessionId });
    report = session ? buildTemplateReport({ session, steps, notes }) : "";
    startPolling();
  } else {
    const latest = await request({ type: "GET_SESSION" });
    session = latest;
    report = latest ? buildTemplateReport({ session: latest, steps, notes }) : "";
  }
  await refreshSessions();
  render();
}
function render() {
  root.innerHTML = `
    <section class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Screenshot2Bug</p>
          <h1>${session ? modeTitle(session) : "Capture a bug"}</h1>
        </div>
        <button class="icon-button" id="settingsButton" title="Settings" aria-label="Settings">\u2699</button>
      </header>

      ${statusMessage ? `<p class="notice">${escapeHtml(statusMessage)}</p>` : ""}
      ${session?.notice ? `<p class="notice">${escapeHtml(session.notice)}</p>` : ""}
      ${session?.error ? `<p class="error">${escapeHtml(session.error)}</p>` : ""}

      <section class="panel">
        <h2>New capture</h2>
        <div class="capture-grid">
          <button class="mode-card" id="screenshotFullButton">
            <span class="mode-icon">\u25A3</span>
            <span>
              <strong>Screenshot</strong>
              <small>Full tab</small>
            </span>
          </button>
          <button class="mode-card" id="screenshotRegionButton">
            <span class="mode-icon">\u2316</span>
            <span>
              <strong>Screenshot</strong>
              <small>Select area</small>
            </span>
          </button>
          <button class="mode-card" id="videoFullButton">
            <span class="mode-icon">\u25CF</span>
            <span>
              <strong>Video</strong>
              <small>Full tab</small>
            </span>
          </button>
          <button class="mode-card" id="videoRegionButton">
            <span class="mode-icon">\u25C9</span>
            <span>
              <strong>Video</strong>
              <small>Select area</small>
            </span>
          </button>
        </div>
      </section>

      ${session ? renderSession(session) : renderEmpty()}
      ${renderReportsList()}
    </section>
  `;
  bindEvents();
  mountEditor();
}
function renderEmpty() {
  return `
    <section class="panel">
      <h2>Ready when the bug is.</h2>
      <p class="muted">Start a new report above. Old drafts will appear in the Reports list.</p>
    </section>
  `;
}
function renderSession(current) {
  const metadata = current.metadata;
  const canStop = current.status === "recording";
  const canExport = current.status === "ready" || current.status === "failed";
  return `
    <section class="panel">
      <h2>Current report</h2>
      <section class="status-row">
        <span class="status-pill ${current.status}">${current.status}</span>
        <span class="muted">${metadata?.title ? escapeHtml(metadata.title) : "Untitled report"}</span>
      </section>
      <p class="muted">${metadata?.url ? escapeHtml(metadata.url) : "Waiting for page context"}</p>
      <section class="meta-grid">
        <div><strong>${formatDate(current.createdAt)}</strong><span>created</span></div>
        <div><strong>${current.consoleErrors.length}</strong><span>console errors</span></div>
        <div><strong>${current.networkRequests.length}</strong><span>network requests</span></div>
        <div><strong>${metadata ? `${metadata.viewport.width}x${metadata.viewport.height}` : "--"}</strong><span>viewport</span></div>
      </section>
      <div class="actions">
        <button id="doneButton" ${current.status === "recording" ? "disabled" : ""}>Done</button>
      </div>
    </section>

    ${canStop ? `<button class="primary danger" id="stopRecordingButton">Stop recording</button>` : ""}

    <section class="panel">
      <h2>Add evidence</h2>
      <div class="capture-grid compact">
        <button id="addScreenshotFullButton" ${busyLabel ? "disabled" : ""}>Screenshot: full tab</button>
        <button id="addScreenshotRegionButton" ${busyLabel ? "disabled" : ""}>Screenshot: select area</button>
        <button id="addVideoFullButton" ${busyLabel || current.status === "recording" ? "disabled" : ""}>Video: full tab</button>
        <button id="addVideoRegionButton" ${busyLabel || current.status === "recording" ? "disabled" : ""}>Video: select area</button>
      </div>
      <p class="muted">Keyboard shortcuts start new captures. Existing reports use these evidence buttons.</p>
    </section>

    <section class="panel">
      <h2>Attached evidence</h2>
      ${renderEvidence(current)}
    </section>

    ${renderEditPanel(current)}

    <label class="field">
      <span>Reproduction steps</span>
      <textarea id="stepsInput" rows="5" placeholder="1. Open settings&#10;2. Change plan&#10;3. See checkout fail">${escapeHtml(steps)}</textarea>
    </label>

    <label class="field">
      <span>Observed behavior / notes</span>
      <textarea id="notesInput" rows="4" placeholder="What happened? What did you expect?">${escapeHtml(notes)}</textarea>
    </label>

    <div class="actions">
      <button class="primary" id="aiButton" ${busyLabel || !canExport ? "disabled" : ""}>${busyLabel || "Generate AI report"}</button>
      <button id="templateButton" ${!canExport ? "disabled" : ""}>Refresh template</button>
    </div>

    <label class="field">
      <span>Bug report</span>
      <textarea id="reportOutput" rows="12">${escapeHtml(report)}</textarea>
    </label>

    <div class="actions">
      <button id="copyButton" ${!report ? "disabled" : ""}>Copy Markdown</button>
      <button id="downloadButton" ${!report ? "disabled" : ""}>Download ZIP</button>
    </div>

    <section class="panel">
      <h2>GitHub issue</h2>
      ${githubStatusMessage ? `<p class="notice">${escapeHtml(githubStatusMessage)}</p>` : ""}
      <p class="muted">${renderGitHubHelp()}</p>
      <button class="primary" id="createGitHubIssueButton" ${!report || busyLabel ? "disabled" : ""}>Create GitHub issue</button>
    </section>
  `;
}
function renderEvidence(current) {
  const items = [];
  for (const [index, screenshot] of (current.screenshots ?? []).entries()) {
    const area = screenshot.captureArea === "region" ? "Selected area" : "Full tab";
    items.push(`
      <article class="evidence-item">
        <div class="evidence-heading">
          <div><strong>Screenshot ${index + 1}</strong><span>${area} PNG included in ZIP</span></div>
          <div class="evidence-actions">
            <button data-edit-screenshot="${screenshot.id}">Edit</button>
            <button data-download-screenshot="${screenshot.id}">Download</button>
          </div>
        </div>
        <img class="preview" src="${screenshot.dataUrl}" alt="Attached screenshot ${index + 1}" />
      </article>
    `);
  }
  for (const [index, recording] of (current.recordings ?? []).entries()) {
    const area = recording.captureArea === "region" ? "Selected area" : "Full tab";
    items.push(`
      <article class="evidence-item">
        <div class="evidence-heading">
          <div><strong>Video ${index + 1}</strong><span>${area} WebM included in ZIP</span></div>
          <div class="evidence-actions">
            <button data-download-recording="${recording.id}">Download</button>
          </div>
        </div>
        <video class="preview" src="${recording.dataUrl}" controls></video>
      </article>
    `);
  }
  return items.length ? items.join("") : `<div class="preview placeholder">${statusCopy(current)}</div>`;
}
function renderEditPanel(current) {
  if (!editState) return "";
  const screenshot = (current.screenshots ?? []).find((item) => item.id === editState?.screenshotId);
  if (!screenshot) return "";
  const toolButton = (tool, label) => `
    <button class="${editState?.tool === tool ? "active-tool" : ""}" data-edit-tool="${tool}">${label}</button>
  `;
  return `
    <section class="panel edit-panel">
      <div class="editor-topbar">
        <h2>Edit screenshot</h2>
        <button class="icon-button" id="closeEditorButton" title="Close editor" aria-label="Close editor">\xD7</button>
      </div>
      <div class="tool-row">
        ${toolButton("crop", "Crop")}
        ${toolButton("rect", "Box")}
        ${toolButton("arrow", "Arrow")}
        ${toolButton("blur", "Blur")}
        ${toolButton("text", "Text")}
      </div>
      <canvas id="screenshotEditor" class="editor-canvas" aria-label="Screenshot editor"></canvas>
      <div class="actions">
        <button id="undoEditButton" ${editState.history.length < 2 ? "disabled" : ""}>Undo</button>
        <button id="resetEditButton" ${screenshot.originalDataUrl ? "" : "disabled"}>Reset</button>
        <button class="primary" id="saveEditButton">Save</button>
        <button id="cancelEditButton">Cancel</button>
      </div>
    </section>
  `;
}
function renderReportsList() {
  if (!sessions.length) return "";
  const rows = sessions.map((item) => {
    const active = item.id === session?.id;
    const title = item.metadata?.title || item.metadata?.url || "Untitled report";
    const evidence = [
      item.screenshots?.length ? `${item.screenshots.length} screenshot${item.screenshots.length === 1 ? "" : "s"}` : "",
      item.recordings?.length ? `${item.recordings.length} video${item.recordings.length === 1 ? "" : "s"}` : ""
    ].filter(Boolean).join(" + ");
    return `
        <article class="report-row ${active ? "active" : ""}">
          <div>
            <strong>${escapeHtml(title)}</strong>
            <span>${formatDate(item.updatedAt)} \xB7 ${item.status}${evidence ? ` \xB7 ${evidence}` : ""}</span>
          </div>
          <button data-open-session="${item.id}" ${active ? "disabled" : ""}>${active ? "Open" : "Reopen"}</button>
        </article>
      `;
  }).join("");
  return `
    <section class="panel">
      <h2>Reports</h2>
      <div class="report-list">${rows}</div>
    </section>
  `;
}
function bindEvents() {
  document.querySelector("#settingsButton")?.addEventListener("click", () => {
    void chrome.runtime.openOptionsPage();
  });
  document.querySelector("#screenshotFullButton")?.addEventListener("click", () => {
    void runCapture({ type: "CAPTURE_SCREENSHOT", area: "full" });
  });
  document.querySelector("#screenshotRegionButton")?.addEventListener("click", () => {
    void runCapture({ type: "CAPTURE_SCREENSHOT", area: "region" });
  });
  document.querySelector("#videoFullButton")?.addEventListener("click", () => {
    void runCapture({ type: "START_VIDEO_CAPTURE", area: "full" });
  });
  document.querySelector("#videoRegionButton")?.addEventListener("click", () => {
    void runCapture({ type: "START_VIDEO_CAPTURE", area: "region" });
  });
  document.querySelector("#stopRecordingButton")?.addEventListener("click", () => {
    void stopRecording();
  });
  document.querySelector("#stepsInput")?.addEventListener("input", (event) => {
    steps = event.target.value;
  });
  document.querySelector("#notesInput")?.addEventListener("input", (event) => {
    notes = event.target.value;
  });
  document.querySelector("#reportOutput")?.addEventListener("input", (event) => {
    report = event.target.value;
  });
  document.querySelector("#templateButton")?.addEventListener("click", () => {
    if (!session) return;
    report = buildTemplateReport({ session, steps, notes });
    void closeReportFocus("Template report refreshed. Report closed.");
  });
  document.querySelector("#addScreenshotFullButton")?.addEventListener("click", () => void addScreenshot("full"));
  document.querySelector("#addScreenshotRegionButton")?.addEventListener("click", () => void addScreenshot("region"));
  document.querySelector("#addVideoFullButton")?.addEventListener("click", () => void addVideo("full"));
  document.querySelector("#addVideoRegionButton")?.addEventListener("click", () => void addVideo("region"));
  document.querySelector("#aiButton")?.addEventListener("click", () => void generateReport());
  document.querySelector("#copyButton")?.addEventListener("click", () => void copyReport());
  document.querySelector("#downloadButton")?.addEventListener("click", () => void downloadBundle());
  document.querySelector("#createGitHubIssueButton")?.addEventListener("click", () => void createIssue());
  document.querySelector("#doneButton")?.addEventListener("click", () => {
    void closeReportFocus("Report closed. New captures will start a fresh report.");
  });
  document.querySelector("#closeEditorButton")?.addEventListener("click", closeEditor);
  document.querySelector("#cancelEditButton")?.addEventListener("click", closeEditor);
  document.querySelector("#undoEditButton")?.addEventListener("click", undoEdit);
  document.querySelector("#resetEditButton")?.addEventListener("click", resetEdit);
  document.querySelector("#saveEditButton")?.addEventListener("click", () => void saveEdit());
  document.querySelectorAll("[data-edit-tool]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!editState) return;
      editState.tool = button.getAttribute("data-edit-tool");
      render();
    });
  });
  document.querySelectorAll("[data-edit-screenshot]").forEach((button) => {
    button.addEventListener("click", () => {
      const screenshotId = button.getAttribute("data-edit-screenshot");
      if (screenshotId) openEditor(screenshotId);
    });
  });
  document.querySelectorAll("[data-download-screenshot]").forEach((button) => {
    button.addEventListener("click", () => {
      const screenshotId = button.getAttribute("data-download-screenshot");
      if (screenshotId) downloadScreenshot(screenshotId);
    });
  });
  document.querySelectorAll("[data-download-recording]").forEach((button) => {
    button.addEventListener("click", () => {
      const recordingId = button.getAttribute("data-download-recording");
      if (recordingId) downloadRecording(recordingId);
    });
  });
  document.querySelectorAll("[data-open-session]").forEach((button) => {
    button.addEventListener("click", () => {
      const sessionId = button.getAttribute("data-open-session");
      if (sessionId) void openSession(sessionId);
    });
  });
}
async function addScreenshot(area) {
  if (!session) return;
  busyLabel = area === "region" ? "Select an area..." : "Adding...";
  statusMessage = "";
  render();
  try {
    session = await request({
      type: "ADD_SCREENSHOT_TO_SESSION",
      sessionId: session.id,
      area
    });
    report = buildTemplateReport({ session, steps, notes });
    statusMessage = area === "region" ? "Selected-area screenshot attached to this report." : "Screenshot attached to this report.";
    await refreshSessions();
  } catch (error) {
    statusMessage = error instanceof Error ? error.message : String(error);
  } finally {
    busyLabel = "";
    render();
  }
}
async function addVideo(area) {
  if (!session) return;
  busyLabel = area === "region" ? "Select an area..." : "Starting...";
  statusMessage = "";
  render();
  try {
    session = await request({
      type: "ADD_VIDEO_TO_SESSION",
      sessionId: session.id,
      area
    });
    report = buildTemplateReport({ session, steps, notes });
    statusMessage = area === "region" ? "Selected-area video recording started for this report." : "Video recording started for this report.";
    await refreshSessions();
    startPolling();
  } catch (error) {
    statusMessage = error instanceof Error ? error.message : String(error);
  } finally {
    busyLabel = "";
    render();
  }
}
async function runCapture(message) {
  const area = "area" in message ? message.area : void 0;
  busyLabel = area === "region" ? "Select an area..." : "Capturing...";
  statusMessage = "";
  render();
  try {
    session = await request(message);
    editState = void 0;
    githubStatusMessage = "";
    report = session ? buildTemplateReport({ session, steps, notes }) : "";
    await refreshSessions();
    startPolling();
  } catch (error) {
    statusMessage = error instanceof Error ? error.message : String(error);
  } finally {
    busyLabel = "";
    render();
  }
}
async function openSession(sessionId) {
  session = await request({ type: "SET_ACTIVE_SESSION", sessionId });
  editState = void 0;
  githubStatusMessage = "";
  report = session ? buildTemplateReport({ session, steps, notes }) : "";
  statusMessage = "Report reopened. New attachments will be added here.";
  await refreshSessions();
  startPolling();
  render();
}
async function generateReport() {
  if (!session) return;
  busyLabel = "Generating...";
  statusMessage = "";
  render();
  try {
    const settings = await getSettings();
    if (!settings.openaiApiKey) {
      report = buildTemplateReport({ session, steps, notes });
      statusMessage = "No API key saved. Generated a template report instead.";
      return;
    }
    report = await generateAiReport(
      settings.openaiApiKey,
      settings.openaiModel || DEFAULT_MODEL,
      { session, steps, notes }
    );
    statusMessage = "AI report generated.";
  } catch (error) {
    report = buildTemplateReport({ session, steps, notes });
    statusMessage = `${error instanceof Error ? error.message : String(error)} Template report used instead.`;
  } finally {
    busyLabel = "";
    render();
  }
}
async function stopRecording() {
  if (!session) return;
  statusMessage = "Saving recording...";
  session = { ...session, status: "capturing" };
  render();
  try {
    await request({ type: "STOP_VIDEO_CAPTURE", sessionId: session.id });
    startPolling();
  } catch (error) {
    statusMessage = error instanceof Error ? error.message : String(error);
    render();
  }
}
async function copyReport() {
  await navigator.clipboard.writeText(report);
  await closeReportFocus("Markdown copied. Report closed.");
}
async function downloadBundle() {
  if (!session) return;
  const basename = `screenshot2bug-${session.id.slice(0, 8)}`;
  const zip = await buildReportZip({ session, report });
  const url = URL.createObjectURL(zip);
  downloadDataUrl(`${basename}.zip`, url, true);
  await closeReportFocus("ZIP download started. Report closed.");
}
function openEditor(screenshotId) {
  const screenshot = getScreenshot(screenshotId);
  if (!screenshot) return;
  editState = {
    screenshotId,
    history: [screenshot.dataUrl],
    tool: "rect"
  };
  statusMessage = "";
  render();
}
function closeEditor() {
  editState = void 0;
  render();
}
function undoEdit() {
  if (!editState || editState.history.length < 2) return;
  editState.history.pop();
  render();
}
function resetEdit() {
  if (!editState) return;
  const screenshot = getScreenshot(editState.screenshotId);
  const original = screenshot?.originalDataUrl;
  if (!original) return;
  editState.history = [original];
  render();
}
async function saveEdit() {
  if (!session || !editState) return;
  const screenshot = getScreenshot(editState.screenshotId);
  if (!screenshot) return;
  const editedDataUrl = editState.history.at(-1);
  if (!editedDataUrl) return;
  const screenshots = (session.screenshots ?? []).map(
    (item) => item.id === screenshot.id ? {
      ...item,
      dataUrl: editedDataUrl,
      originalDataUrl: item.originalDataUrl ?? item.dataUrl,
      editedAt: (/* @__PURE__ */ new Date()).toISOString()
    } : item
  );
  session = await request({
    type: "UPDATE_SESSION",
    sessionId: session.id,
    patch: {
      screenshots,
      screenshotDataUrl: screenshots.at(-1)?.dataUrl
    }
  });
  report = buildTemplateReport({ session, steps, notes });
  editState = void 0;
  statusMessage = "Screenshot edits saved.";
  await refreshSessions();
  render();
}
async function closeReportFocus(message = "") {
  const sessionId = session?.id;
  if (sessionId) {
    await request({ type: "CLEAR_ACTIVE_SESSION", sessionId });
  } else {
    await request({ type: "CLEAR_ACTIVE_SESSION" });
  }
  if (pollHandle) {
    window.clearInterval(pollHandle);
    pollHandle = void 0;
  }
  session = void 0;
  editState = void 0;
  steps = "";
  notes = "";
  report = "";
  busyLabel = "";
  statusMessage = message;
  githubStatusMessage = "";
  await refreshSessions();
  render();
}
function downloadScreenshot(screenshotId) {
  const screenshot = getScreenshot(screenshotId);
  if (!screenshot) return;
  const index = (session?.screenshots ?? []).findIndex((item) => item.id === screenshotId) + 1;
  downloadDataUrl(`screenshot2bug-screenshot-${index || 1}.png`, screenshot.dataUrl);
}
function downloadRecording(recordingId) {
  const recording = (session?.recordings ?? []).find((item) => item.id === recordingId);
  if (!recording) return;
  const index = (session?.recordings ?? []).findIndex((item) => item.id === recordingId) + 1;
  downloadDataUrl(`screenshot2bug-recording-${index || 1}.webm`, recording.dataUrl);
}
function getScreenshot(screenshotId) {
  return (session?.screenshots ?? []).find((item) => item.id === screenshotId);
}
function mountEditor() {
  if (!editState) return;
  const canvas = document.querySelector("#screenshotEditor");
  if (!canvas) return;
  const dataUrl = editState.history.at(-1);
  if (!dataUrl) return;
  const image = new Image();
  image.onload = () => {
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(image, 0, 0);
  };
  image.src = dataUrl;
  let start;
  canvas.addEventListener("pointerdown", (event) => {
    if (!editState) return;
    const point = canvasPoint(canvas, event);
    if (editState.tool === "text") {
      const value = window.prompt("Text to add");
      if (!value) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.font = `${Math.max(18, Math.round(canvas.width / 36))}px system-ui, sans-serif`;
      context.lineWidth = Math.max(3, Math.round(canvas.width / 260));
      context.strokeStyle = "#ffffff";
      context.fillStyle = "#b23a26";
      context.strokeText(value, point.x, point.y);
      context.fillText(value, point.x, point.y);
      pushEditSnapshot(canvas);
      return;
    }
    start = point;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!editState || !start) return;
    const end = canvasPoint(canvas, event);
    applyEditGesture(canvas, editState.tool, start, end);
    start = void 0;
  });
}
function applyEditGesture(canvas, tool, start, end) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const rect = normalizeRect(start, end);
  if ((tool === "crop" || tool === "blur") && (rect.width < 4 || rect.height < 4)) return;
  if (tool === "crop") {
    const image = context.getImageData(rect.x, rect.y, rect.width, rect.height);
    canvas.width = rect.width;
    canvas.height = rect.height;
    canvas.getContext("2d")?.putImageData(image, 0, 0);
    pushEditSnapshot(canvas);
    return;
  }
  if (tool === "blur") {
    context.save();
    context.filter = "blur(8px)";
    context.drawImage(canvas, rect.x, rect.y, rect.width, rect.height, rect.x, rect.y, rect.width, rect.height);
    context.restore();
    context.strokeStyle = "rgba(255,255,255,.75)";
    context.lineWidth = Math.max(2, Math.round(canvas.width / 420));
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    pushEditSnapshot(canvas);
    return;
  }
  context.save();
  context.strokeStyle = "#b23a26";
  context.fillStyle = "#b23a26";
  context.lineWidth = Math.max(4, Math.round(canvas.width / 220));
  context.lineCap = "round";
  context.lineJoin = "round";
  if (tool === "rect") {
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  }
  if (tool === "arrow") {
    drawArrow(context, start.x, start.y, end.x, end.y, context.lineWidth);
  }
  context.restore();
  pushEditSnapshot(canvas);
}
function drawArrow(context, startX, startY, endX, endY, lineWidth) {
  const angle = Math.atan2(endY - startY, endX - startX);
  const headLength = Math.max(14, lineWidth * 4);
  context.beginPath();
  context.moveTo(startX, startY);
  context.lineTo(endX, endY);
  context.lineTo(
    endX - headLength * Math.cos(angle - Math.PI / 6),
    endY - headLength * Math.sin(angle - Math.PI / 6)
  );
  context.moveTo(endX, endY);
  context.lineTo(
    endX - headLength * Math.cos(angle + Math.PI / 6),
    endY - headLength * Math.sin(angle + Math.PI / 6)
  );
  context.stroke();
}
function pushEditSnapshot(canvas) {
  if (!editState) return;
  editState.history = [...editState.history, canvas.toDataURL("image/png")];
  render();
}
function canvasPoint(canvas, event) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: Math.round((event.clientX - bounds.left) / bounds.width * canvas.width),
    y: Math.round((event.clientY - bounds.top) / bounds.height * canvas.height)
  };
}
function normalizeRect(start, end) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  };
}
async function createIssue() {
  if (!session) return;
  busyLabel = "Creating...";
  githubStatusMessage = "";
  render();
  try {
    const settings = await getSettings();
    if (!settings.githubAccessToken) {
      githubStatusMessage = "Connect GitHub in Settings first.";
      return;
    }
    if (!settings.githubSelectedRepo) {
      githubStatusMessage = "Select a GitHub repository in Settings first.";
      return;
    }
    const issue = buildGitHubIssue({
      session,
      report,
      labels: settings.githubDefaultLabels ?? ["bug"]
    });
    const created = await createGitHubIssue(
      settings.githubAccessToken,
      settings.githubSelectedRepo,
      issue
    );
    await closeReportFocus(`Created GitHub issue #${created.number}: ${created.html_url}. Report closed.`);
    return;
  } catch (error) {
    githubStatusMessage = error instanceof Error ? error.message : String(error);
  } finally {
    if (session) {
      busyLabel = "";
      render();
    }
  }
}
function downloadDataUrl(filename, url, revoke = false) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  if (revoke) window.setTimeout(() => URL.revokeObjectURL(url), 500);
}
function startPolling() {
  if (pollHandle) window.clearInterval(pollHandle);
  pollHandle = window.setInterval(async () => {
    if (!session) return;
    const latest = await request({ type: "GET_SESSION", sessionId: session.id });
    if (!latest) return;
    const shouldRefreshReport = latest.status !== session.status || latest.recordingDataUrl !== session.recordingDataUrl || latest.screenshotDataUrl !== session.screenshotDataUrl || latest.consoleErrors.length !== session.consoleErrors.length || latest.networkRequests.length !== session.networkRequests.length;
    session = latest;
    if (shouldRefreshReport) report = buildTemplateReport({ session, steps, notes });
    await refreshSessions();
    render();
    if (latest.status === "ready" || latest.status === "failed") {
      window.clearInterval(pollHandle);
      pollHandle = void 0;
    }
  }, 1e3);
}
async function refreshSessions() {
  try {
    sessions = await request({ type: "GET_SESSIONS" });
  } catch {
    sessions = await getSortedSessions();
  }
}
async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? "Extension request failed.");
  return response.data;
}
function modeTitle(current) {
  return current.mode === "video" ? "Video bug report" : "Screenshot bug report";
}
function statusCopy(current) {
  if (current.status === "recording") return "Recording active tab...";
  if (current.status === "capturing") return "Capturing context...";
  if (current.status === "failed") return "Capture failed";
  return "No evidence attached yet";
}
function renderGitHubHelp() {
  return "Creates an issue in the repository selected in Settings. Screenshots and recordings stay in the local ZIP export.";
}
function formatDate(value) {
  return new Intl.DateTimeFormat(void 0, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
