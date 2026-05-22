import {
  appendConsoleEntry,
  appendNetworkEntry,
  clearActiveSession,
  getConsoleEntries,
  getNetworkEntries,
  getSession,
  getSortedSessions,
  normalizeSession,
  patchSession,
  saveSession,
  setActiveSession
} from "../shared/storage";
import type {
  BackgroundResponse,
  CaptureArea,
  CaptureMode,
  CaptureRegion,
  CaptureSession,
  NetworkEntry,
  PageMetadata,
  RuntimeMessage
} from "../shared/types";

const SENSITIVE_VALUE = "[redacted]";
const recordingControlRestoreTimers = new Map<number, number>();

interface PendingNetworkRequest {
  requestId: string;
  tabId: number;
  type?: string;
  method: string;
  url: string;
  timestamp: string;
  startedAtMs: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

const pendingNetworkRequests = new Map<string, PendingNetworkRequest>();

chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-screenshot-full") {
    void captureScreenshot(true, "full");
  }
  if (command === "capture-screenshot-region") {
    void captureScreenshot(true, "region");
  }
  if (command === "capture-video-full") {
    void captureVideo(true, "full");
  }
  if (command === "capture-video-region") {
    void captureVideo(true, "region");
  }
});

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!isInspectableTabRequest(details.tabId)) return undefined;
    pendingNetworkRequests.set(details.requestId, {
      requestId: details.requestId,
      tabId: details.tabId,
      type: details.type,
      method: details.method,
      url: sanitizeUrl(details.url),
      timestamp: new Date(details.timeStamp).toISOString(),
      startedAtMs: details.timeStamp,
      requestHeaders: sanitizeHeaderList(details.requestHeaders)
    });
    return undefined;
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!isInspectableTabRequest(details.tabId)) return undefined;
    const pending = getOrCreatePendingRequest(details);
    pending.responseHeaders = sanitizeHeaderList(details.responseHeaders);
    return undefined;
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!shouldCaptureCompletedRequest(details)) {
      pendingNetworkRequests.delete(details.requestId);
      return;
    }

    const pending = getOrCreatePendingRequest(details);
    const entry: NetworkEntry = sanitizeNetworkEntry({
      id: crypto.randomUUID(),
      source: "webRequest",
      requestId: details.requestId,
      type: details.type,
      method: details.method,
      url: pending.url || details.url,
      timestamp: pending.timestamp,
      completedAt: new Date(details.timeStamp).toISOString(),
      durationMs: Math.round(details.timeStamp - pending.startedAtMs),
      status: details.statusCode,
      statusText: details.statusLine,
      ok: details.statusCode >= 200 && details.statusCode < 400,
      fromCache: details.fromCache,
      requestHeaders: pending.requestHeaders,
      responseHeaders: pending.responseHeaders,
      responseBodyUnavailableReason: webRequestResponseBodyUnavailableReason()
    });

    void appendNetworkEntry(details.tabId, entry);
    pendingNetworkRequests.delete(details.requestId);
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (!isInspectableTabRequest(details.tabId)) return;
    const pending = getOrCreatePendingRequest(details);
    const entry: NetworkEntry = sanitizeNetworkEntry({
      id: crypto.randomUUID(),
      source: "webRequest",
      requestId: details.requestId,
      type: details.type,
      method: details.method,
      url: pending.url || details.url,
      timestamp: pending.timestamp,
      completedAt: new Date(details.timeStamp).toISOString(),
      durationMs: Math.round(details.timeStamp - pending.startedAtMs),
      ok: false,
      requestHeaders: pending.requestHeaders,
      responseHeaders: pending.responseHeaders,
      responseBodyUnavailableReason: webRequestResponseBodyUnavailableReason(),
      error: details.error
    });

    void appendNetworkEntry(details.tabId, entry);
    pendingNetworkRequests.delete(details.requestId);
  },
  { urls: ["<all_urls>"] }
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status || changeInfo.url) {
    scheduleRecordingControlsRestore(tabId);
  }
});

chrome.runtime.onMessage.addListener(
  (
    message: RuntimeMessage,
    sender,
    sendResponse: (response: BackgroundResponse) => void
  ) => {
    void handleMessage(message, sender)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      );
    return true;
  }
);

async function handleMessage(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  switch (message.type) {
    case "CAPTURE_SCREENSHOT":
      return captureScreenshot(false, message.area ?? "full");
    case "START_VIDEO_CAPTURE":
      return captureVideo(false, message.area ?? "full");
    case "ADD_SCREENSHOT_TO_SESSION":
      return addScreenshotToSession(message.sessionId, message.area ?? "full");
    case "ADD_VIDEO_TO_SESSION":
      return addVideoToSession(message.sessionId, message.area ?? "full");
    case "GET_SESSIONS":
      return getSortedSessions();
    case "SET_ACTIVE_SESSION":
      return setActiveSession(message.sessionId);
    case "CLEAR_ACTIVE_SESSION":
      return clearActiveSession(message.sessionId);
    case "STOP_VIDEO_CAPTURE":
      await refreshSessionEvidence(message.sessionId);
      await setRecordingControlsState(message.sessionId, "saving");
      await chrome.runtime.sendMessage({
        type: "OFFSCREEN_STOP_RECORDING",
        sessionId: message.sessionId
      } satisfies RuntimeMessage);
      return patchSession(message.sessionId, { status: "capturing" });
    case "GET_SESSION":
      return getSession(message.sessionId);
    case "UPDATE_SESSION":
      return patchSession(message.sessionId, message.patch);
    case "CONTENT_SCRIPT_READY":
      if (typeof sender.tab?.id === "number") {
        await restoreRecordingControlsForTab(sender.tab.id);
      }
      return undefined;
    case "LOG_CONSOLE_ENTRY":
      if (typeof sender.tab?.id === "number") {
        await appendConsoleEntry(sender.tab.id, message.entry);
      }
      return undefined;
    case "LOG_NETWORK_ENTRY":
      if (typeof sender.tab?.id === "number") {
        await appendNetworkEntry(sender.tab.id, sanitizeNetworkEntry(message.entry));
      }
      return undefined;
    case "OFFSCREEN_RECORDING_COMPLETE":
      return completeRecordingSession(
        message.sessionId,
        message.dataUrl,
        message.mimeType,
        message.region
      );
    case "OFFSCREEN_RECORDING_ERROR":
      await hideRecordingControlsForSession(message.sessionId);
      return patchSession(message.sessionId, {
        status: "failed",
        error: message.error
      });
    default:
      return undefined;
  }
}

async function captureScreenshot(
  openComposer: boolean,
  area: CaptureArea
): Promise<CaptureSession | undefined> {
  const focused = await getSession();
  if (focused) {
    const updated = await addScreenshotToSession(focused.id, area);
    if (openComposer) await openComposerWindow(focused.id);
    return updated;
  }
  return createScreenshotSession(openComposer, area);
}

async function captureVideo(
  openComposer: boolean,
  area: CaptureArea
): Promise<CaptureSession | undefined> {
  const focused = await getSession();
  if (focused) {
    if (focused.status === "recording") {
      throw new Error("Stop the current recording before starting another video.");
    }
    const updated = await addVideoToSession(focused.id, area);
    if (openComposer) await openComposerWindow(focused.id);
    return updated;
  }
  return createVideoSession(openComposer, area);
}

async function addScreenshotToSession(
  sessionId: string,
  area: CaptureArea
): Promise<CaptureSession | undefined> {
  const session = normalizeSession(await getSession(sessionId));
  if (!session) throw new Error("No capture session found.");
  const tab = await getActiveTab();
  await ensureCaptureScripts(tab.id);
  const region = area === "region" ? await selectRegion(tab.id) : undefined;
  const [metadata, consoleErrors, networkRequests, screenshotDataUrl] = await Promise.all([
    collectPageMetadata(tab.id),
    getConsoleEntries(tab.id),
    getNetworkEntries(tab.id),
    captureVisibleTab(tab.windowId)
  ]);
  const dataUrl = region
    ? await cropImageDataUrl(screenshotDataUrl, region)
    : screenshotDataUrl;
  const screenshot = {
    id: crypto.randomUUID(),
    dataUrl,
    createdAt: new Date().toISOString(),
    url: metadata.url,
    title: metadata.title,
    captureArea: area,
    region
  };

  return patchSession(sessionId, {
    tabId: tab.id,
    windowId: tab.windowId,
    metadata,
    consoleErrors,
    networkRequests,
    screenshots: [...(session.screenshots ?? []), screenshot],
    screenshotDataUrl: dataUrl
  });
}

async function completeRecordingSession(
  sessionId: string,
  dataUrl: string,
  mimeType: string,
  region?: CaptureRegion
): Promise<CaptureSession | undefined> {
  await refreshSessionEvidence(sessionId);
  const session = normalizeSession(await getSession(sessionId));
  if (!session) throw new Error("No capture session found.");
  if (typeof session.tabId === "number") {
    await hideRecordingControls(session.tabId, sessionId);
  }
  const recording = {
    id: crypto.randomUUID(),
    dataUrl,
    mimeType,
    createdAt: new Date().toISOString(),
    url: session.metadata?.url,
    title: session.metadata?.title,
    captureArea: region ? ("region" as const) : ("full" as const),
    region
  };
  return patchSession(sessionId, {
    status: "ready",
    recordings: [...(session.recordings ?? []), recording],
    recordingDataUrl: dataUrl,
    recordingMimeType: mimeType
  });
}

async function addVideoToSession(
  sessionId: string,
  area: CaptureArea
): Promise<CaptureSession | undefined> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("No capture session found.");
  const tab = await getActiveTab();
  await ensureCaptureScripts(tab.id);
  const region = area === "region" ? await selectRegion(tab.id) : undefined;

  try {
    const [metadata, consoleErrors, networkRequests] = await Promise.all([
      collectPageMetadata(tab.id),
      getConsoleEntries(tab.id),
      getNetworkEntries(tab.id)
    ]);

    await patchSession(sessionId, {
      status: "recording",
      tabId: tab.id,
      windowId: tab.windowId,
      metadata,
      consoleErrors,
      networkRequests,
      notice:
        area === "region"
          ? "Recording selected area for the current report."
          : "Recording video for the current report."
    });

    await ensureOffscreenDocument();
    const streamId = await getTabMediaStreamId(tab.id);
    await chrome.runtime.sendMessage({
      type: "OFFSCREEN_START_RECORDING",
      streamId,
      sessionId,
      region
    } satisfies RuntimeMessage);
    if (region && typeof tab.id === "number") {
      await showRecordingControls(tab.id, sessionId, "recording");
    }

    return (await getSession(sessionId)) ?? session;
  } catch (error) {
    return patchSession(sessionId, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function refreshSessionEvidence(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (typeof session?.tabId !== "number") return;
  const [consoleErrors, networkRequests] = await Promise.all([
    getConsoleEntries(session.tabId),
    getNetworkEntries(session.tabId)
  ]);
  await patchSession(sessionId, { consoleErrors, networkRequests });
}

async function createScreenshotSession(
  openComposer: boolean,
  area: CaptureArea
): Promise<CaptureSession> {
  const tab = await getActiveTab();
  await ensureCaptureScripts(tab.id);
  const region = area === "region" ? await selectRegion(tab.id) : undefined;
  const session = await createBaseSession("screenshot", tab);
  await saveSession(session);

  try {
    const [metadata, consoleErrors, networkRequests, screenshotDataUrl] = await Promise.all([
      collectPageMetadata(tab.id),
      getConsoleEntries(tab.id),
      getNetworkEntries(tab.id),
      captureVisibleTab(tab.windowId)
    ]);
    const dataUrl = region
      ? await cropImageDataUrl(screenshotDataUrl, region)
      : screenshotDataUrl;

    const updated = await patchSession(session.id, {
      status: "ready",
      metadata,
      consoleErrors,
      networkRequests,
      screenshots: [
        {
          id: crypto.randomUUID(),
          dataUrl,
          createdAt: new Date().toISOString(),
          url: metadata.url,
          title: metadata.title,
          captureArea: area,
          region
        }
      ],
      screenshotDataUrl: dataUrl
    });

    if (openComposer) await openComposerWindow(session.id);
    return updated ?? session;
  } catch (error) {
    const failed = await patchSession(session.id, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    });
    if (openComposer) await openComposerWindow(session.id);
    return failed ?? session;
  }
}

async function createVideoSession(
  openComposer: boolean,
  area: CaptureArea
): Promise<CaptureSession> {
  const tab = await getActiveTab();
  await ensureCaptureScripts(tab.id);
  const region = area === "region" ? await selectRegion(tab.id) : undefined;
  const session = await createBaseSession("video", tab);
  await saveSession(session);

  try {
    const [metadata, consoleErrors, networkRequests] = await Promise.all([
      collectPageMetadata(tab.id),
      getConsoleEntries(tab.id),
      getNetworkEntries(tab.id)
    ]);

    await patchSession(session.id, {
      status: "recording",
      metadata,
      consoleErrors,
      networkRequests
    });

    await ensureOffscreenDocument();
    const streamId = await getTabMediaStreamId(tab.id);
    await chrome.runtime.sendMessage({
      type: "OFFSCREEN_START_RECORDING",
      streamId,
      sessionId: session.id,
      region
    } satisfies RuntimeMessage);
    if (region && typeof tab.id === "number") {
      await showRecordingControls(tab.id, session.id, "recording");
    }

    if (openComposer) await openComposerWindow(session.id);
    return (await getSession(session.id)) ?? session;
  } catch (error) {
    const failed = await patchSession(session.id, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    });
    if (openComposer) await openComposerWindow(session.id);
    return failed ?? session;
  }
}

async function createBaseSession(
  mode: CaptureMode,
  tab: chrome.tabs.Tab
): Promise<CaptureSession> {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    mode,
    status: "capturing",
    tabId: tab.id,
    windowId: tab.windowId,
    createdAt: now,
    updatedAt: now,
    consoleErrors: [],
    networkRequests: []
  };
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.windowId) {
    throw new Error("No active tab found.");
  }
  if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://")) {
    throw new Error("Chrome internal pages cannot be captured.");
  }
  return tab;
}

async function ensureCaptureScripts(tabId?: number): Promise<void> {
  if (typeof tabId !== "number") return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"]
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content-main.js"],
      world: "MAIN"
    });
  } catch {
    // Manifest content scripts still cover normal page loads; dynamic injection is best-effort
    // for tabs that were already open before the extension started capturing.
  }
}

function isInspectableTabRequest(tabId: number): boolean {
  return Number.isInteger(tabId) && tabId >= 0;
}

function shouldCaptureCompletedRequest(details: {
  tabId: number;
  type?: string;
  statusCode: number;
}): boolean {
  return (
    isInspectableTabRequest(details.tabId) &&
    (details.statusCode >= 400 || isApiRequestType(details.type))
  );
}

function isApiRequestType(type?: string): boolean {
  return type === "fetch" || type === "xmlhttprequest";
}

function getOrCreatePendingRequest(details: {
  requestId: string;
  tabId: number;
  type?: string;
  method: string;
  url: string;
  timeStamp: number;
}): PendingNetworkRequest {
  const existing = pendingNetworkRequests.get(details.requestId);
  if (existing) return existing;

  const created = {
    requestId: details.requestId,
    tabId: details.tabId,
    type: details.type,
    method: details.method,
    url: sanitizeUrl(details.url),
    timestamp: new Date(details.timeStamp).toISOString(),
    startedAtMs: details.timeStamp
  };
  pendingNetworkRequests.set(details.requestId, created);
  return created;
}

function sanitizeNetworkEntry(entry: NetworkEntry): NetworkEntry {
  return {
    ...entry,
    method: entry.method.toUpperCase(),
    url: sanitizeUrl(entry.url),
    requestHeaders: sanitizeHeaders(entry.requestHeaders),
    responseHeaders: sanitizeHeaders(entry.responseHeaders),
    requestBodyPreview: entry.requestBodyPreview
      ? sanitizePreview(entry.requestBodyPreview, entry.requestHeaders?.["content-type"])
      : undefined,
    responseBodyPreview: entry.responseBodyPreview
      ? sanitizePreview(entry.responseBodyPreview, entry.responseContentType)
      : undefined,
    responseBodyUnavailableReason: entry.responseBodyUnavailableReason
      ? sanitizePreview(entry.responseBodyUnavailableReason)
      : undefined
  };
}

function webRequestResponseBodyUnavailableReason(): string {
  return "Chrome webRequest metadata does not expose response bodies; reload the page after the extension is active so fetch/XHR capture can read text responses.";
}

function sanitizeHeaderList(
  headers?: chrome.webRequest.HttpHeader[]
): Record<string, string> | undefined {
  if (!headers?.length) return undefined;
  const record: Record<string, string> = {};
  for (const header of headers) {
    const name = header.name.toLowerCase();
    const value = header.value ?? (header.binaryValue ? "[binary header]" : "");
    record[name] = isSensitiveName(name) ? SENSITIVE_VALUE : sanitizePreview(value);
  }
  return record;
}

function sanitizeHeaders(
  headers?: Record<string, string>
): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      isSensitiveName(name) ? SENSITIVE_VALUE : sanitizePreview(String(value))
    ])
  );
}

function sanitizeUrl(input: string): string {
  try {
    const url = new URL(input);
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveName(key)) url.searchParams.set(key, SENSITIVE_VALUE);
    }
    return url.href;
  } catch {
    return sanitizePreview(String(input));
  }
}

function sanitizePreview(value: string, contentType = ""): string {
  let text = String(value);
  if (isJsonLike(contentType) || looksJson(text)) {
    try {
      return JSON.stringify(redactJson(JSON.parse(text)), null, 2);
    } catch {
      // Fall through to pattern redaction.
    }
  }

  if (contentType.includes("x-www-form-urlencoded") || looksFormEncoded(text)) {
    try {
      const params = new URLSearchParams(text);
      for (const key of [...params.keys()]) {
        if (isSensitiveName(key)) params.set(key, SENSITIVE_VALUE);
      }
      text = params.toString();
    } catch {
      // Fall through to pattern redaction.
    }
  }

  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${SENSITIVE_VALUE}`)
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|client[_-]?secret)=([^&\s]+)/gi,
      `$1=${SENSITIVE_VALUE}`
    );
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      isSensitiveName(key) ? SENSITIVE_VALUE : redactJson(nested)
    ])
  );
}

function isSensitiveName(name = ""): boolean {
  return /authorization|cookie|token|password|passwd|secret|api[-_]?key|session|credential|csrf|xsrf/i.test(
    name
  );
}

function isJsonLike(contentType = ""): boolean {
  return /json/i.test(contentType);
}

function looksJson(value: string): boolean {
  const text = value.trim();
  return (
    (text.startsWith("{") && text.endsWith("}")) ||
    (text.startsWith("[") && text.endsWith("]"))
  );
}

function looksFormEncoded(value: string): boolean {
  return /^[^=\s&]+=[\s\S]*(&[^=\s&]+=[\s\S]*)*$/.test(value.trim());
}

async function captureVisibleTab(windowId?: number): Promise<string> {
  if (typeof windowId !== "number") {
    throw new Error("Cannot capture without an active window.");
  }
  return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}

async function selectRegion(tabId?: number): Promise<CaptureRegion> {
  if (typeof tabId !== "number") throw new Error("Cannot select a region without an active tab.");
  const response = await requestRegionSelection(tabId);
  if (!isCaptureRegion(response)) {
    throw new Error(response?.error || "Region selection canceled.");
  }
  return response;
}

async function setRecordingControlsState(
  sessionId: string,
  state: "recording" | "saving"
): Promise<void> {
  const session = await getSession(sessionId);
  if (typeof session?.tabId !== "number") return;
  await showRecordingControls(session.tabId, sessionId, state);
}

async function hideRecordingControlsForSession(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (typeof session?.tabId !== "number") return;
  await hideRecordingControls(session.tabId, sessionId);
}

async function restoreRecordingControlsForTab(tabId: number): Promise<void> {
  const recordingSession = (await getSortedSessions()).find(
    (item) => item.status === "recording" && item.tabId === tabId
  );
  if (!recordingSession) return;
  await showRecordingControls(tabId, recordingSession.id, "recording");
}

function scheduleRecordingControlsRestore(tabId: number): void {
  const existing = recordingControlRestoreTimers.get(tabId);
  if (typeof existing === "number") {
    self.clearTimeout(existing);
  }
  const timeout = self.setTimeout(() => {
    recordingControlRestoreTimers.delete(tabId);
    void restoreRecordingControlsForTab(tabId);
  }, 700);
  recordingControlRestoreTimers.set(tabId, timeout);
}

async function showRecordingControls(
  tabId: number,
  sessionId: string,
  state: "recording" | "saving"
): Promise<void> {
  try {
    await sendContentMessageWithInjection(tabId, {
      type: "SHOW_RECORDING_CONTROLS",
      sessionId,
      state
    });
  } catch {
    // Some pages cannot receive injected extension UI; keep the popup stop control as fallback.
  }
}

async function hideRecordingControls(tabId: number, sessionId: string): Promise<void> {
  await sendContentMessage(tabId, {
    type: "HIDE_RECORDING_CONTROLS",
    sessionId
  });
}

async function sendContentMessage(tabId: number, message: RuntimeMessage): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // The tab may have navigated or closed while the recording was running.
  }
}

async function sendContentMessageWithInjection(
  tabId: number,
  message: RuntimeMessage
): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!isMissingReceiverError(error)) throw error;
    await injectContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, message);
  }
}

async function requestRegionSelection(
  tabId: number
): Promise<CaptureRegion | { error?: string } | undefined> {
  try {
    return (await chrome.tabs.sendMessage(tabId, {
      type: "START_REGION_SELECTION"
    } satisfies RuntimeMessage)) as CaptureRegion | { error?: string } | undefined;
  } catch (error) {
    if (!isMissingReceiverError(error)) throw error;
    await injectContentScript(tabId);
    return (await chrome.tabs.sendMessage(tabId, {
      type: "START_REGION_SELECTION"
    } satisfies RuntimeMessage)) as CaptureRegion | { error?: string } | undefined;
  }
}

async function injectContentScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not start region selection on this page. ${message}`);
  }
}

function isMissingReceiverError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Receiving end does not exist") ||
    message.includes("Could not establish connection")
  );
}

function isCaptureRegion(value: CaptureRegion | { error?: string } | undefined): value is CaptureRegion {
  return (
    !!value &&
    typeof (value as CaptureRegion).x === "number" &&
    typeof (value as CaptureRegion).y === "number" &&
    typeof (value as CaptureRegion).width === "number" &&
    typeof (value as CaptureRegion).height === "number"
  );
}

async function cropImageDataUrl(dataUrl: string, region: CaptureRegion): Promise<string> {
  const image = await createImageBitmap(await dataUrlToBlob(dataUrl));
  const scaleX = image.width / region.viewportWidth;
  const scaleY = image.height / region.viewportHeight;
  const sourceX = Math.round(region.x * scaleX);
  const sourceY = Math.round(region.y * scaleY);
  const sourceWidth = Math.max(1, Math.round(region.width * scaleX));
  const sourceHeight = Math.max(1, Math.round(region.height * scaleY));
  const canvas = new OffscreenCanvas(sourceWidth, sourceHeight);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not crop screenshot.");
  context.drawImage(
    image,
    sourceX,
    sourceY,
    Math.min(sourceWidth, image.width - sourceX),
    Math.min(sourceHeight, image.height - sourceY),
    0,
    0,
    sourceWidth,
    sourceHeight
  );
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return blobToDataUrl(blob);
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return fetch(dataUrl).then((response) => response.blob());
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

async function collectPageMetadata(tabId?: number): Promise<PageMetadata> {
  if (typeof tabId !== "number") throw new Error("Cannot inspect an unknown tab.");

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      url: window.location.href,
      title: document.title,
      userAgent: navigator.userAgent,
      language: navigator.language,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      },
      screen: {
        width: window.screen.width,
        height: window.screen.height,
        availWidth: window.screen.availWidth,
        availHeight: window.screen.availHeight,
        colorDepth: window.screen.colorDepth
      }
    })
  });

  if (!result?.result) throw new Error("Could not collect page metadata.");
  return result.result as PageMetadata;
}

async function getTabMediaStreamId(tabId?: number): Promise<string> {
  if (typeof tabId !== "number") throw new Error("Cannot record an unknown tab.");
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      const error = chrome.runtime.lastError;
      if (error || !streamId) {
        reject(new Error(error?.message ?? "Chrome did not provide a media stream."));
        return;
      }
      resolve(streamId);
    });
  });
}

async function ensureOffscreenDocument(): Promise<void> {
  const offscreen = chrome.offscreen as typeof chrome.offscreen & {
    hasDocument?: () => Promise<boolean>;
  };
  const hasDocument = offscreen.hasDocument ? await offscreen.hasDocument() : false;
  if (hasDocument) return;

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA" as chrome.offscreen.Reason],
    justification: "Record the active tab for a video bug report."
  });
}

async function openComposerWindow(sessionId: string): Promise<void> {
  await chrome.windows.create({
    url: chrome.runtime.getURL(`popup.html?sessionId=${sessionId}`),
    type: "popup",
    width: 460,
    height: 760,
    focused: true
  });
}
