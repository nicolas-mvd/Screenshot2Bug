import "../shared/styles.css";
import { buildTemplateReport, generateAiReport } from "../shared/report";
import { getSettings, getSortedSessions } from "../shared/storage";
import { DEFAULT_MODEL } from "../shared/types";
import { buildReportZip } from "../shared/zip";
import { buildGitHubIssue, createGitHubIssue } from "../shared/github";
import type {
  BackgroundResponse,
  CaptureSession,
  RuntimeMessage
} from "../shared/types";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing app root.");

let session: CaptureSession | undefined;
let sessions: CaptureSession[] = [];
let steps = "";
let notes = "";
let report = "";
let busyLabel = "";
let statusMessage = "";
let githubStatusMessage = "";
let pollHandle: number | undefined;

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
  app.innerHTML = `
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
        <h2>Start new report</h2>
        <div class="mode-grid">
          <button class="mode-card" id="screenshotButton">
            <span class="mode-icon">▣</span>
            <span>
              <strong>New screenshot report</strong>
              <small>Option+Shift+S</small>
            </span>
          </button>
          <button class="mode-card" id="videoButton">
            <span class="mode-icon">●</span>
            <span>
              <strong>New video report</strong>
              <small>Option+Shift+V</small>
            </span>
          </button>
        </div>
      </section>

      ${session ? renderSession(session) : renderEmpty()}
      ${renderReportsList()}
    </section>
  `;

  bindEvents();
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
        <div><strong>${metadata ? `${metadata.viewport.width}x${metadata.viewport.height}` : "--"}</strong><span>viewport</span></div>
      </section>
    </section>

    ${canStop ? `<button class="primary danger" id="stopRecordingButton">Stop recording</button>` : ""}

    <section class="panel">
      <h2>Add to current report</h2>
      <div class="actions">
        <button id="addScreenshotButton" ${busyLabel ? "disabled" : ""}>Attach screenshot</button>
        <button id="addVideoButton" ${busyLabel || current.status === "recording" ? "disabled" : ""}>Attach video</button>
      </div>
      <p class="muted">Control+Shift+S attaches a screenshot. Control+Shift+V attaches a video.</p>
    </section>

    <section class="panel">
      <h2>Attached evidence</h2>
      ${renderEvidence(current)}
    </section>

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
    items.push(`
      <article class="evidence-item">
        <div><strong>Attached screenshot ${index + 1}</strong><span>PNG included in ZIP</span></div>
        <img class="preview" src="${screenshot.dataUrl}" alt="Attached screenshot ${index + 1}" />
      </article>
    `);
  }
  for (const [index, recording] of (current.recordings ?? []).entries()) {
    items.push(`
      <article class="evidence-item">
        <div><strong>Attached video ${index + 1}</strong><span>WebM included in ZIP</span></div>
        <video class="preview" src="${recording.dataUrl}" controls></video>
      </article>
    `);
  }
  return items.length
    ? items.join("")
    : `<div class="preview placeholder">${statusCopy(current)}</div>`;
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
  document.querySelector("#screenshotButton")?.addEventListener("click", () => {
    void runCapture({ type: "CAPTURE_SCREENSHOT" });
  });
  document.querySelector("#videoButton")?.addEventListener("click", () => {
    void runCapture({ type: "START_VIDEO_CAPTURE" });
  });
  document.querySelector("#stopRecordingButton")?.addEventListener("click", () => {
    if (session) void request({ type: "STOP_VIDEO_CAPTURE", sessionId: session.id });
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
    statusMessage = "Template report refreshed.";
    render();
  });
  document.querySelector("#addScreenshotButton")?.addEventListener("click", () => void addScreenshot());
  document.querySelector("#addVideoButton")?.addEventListener("click", () => void addVideo());
  document.querySelector("#aiButton")?.addEventListener("click", () => void generateReport());
  document.querySelector("#copyButton")?.addEventListener("click", () => void copyReport());
  document.querySelector("#downloadButton")?.addEventListener("click", () => void downloadBundle());
  document.querySelector("#createGitHubIssueButton")?.addEventListener("click", () => void createIssue());
  document.querySelectorAll("[data-open-session]").forEach((button) => {
    button.addEventListener("click", () => {
      const sessionId = button.getAttribute("data-open-session");
      if (sessionId) void openSession(sessionId);
    });
  });
}

async function addScreenshot(): Promise<void> {
  if (!session) return;
  busyLabel = "Adding...";
  statusMessage = "";
  render();
  try {
    session = await request<CaptureSession>({
      type: "ADD_SCREENSHOT_TO_SESSION",
      sessionId: session.id
    });
    report = buildTemplateReport({ session, steps, notes });
    statusMessage = "Screenshot attached to this report.";
    await refreshSessions();
  } catch (error) {
    statusMessage = error instanceof Error ? error.message : String(error);
  } finally {
    busyLabel = "";
    render();
  }
}

async function addVideo(): Promise<void> {
  if (!session) return;
  busyLabel = "Starting...";
  statusMessage = "";
  render();
  try {
    session = await request<CaptureSession>({
      type: "ADD_VIDEO_TO_SESSION",
      sessionId: session.id
    });
    report = buildTemplateReport({ session, steps, notes });
    statusMessage = "Video recording started for this report.";
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
  busyLabel = "Capturing...";
  statusMessage = "";
  render();
  try {
    session = await request<CaptureSession>(message);
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

async function copyReport(): Promise<void> {
  await navigator.clipboard.writeText(report);
  statusMessage = "Markdown copied.";
  render();
}

async function downloadBundle(): Promise<void> {
  if (!session) return;
  const basename = `screenshot2bug-${session.id.slice(0, 8)}`;
  const zip = await buildReportZip({ session, report });
  const url = URL.createObjectURL(zip);
  downloadDataUrl(`${basename}.zip`, url, true);
  statusMessage = "ZIP download started.";
  render();
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
    githubStatusMessage = `Created issue #${created.number}: ${created.html_url}`;
  } catch (error) {
    githubStatusMessage = error instanceof Error ? error.message : String(error);
  } finally {
    busyLabel = "";
    render();
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
      latest.consoleErrors.length !== session.consoleErrors.length;
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
  return "Creates an issue in the repository selected in Settings. Screenshots and recordings stay in the local ZIP export.";
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
