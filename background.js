// src/shared/types.ts
var STORAGE_KEYS = {
  latestSessionId: "latestSessionId",
  settings: "settings",
  sessions: "sessions",
  consolePrefix: "console:",
  networkPrefix: "network:"
};

// src/shared/storage.ts
async function getSessions() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.sessions);
  return result[STORAGE_KEYS.sessions] ?? {};
}
async function getSortedSessions() {
  const sessions = await getSessions();
  return Object.values(sessions).map(normalizeSession).filter((session) => !!session).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}
async function getSession(sessionId) {
  const latest = await chrome.storage.local.get(STORAGE_KEYS.latestSessionId);
  const id = sessionId ?? latest[STORAGE_KEYS.latestSessionId];
  if (!id) return void 0;
  const sessions = await getSessions();
  return normalizeSession(sessions[id]);
}
async function saveSession(session) {
  const sessions = await getSessions();
  sessions[session.id] = normalizeSession(session) ?? session;
  await chrome.storage.local.set({
    [STORAGE_KEYS.sessions]: sessions,
    [STORAGE_KEYS.latestSessionId]: session.id
  });
}
async function patchSession(sessionId, patch) {
  const sessions = await getSessions();
  const existing = normalizeSession(sessions[sessionId]);
  if (!existing) return void 0;
  const updated = normalizeSession({
    ...existing,
    ...patch,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  }) ?? existing;
  sessions[sessionId] = updated;
  await chrome.storage.local.set({ [STORAGE_KEYS.sessions]: sessions });
  return updated;
}
async function setActiveSession(sessionId) {
  const sessions = await getSessions();
  const session = sessions[sessionId];
  if (!session) throw new Error("Report not found.");
  await chrome.storage.local.set({ [STORAGE_KEYS.latestSessionId]: sessionId });
  return normalizeSession(session) ?? session;
}
async function clearActiveSession(sessionId) {
  if (!sessionId) {
    await chrome.storage.local.remove(STORAGE_KEYS.latestSessionId);
    return;
  }
  const latest = await chrome.storage.local.get(STORAGE_KEYS.latestSessionId);
  const focusedId = latest[STORAGE_KEYS.latestSessionId];
  if (focusedId === sessionId) {
    await chrome.storage.local.remove(STORAGE_KEYS.latestSessionId);
  }
}
async function appendConsoleEntry(tabId, entry) {
  const key = `${STORAGE_KEYS.consolePrefix}${tabId}`;
  const result = await chrome.storage.local.get(key);
  const current = result[key] ?? [];
  await chrome.storage.local.set({ [key]: [...current.slice(-49), entry] });
}
async function getConsoleEntries(tabId) {
  if (typeof tabId !== "number") return [];
  const key = `${STORAGE_KEYS.consolePrefix}${tabId}`;
  const result = await chrome.storage.local.get(key);
  return result[key] ?? [];
}
async function appendNetworkEntry(tabId, entry) {
  const key = `${STORAGE_KEYS.networkPrefix}${tabId}`;
  const result = await chrome.storage.local.get(key);
  const current = result[key] ?? [];
  const next = mergeNetworkEntries(current, entry).slice(-99);
  await chrome.storage.local.set({ [key]: next });
}
async function getNetworkEntries(tabId) {
  if (typeof tabId !== "number") return [];
  const key = `${STORAGE_KEYS.networkPrefix}${tabId}`;
  const result = await chrome.storage.local.get(key);
  return result[key] ?? [];
}
function normalizeSession(session) {
  if (!session) return session;
  const screenshots = [...session.screenshots ?? []];
  const recordings = [...session.recordings ?? []];
  if (session.screenshotDataUrl && !screenshots.some((item) => item.dataUrl === session.screenshotDataUrl)) {
    screenshots.push({
      id: "legacy-screenshot",
      dataUrl: session.screenshotDataUrl,
      createdAt: session.updatedAt || session.createdAt,
      url: session.metadata?.url,
      title: session.metadata?.title
    });
  }
  if (session.recordingDataUrl && !recordings.some((item) => item.dataUrl === session.recordingDataUrl)) {
    recordings.push({
      id: "legacy-recording",
      dataUrl: session.recordingDataUrl,
      mimeType: session.recordingMimeType || "video/webm",
      createdAt: session.updatedAt || session.createdAt,
      url: session.metadata?.url,
      title: session.metadata?.title
    });
  }
  return {
    ...session,
    consoleErrors: session.consoleErrors ?? [],
    networkRequests: session.networkRequests ?? [],
    screenshots,
    recordings,
    screenshotDataUrl: screenshots.at(-1)?.dataUrl,
    recordingDataUrl: recordings.at(-1)?.dataUrl,
    recordingMimeType: recordings.at(-1)?.mimeType
  };
}
function mergeNetworkEntries(current, entry) {
  const matchIndex = current.findIndex((candidate) => isSameNetworkEntry(candidate, entry));
  if (matchIndex === -1) return [...current, entry];
  const existing = current[matchIndex];
  const preferredBase = networkEntryScore(entry) > networkEntryScore(existing) ? entry : existing;
  const supplemental = preferredBase === existing ? entry : existing;
  const merged = {
    ...supplemental,
    ...preferredBase,
    requestHeaders: {
      ...supplemental.requestHeaders ?? {},
      ...preferredBase.requestHeaders ?? {}
    },
    responseHeaders: {
      ...supplemental.responseHeaders ?? {},
      ...preferredBase.responseHeaders ?? {}
    },
    requestBodyPreview: preferredBase.requestBodyPreview ?? supplemental.requestBodyPreview,
    requestBodyTruncated: preferredBase.requestBodyTruncated ?? supplemental.requestBodyTruncated,
    responseBodyPreview: preferredBase.responseBodyPreview ?? supplemental.responseBodyPreview,
    responseBodyTruncated: preferredBase.responseBodyTruncated ?? supplemental.responseBodyTruncated,
    responseBodyUnavailableReason: preferredBase.responseBodyUnavailableReason ?? supplemental.responseBodyUnavailableReason,
    responseContentType: preferredBase.responseContentType ?? supplemental.responseContentType,
    error: preferredBase.error ?? supplemental.error
  };
  const next = [...current];
  next[matchIndex] = merged;
  return next;
}
function isSameNetworkEntry(first, second) {
  if (first.id === second.id) return true;
  if (first.requestId && first.requestId === second.requestId) return true;
  if (first.method !== second.method || first.url !== second.url) return false;
  const firstTime = new Date(first.timestamp).getTime();
  const secondTime = new Date(second.timestamp).getTime();
  if (Number.isNaN(firstTime) || Number.isNaN(secondTime)) return false;
  return Math.abs(firstTime - secondTime) < 5e3;
}
function networkEntryScore(entry) {
  return (entry.responseBodyPreview ? 8 : 0) + (entry.requestBodyPreview ? 4 : 0) + (entry.source === "page" ? 2 : 0) + (entry.responseHeaders ? 1 : 0);
}

// src/background/service-worker.ts
var SENSITIVE_VALUE = "[redacted]";
var recordingControlRestoreTimers = /* @__PURE__ */ new Map();
var pendingNetworkRequests = /* @__PURE__ */ new Map();
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
    if (!isInspectableTabRequest(details.tabId)) return void 0;
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
    return void 0;
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!isInspectableTabRequest(details.tabId)) return void 0;
    const pending = getOrCreatePendingRequest(details);
    pending.responseHeaders = sanitizeHeaderList(details.responseHeaders);
    return void 0;
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
    const entry = sanitizeNetworkEntry({
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
    const entry = sanitizeNetworkEntry({
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
  (message, sender, sendResponse) => {
    void handleMessage(message, sender).then((data) => sendResponse({ ok: true, data })).catch(
      (error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    );
    return true;
  }
);
async function handleMessage(message, sender) {
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
      });
      return patchSession(message.sessionId, { status: "capturing" });
    case "GET_SESSION":
      return getSession(message.sessionId);
    case "UPDATE_SESSION":
      return patchSession(message.sessionId, message.patch);
    case "CONTENT_SCRIPT_READY":
      if (typeof sender.tab?.id === "number") {
        await restoreRecordingControlsForTab(sender.tab.id);
      }
      return void 0;
    case "LOG_CONSOLE_ENTRY":
      if (typeof sender.tab?.id === "number") {
        await appendConsoleEntry(sender.tab.id, message.entry);
      }
      return void 0;
    case "LOG_NETWORK_ENTRY":
      if (typeof sender.tab?.id === "number") {
        await appendNetworkEntry(sender.tab.id, sanitizeNetworkEntry(message.entry));
      }
      return void 0;
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
      return void 0;
  }
}
async function captureScreenshot(openComposer, area) {
  const focused = await getSession();
  if (focused) {
    const updated = await addScreenshotToSession(focused.id, area);
    if (openComposer) await openComposerWindow(focused.id);
    return updated;
  }
  return createScreenshotSession(openComposer, area);
}
async function captureVideo(openComposer, area) {
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
async function addScreenshotToSession(sessionId, area) {
  const session = normalizeSession(await getSession(sessionId));
  if (!session) throw new Error("No capture session found.");
  const tab = await getActiveTab();
  await ensureCaptureScripts(tab.id);
  const region = area === "region" ? await selectRegion(tab.id) : void 0;
  const [metadata, consoleErrors, networkRequests, screenshotDataUrl] = await Promise.all([
    collectPageMetadata(tab.id),
    getConsoleEntries(tab.id),
    getNetworkEntries(tab.id),
    captureVisibleTab(tab.windowId)
  ]);
  const dataUrl = region ? await cropImageDataUrl(screenshotDataUrl, region) : screenshotDataUrl;
  const screenshot = {
    id: crypto.randomUUID(),
    dataUrl,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
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
    screenshots: [...session.screenshots ?? [], screenshot],
    screenshotDataUrl: dataUrl
  });
}
async function completeRecordingSession(sessionId, dataUrl, mimeType, region) {
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
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    url: session.metadata?.url,
    title: session.metadata?.title,
    captureArea: region ? "region" : "full",
    region
  };
  return patchSession(sessionId, {
    status: "ready",
    recordings: [...session.recordings ?? [], recording],
    recordingDataUrl: dataUrl,
    recordingMimeType: mimeType
  });
}
async function addVideoToSession(sessionId, area) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("No capture session found.");
  const tab = await getActiveTab();
  await ensureCaptureScripts(tab.id);
  const region = area === "region" ? await selectRegion(tab.id) : void 0;
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
      notice: area === "region" ? "Recording selected area for the current report." : "Recording video for the current report."
    });
    await ensureOffscreenDocument();
    const streamId = await getTabMediaStreamId(tab.id);
    await chrome.runtime.sendMessage({
      type: "OFFSCREEN_START_RECORDING",
      streamId,
      sessionId,
      region
    });
    if (region && typeof tab.id === "number") {
      await showRecordingControls(tab.id, sessionId, "recording");
    }
    return await getSession(sessionId) ?? session;
  } catch (error) {
    return patchSession(sessionId, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
async function refreshSessionEvidence(sessionId) {
  const session = await getSession(sessionId);
  if (typeof session?.tabId !== "number") return;
  const [consoleErrors, networkRequests] = await Promise.all([
    getConsoleEntries(session.tabId),
    getNetworkEntries(session.tabId)
  ]);
  await patchSession(sessionId, { consoleErrors, networkRequests });
}
async function createScreenshotSession(openComposer, area) {
  const tab = await getActiveTab();
  await ensureCaptureScripts(tab.id);
  const region = area === "region" ? await selectRegion(tab.id) : void 0;
  const session = await createBaseSession("screenshot", tab);
  await saveSession(session);
  try {
    const [metadata, consoleErrors, networkRequests, screenshotDataUrl] = await Promise.all([
      collectPageMetadata(tab.id),
      getConsoleEntries(tab.id),
      getNetworkEntries(tab.id),
      captureVisibleTab(tab.windowId)
    ]);
    const dataUrl = region ? await cropImageDataUrl(screenshotDataUrl, region) : screenshotDataUrl;
    const updated = await patchSession(session.id, {
      status: "ready",
      metadata,
      consoleErrors,
      networkRequests,
      screenshots: [
        {
          id: crypto.randomUUID(),
          dataUrl,
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
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
async function createVideoSession(openComposer, area) {
  const tab = await getActiveTab();
  await ensureCaptureScripts(tab.id);
  const region = area === "region" ? await selectRegion(tab.id) : void 0;
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
    });
    if (region && typeof tab.id === "number") {
      await showRecordingControls(tab.id, session.id, "recording");
    }
    if (openComposer) await openComposerWindow(session.id);
    return await getSession(session.id) ?? session;
  } catch (error) {
    const failed = await patchSession(session.id, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    });
    if (openComposer) await openComposerWindow(session.id);
    return failed ?? session;
  }
}
async function createBaseSession(mode, tab) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
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
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.windowId) {
    throw new Error("No active tab found.");
  }
  if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://")) {
    throw new Error("Chrome internal pages cannot be captured.");
  }
  return tab;
}
async function ensureCaptureScripts(tabId) {
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
  }
}
function isInspectableTabRequest(tabId) {
  return Number.isInteger(tabId) && tabId >= 0;
}
function shouldCaptureCompletedRequest(details) {
  return isInspectableTabRequest(details.tabId) && (details.statusCode >= 400 || isApiRequestType(details.type));
}
function isApiRequestType(type) {
  return type === "fetch" || type === "xmlhttprequest";
}
function getOrCreatePendingRequest(details) {
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
function sanitizeNetworkEntry(entry) {
  return {
    ...entry,
    method: entry.method.toUpperCase(),
    url: sanitizeUrl(entry.url),
    requestHeaders: sanitizeHeaders(entry.requestHeaders),
    responseHeaders: sanitizeHeaders(entry.responseHeaders),
    requestBodyPreview: entry.requestBodyPreview ? sanitizePreview(entry.requestBodyPreview, entry.requestHeaders?.["content-type"]) : void 0,
    responseBodyPreview: entry.responseBodyPreview ? sanitizePreview(entry.responseBodyPreview, entry.responseContentType) : void 0,
    responseBodyUnavailableReason: entry.responseBodyUnavailableReason ? sanitizePreview(entry.responseBodyUnavailableReason) : void 0
  };
}
function webRequestResponseBodyUnavailableReason() {
  return "Chrome webRequest metadata does not expose response bodies; reload the page after the extension is active so fetch/XHR capture can read text responses.";
}
function sanitizeHeaderList(headers) {
  if (!headers?.length) return void 0;
  const record = {};
  for (const header of headers) {
    const name = header.name.toLowerCase();
    const value = header.value ?? (header.binaryValue ? "[binary header]" : "");
    record[name] = isSensitiveName(name) ? SENSITIVE_VALUE : sanitizePreview(value);
  }
  return record;
}
function sanitizeHeaders(headers) {
  if (!headers) return void 0;
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      isSensitiveName(name) ? SENSITIVE_VALUE : sanitizePreview(String(value))
    ])
  );
}
function sanitizeUrl(input) {
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
function sanitizePreview(value, contentType = "") {
  let text = String(value);
  if (isJsonLike(contentType) || looksJson(text)) {
    try {
      return JSON.stringify(redactJson(JSON.parse(text)), null, 2);
    } catch {
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
    }
  }
  return text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${SENSITIVE_VALUE}`).replace(
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|client[_-]?secret)=([^&\s]+)/gi,
    `$1=${SENSITIVE_VALUE}`
  );
}
function redactJson(value) {
  if (Array.isArray(value)) return value.map(redactJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      isSensitiveName(key) ? SENSITIVE_VALUE : redactJson(nested)
    ])
  );
}
function isSensitiveName(name = "") {
  return /authorization|cookie|token|password|passwd|secret|api[-_]?key|session|credential|csrf|xsrf/i.test(
    name
  );
}
function isJsonLike(contentType = "") {
  return /json/i.test(contentType);
}
function looksJson(value) {
  const text = value.trim();
  return text.startsWith("{") && text.endsWith("}") || text.startsWith("[") && text.endsWith("]");
}
function looksFormEncoded(value) {
  return /^[^=\s&]+=[\s\S]*(&[^=\s&]+=[\s\S]*)*$/.test(value.trim());
}
async function captureVisibleTab(windowId) {
  if (typeof windowId !== "number") {
    throw new Error("Cannot capture without an active window.");
  }
  return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}
async function selectRegion(tabId) {
  if (typeof tabId !== "number") throw new Error("Cannot select a region without an active tab.");
  const response = await requestRegionSelection(tabId);
  if (!isCaptureRegion(response)) {
    throw new Error(response?.error || "Region selection canceled.");
  }
  return response;
}
async function setRecordingControlsState(sessionId, state) {
  const session = await getSession(sessionId);
  if (typeof session?.tabId !== "number") return;
  await showRecordingControls(session.tabId, sessionId, state);
}
async function hideRecordingControlsForSession(sessionId) {
  const session = await getSession(sessionId);
  if (typeof session?.tabId !== "number") return;
  await hideRecordingControls(session.tabId, sessionId);
}
async function restoreRecordingControlsForTab(tabId) {
  const recordingSession = (await getSortedSessions()).find(
    (item) => item.status === "recording" && item.tabId === tabId
  );
  if (!recordingSession) return;
  await showRecordingControls(tabId, recordingSession.id, "recording");
}
function scheduleRecordingControlsRestore(tabId) {
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
async function showRecordingControls(tabId, sessionId, state) {
  try {
    await sendContentMessageWithInjection(tabId, {
      type: "SHOW_RECORDING_CONTROLS",
      sessionId,
      state
    });
  } catch {
  }
}
async function hideRecordingControls(tabId, sessionId) {
  await sendContentMessage(tabId, {
    type: "HIDE_RECORDING_CONTROLS",
    sessionId
  });
}
async function sendContentMessage(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
  }
}
async function sendContentMessageWithInjection(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!isMissingReceiverError(error)) throw error;
    await injectContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, message);
  }
}
async function requestRegionSelection(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: "START_REGION_SELECTION"
    });
  } catch (error) {
    if (!isMissingReceiverError(error)) throw error;
    await injectContentScript(tabId);
    return await chrome.tabs.sendMessage(tabId, {
      type: "START_REGION_SELECTION"
    });
  }
}
async function injectContentScript(tabId) {
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
function isMissingReceiverError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Receiving end does not exist") || message.includes("Could not establish connection");
}
function isCaptureRegion(value) {
  return !!value && typeof value.x === "number" && typeof value.y === "number" && typeof value.width === "number" && typeof value.height === "number";
}
async function cropImageDataUrl(dataUrl, region) {
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
async function dataUrlToBlob(dataUrl) {
  return fetch(dataUrl).then((response) => response.blob());
}
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}
async function collectPageMetadata(tabId) {
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
  return result.result;
}
async function getTabMediaStreamId(tabId) {
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
async function ensureOffscreenDocument() {
  const offscreen = chrome.offscreen;
  const hasDocument = offscreen.hasDocument ? await offscreen.hasDocument() : false;
  if (hasDocument) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Record the active tab for a video bug report."
  });
}
async function openComposerWindow(sessionId) {
  await chrome.windows.create({
    url: chrome.runtime.getURL(`popup.html?sessionId=${sessionId}`),
    type: "popup",
    width: 460,
    height: 760,
    focused: true
  });
}
