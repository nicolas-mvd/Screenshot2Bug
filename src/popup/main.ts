import "../shared/styles.css";
import { buildTemplateReport, generateAiReport } from "../shared/report";
import { getSettings, getSortedSessions } from "../shared/storage";
import { DEFAULT_MODEL } from "../shared/types";
import { buildReportZip } from "../shared/zip";
import { uploadCloudinaryScreenshots } from "../shared/cloudinary";
import { buildGitHubIssue, createGitHubIssue } from "../shared/github";
import type { IssueScreenshotLink } from "../shared/github";
import type {
  BackgroundResponse,
  CaptureArea,
  CaptureSession,
  EvidenceAttachment,
  RuntimeMessage
} from "../shared/types";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing app root.");
const root = app;

let session: CaptureSession | undefined;
let sessions: CaptureSession[] = [];
let steps = "";
let notes = "";
let report = "";
let busyLabel = "";
let statusMessage = "";
let githubStatusMessage = "";
let pollHandle: number | undefined;
let editState: ScreenshotEditState | undefined;

type EditTool = "crop" | "rect" | "arrow" | "blur" | "text";

interface ScreenshotEditState {
  screenshotId: string;
  history: string[];
  tool: EditTool;
}

void init();

async function init(): Promise<void> {
  const sessionId = new URLSearchParams(window.location.search).get("sessionId") ?? undefined;
  if (sessionId) {
    await request<CaptureSession>({ type: "SET_ACTIVE_SESSION", sessionId });
    session = await request<CaptureSession>({ type: "GET_SESSION", sessionId });
    report = session ? buildTemplateReport({ session, steps, notes }) : "";
    startPolling();
  } else {
    const latest = await request<CaptureSession | undefined>({ type: "GET_SESSION" });
    session = latest;
    report = latest ? buildTemplateReport({ session: latest, steps, notes }) : "";
  }
  await refreshSessions();
  render();
}

function render(): void {
  root.innerHTML = `
    <section class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Screenshot2Bug</p>
          <h1>${session ? modeTitle(session) : "Capture a bug"}</h1>
        </div>
        <button class="icon-button" id="settingsButton" title="Settings" aria-label="Settings">⚙</button>
      </header>

      ${statusMessage ? `<p class="notice">${escapeHtml(statusMessage)}</p>` : ""}
      ${session?.notice ? `<p class="notice">${escapeHtml(session.notice)}</p>` : ""}
      ${session?.error ? `<p class="error">${escapeHtml(session.error)}</p>` : ""}

      <section class="panel">
        <h2>New capture</h2>
        <div class="capture-grid">
          <button class="mode-card" id="screenshotFullButton">
            <span class="mode-icon">▣</span>
            <span>
              <strong>Screenshot</strong>
              <small>Full tab</small>
            </span>
          </button>
          <button class="mode-card" id="screenshotRegionButton">
            <span class="mode-icon">⌖</span>
            <span>
              <strong>Screenshot</strong>
              <small>Select area</small>
            </span>
          </button>
          <button class="mode-card" id="videoFullButton">
            <span class="mode-icon">●</span>
            <span>
              <strong>Video</strong>
              <small>Full tab</small>
            </span>
          </button>
          <button class="mode-card" id="videoRegionButton">
            <span class="mode-icon">◉</span>
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

function renderEmpty(): string {
  return `
    <section class="panel">
      <h2>Ready when the bug is.</h2>
      <p class="muted">Start a new report above. Old drafts will appear in the Reports list.</p>
    </section>
  `;
}

function renderSession(current: CaptureSession): string {
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

function renderEvidence(current: CaptureSession): string {
  const items: string[] = [];
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
  return items.length
    ? items.join("")
    : `<div class="preview placeholder">${statusCopy(current)}</div>`;
}

function renderEditPanel(current: CaptureSession): string {
  if (!editState) return "";
  const screenshot = (current.screenshots ?? []).find((item) => item.id === editState?.screenshotId);
  if (!screenshot) return "";
  const toolButton = (tool: EditTool, label: string) => `
    <button class="${editState?.tool === tool ? "active-tool" : ""}" data-edit-tool="${tool}">${label}</button>
  `;

  return `
    <section class="panel edit-panel">
      <div class="editor-topbar">
        <h2>Edit screenshot</h2>
        <button class="icon-button" id="closeEditorButton" title="Close editor" aria-label="Close editor">×</button>
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

function renderReportsList(): string {
  if (!sessions.length) return "";
  const rows = sessions
    .map((item) => {
      const active = item.id === session?.id;
      const title = item.metadata?.title || item.metadata?.url || "Untitled report";
      const evidence = [
        item.screenshots?.length
          ? `${item.screenshots.length} screenshot${item.screenshots.length === 1 ? "" : "s"}`
          : "",
        item.recordings?.length
          ? `${item.recordings.length} video${item.recordings.length === 1 ? "" : "s"}`
          : ""
      ]
        .filter(Boolean)
        .join(" + ");
      return `
        <article class="report-row ${active ? "active" : ""}">
          <div>
            <strong>${escapeHtml(title)}</strong>
            <span>${formatDate(item.updatedAt)} · ${item.status}${evidence ? ` · ${evidence}` : ""}</span>
          </div>
          <button data-open-session="${item.id}" ${active ? "disabled" : ""}>${active ? "Open" : "Reopen"}</button>
        </article>
      `;
    })
    .join("");
  return `
    <section class="panel">
      <h2>Reports</h2>
      <div class="report-list">${rows}</div>
    </section>
  `;
}

function bindEvents(): void {
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
  document.querySelector<HTMLTextAreaElement>("#stepsInput")?.addEventListener("input", (event) => {
    steps = (event.target as HTMLTextAreaElement).value;
  });
  document.querySelector<HTMLTextAreaElement>("#notesInput")?.addEventListener("input", (event) => {
    notes = (event.target as HTMLTextAreaElement).value;
  });
  document.querySelector<HTMLTextAreaElement>("#reportOutput")?.addEventListener("input", (event) => {
    report = (event.target as HTMLTextAreaElement).value;
  });
  document.querySelector("#templateButton")?.addEventListener("click", () => {
    if (!session) return;
    report = buildTemplateReport({ session, steps, notes });
    void closeReportFocus("Template report refreshed. Report closed.");
  });
  document
    .querySelector("#addScreenshotFullButton")
    ?.addEventListener("click", () => void addScreenshot("full"));
  document
    .querySelector("#addScreenshotRegionButton")
    ?.addEventListener("click", () => void addScreenshot("region"));
  document
    .querySelector("#addVideoFullButton")
    ?.addEventListener("click", () => void addVideo("full"));
  document
    .querySelector("#addVideoRegionButton")
    ?.addEventListener("click", () => void addVideo("region"));
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
      editState.tool = button.getAttribute("data-edit-tool") as EditTool;
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

async function addScreenshot(area: CaptureArea): Promise<void> {
  if (!session) return;
  busyLabel = area === "region" ? "Select an area..." : "Adding...";
  statusMessage = "";
  render();
  try {
    session = await request<CaptureSession>({
      type: "ADD_SCREENSHOT_TO_SESSION",
      sessionId: session.id,
      area
    });
    report = buildTemplateReport({ session, steps, notes });
    statusMessage =
      area === "region"
        ? "Selected-area screenshot attached to this report."
        : "Screenshot attached to this report.";
    await refreshSessions();
  } catch (error) {
    statusMessage = error instanceof Error ? error.message : String(error);
  } finally {
    busyLabel = "";
    render();
  }
}

async function addVideo(area: CaptureArea): Promise<void> {
  if (!session) return;
  busyLabel = area === "region" ? "Select an area..." : "Starting...";
  statusMessage = "";
  render();
  try {
    session = await request<CaptureSession>({
      type: "ADD_VIDEO_TO_SESSION",
      sessionId: session.id,
      area
    });
    report = buildTemplateReport({ session, steps, notes });
    statusMessage =
      area === "region"
        ? "Selected-area video recording started for this report."
        : "Video recording started for this report.";
    await refreshSessions();
    startPolling();
  } catch (error) {
    statusMessage = error instanceof Error ? error.message : String(error);
  } finally {
    busyLabel = "";
    render();
  }
}

async function runCapture(message: RuntimeMessage): Promise<void> {
  const area = "area" in message ? message.area : undefined;
  busyLabel = area === "region" ? "Select an area..." : "Capturing...";
  statusMessage = "";
  render();
  try {
    session = await request<CaptureSession>(message);
    editState = undefined;
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

async function openSession(sessionId: string): Promise<void> {
  session = await request<CaptureSession>({ type: "SET_ACTIVE_SESSION", sessionId });
  editState = undefined;
  githubStatusMessage = "";
  report = session ? buildTemplateReport({ session, steps, notes }) : "";
  statusMessage = "Report reopened. New attachments will be added here.";
  await refreshSessions();
  startPolling();
  render();
}

async function generateReport(): Promise<void> {
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

async function stopRecording(): Promise<void> {
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

async function copyReport(): Promise<void> {
  await navigator.clipboard.writeText(report);
  await closeReportFocus("Markdown copied. Report closed.");
}

async function downloadBundle(): Promise<void> {
  if (!session) return;
  const basename = `screenshot2bug-${session.id.slice(0, 8)}`;
  const zip = await buildReportZip({ session, report });
  const url = URL.createObjectURL(zip);
  downloadDataUrl(`${basename}.zip`, url, true);
  await closeReportFocus("ZIP download started. Report closed.");
}

function openEditor(screenshotId: string): void {
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

function closeEditor(): void {
  editState = undefined;
  render();
}

function undoEdit(): void {
  if (!editState || editState.history.length < 2) return;
  editState.history.pop();
  render();
}

function resetEdit(): void {
  if (!editState) return;
  const screenshot = getScreenshot(editState.screenshotId);
  const original = screenshot?.originalDataUrl;
  if (!original) return;
  editState.history = [original];
  render();
}

async function saveEdit(): Promise<void> {
  if (!session || !editState) return;
  const screenshot = getScreenshot(editState.screenshotId);
  if (!screenshot) return;
  const editedDataUrl = editState.history.at(-1);
  if (!editedDataUrl) return;

  const screenshots = (session.screenshots ?? []).map((item) =>
    item.id === screenshot.id
      ? {
          ...item,
          dataUrl: editedDataUrl,
          originalDataUrl: item.originalDataUrl ?? item.dataUrl,
          editedAt: new Date().toISOString(),
          upload: undefined
        }
      : item
  );

  session = await request<CaptureSession>({
    type: "UPDATE_SESSION",
    sessionId: session.id,
    patch: {
      screenshots,
      screenshotDataUrl: screenshots.at(-1)?.dataUrl
    }
  });
  report = buildTemplateReport({ session, steps, notes });
  editState = undefined;
  statusMessage = "Screenshot edits saved.";
  await refreshSessions();
  render();
}

async function closeReportFocus(message = ""): Promise<void> {
  const sessionId = session?.id;
  if (sessionId) {
    await request({ type: "CLEAR_ACTIVE_SESSION", sessionId });
  } else {
    await request({ type: "CLEAR_ACTIVE_SESSION" });
  }
  if (pollHandle) {
    window.clearInterval(pollHandle);
    pollHandle = undefined;
  }
  session = undefined;
  editState = undefined;
  steps = "";
  notes = "";
  report = "";
  busyLabel = "";
  statusMessage = message;
  githubStatusMessage = "";
  await refreshSessions();
  render();
}

function downloadScreenshot(screenshotId: string): void {
  const screenshot = getScreenshot(screenshotId);
  if (!screenshot) return;
  const index = (session?.screenshots ?? []).findIndex((item) => item.id === screenshotId) + 1;
  downloadDataUrl(`screenshot2bug-screenshot-${index || 1}.png`, screenshot.dataUrl);
}

function downloadRecording(recordingId: string): void {
  const recording = (session?.recordings ?? []).find((item) => item.id === recordingId);
  if (!recording) return;
  const index = (session?.recordings ?? []).findIndex((item) => item.id === recordingId) + 1;
  downloadDataUrl(`screenshot2bug-recording-${index || 1}.webm`, recording.dataUrl);
}

function getScreenshot(screenshotId: string): EvidenceAttachment | undefined {
  return (session?.screenshots ?? []).find((item) => item.id === screenshotId);
}

function mountEditor(): void {
  if (!editState) return;
  const canvas = document.querySelector<HTMLCanvasElement>("#screenshotEditor");
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

  let start: { x: number; y: number } | undefined;

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
    start = undefined;
  });
}

function applyEditGesture(
  canvas: HTMLCanvasElement,
  tool: EditTool,
  start: { x: number; y: number },
  end: { x: number; y: number }
): void {
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

function drawArrow(
  context: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  lineWidth: number
): void {
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

function pushEditSnapshot(canvas: HTMLCanvasElement): void {
  if (!editState) return;
  editState.history = [...editState.history, canvas.toDataURL("image/png")];
  render();
}

function canvasPoint(
  canvas: HTMLCanvasElement,
  event: PointerEvent
): { x: number; y: number } {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: Math.round(((event.clientX - bounds.left) / bounds.width) * canvas.width),
    y: Math.round(((event.clientY - bounds.top) / bounds.height) * canvas.height)
  };
}

function normalizeRect(
  start: { x: number; y: number },
  end: { x: number; y: number }
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  };
}

async function createIssue(): Promise<void> {
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
    const screenshots = session.screenshots ?? [];
    let screenshotLinks: IssueScreenshotLink[] = [];
    if (screenshots.length) {
      busyLabel = "Uploading screenshots...";
      render();
      const uploaded = await uploadCloudinaryScreenshots({
        settings: {
          cloudName: settings.cloudinaryCloudName ?? "",
          uploadPreset: settings.cloudinaryUploadPreset ?? ""
        },
        session
      });
      session = await request<CaptureSession>({
        type: "UPDATE_SESSION",
        sessionId: session.id,
        patch: {
          screenshots: uploaded.screenshots,
          screenshotDataUrl: uploaded.screenshots.at(-1)?.dataUrl
        }
      });
      screenshotLinks = uploaded.links;
      await refreshSessions();
    }

    busyLabel = "Creating...";
    render();
    const issue = buildGitHubIssue({
      session,
      report,
      labels: settings.githubDefaultLabels ?? ["bug"],
      screenshotLinks
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

function downloadDataUrl(filename: string, url: string, revoke = false): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  if (revoke) window.setTimeout(() => URL.revokeObjectURL(url), 500);
}

function startPolling(): void {
  if (pollHandle) window.clearInterval(pollHandle);
  pollHandle = window.setInterval(async () => {
    if (!session) return;
    const latest = await request<CaptureSession>({ type: "GET_SESSION", sessionId: session.id });
    if (!latest) return;
    const shouldRefreshReport =
      latest.status !== session.status ||
      latest.recordingDataUrl !== session.recordingDataUrl ||
      latest.screenshotDataUrl !== session.screenshotDataUrl ||
      latest.consoleErrors.length !== session.consoleErrors.length ||
      latest.networkRequests.length !== session.networkRequests.length;
    session = latest;
    if (shouldRefreshReport) report = buildTemplateReport({ session, steps, notes });
    await refreshSessions();
    render();
    if (latest.status === "ready" || latest.status === "failed") {
      window.clearInterval(pollHandle);
      pollHandle = undefined;
    }
  }, 1000);
}

async function refreshSessions(): Promise<void> {
  try {
    sessions = await request<CaptureSession[]>({ type: "GET_SESSIONS" });
  } catch {
    sessions = await getSortedSessions();
  }
}

async function request<T>(message: RuntimeMessage): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as BackgroundResponse<T>;
  if (!response?.ok) throw new Error(response?.error ?? "Extension request failed.");
  return response.data as T;
}

function modeTitle(current: CaptureSession): string {
  return current.mode === "video" ? "Video bug report" : "Screenshot bug report";
}

function statusCopy(current: CaptureSession): string {
  if (current.status === "recording") return "Recording active tab...";
  if (current.status === "capturing") return "Capturing context...";
  if (current.status === "failed") return "Capture failed";
  return "No evidence attached yet";
}

function renderGitHubHelp(): string {
  return "Creates an issue in the repository selected in Settings. Screenshots upload to Cloudinary; recordings stay in the local ZIP export.";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
