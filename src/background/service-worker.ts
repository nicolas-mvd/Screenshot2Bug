import {
  appendConsoleEntry,
  getConsoleEntries,
  getSession,
  getSortedSessions,
  normalizeSession,
  patchSession,
  saveSession,
  setActiveSession
} from "../shared/storage";
import type {
  BackgroundResponse,
  CaptureMode,
  CaptureSession,
  PageMetadata,
  RuntimeMessage
} from "../shared/types";

chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-screenshot") {
    void createScreenshotSession(true);
  }
  if (command === "attach-screenshot") {
    void attachScreenshotFromShortcut();
  }
  if (command === "capture-video") {
    void createVideoSession(true);
  }
  if (command === "attach-video") {
    void attachVideoFromShortcut();
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
      return createScreenshotSession(false);
    case "START_VIDEO_CAPTURE":
      return createVideoSession(false);
    case "ADD_SCREENSHOT_TO_SESSION":
      return addScreenshotToSession(message.sessionId);
    case "ADD_VIDEO_TO_SESSION":
      return addVideoToSession(message.sessionId);
    case "GET_SESSIONS":
      return getSortedSessions();
    case "SET_ACTIVE_SESSION":
      return setActiveSession(message.sessionId);
    case "STOP_VIDEO_CAPTURE":
      await refreshSessionConsole(message.sessionId);
      await chrome.runtime.sendMessage({
        type: "OFFSCREEN_STOP_RECORDING",
        sessionId: message.sessionId
      } satisfies RuntimeMessage);
      return patchSession(message.sessionId, { status: "capturing" });
    case "GET_SESSION":
      return getSession(message.sessionId);
    case "UPDATE_SESSION":
      return patchSession(message.sessionId, message.patch);
    case "LOG_CONSOLE_ENTRY":
      if (typeof sender.tab?.id === "number") {
        await appendConsoleEntry(sender.tab.id, message.entry);
      }
      return undefined;
    case "OFFSCREEN_RECORDING_COMPLETE":
      return completeRecordingSession(message.sessionId, message.dataUrl, message.mimeType);
    case "OFFSCREEN_RECORDING_ERROR":
      return patchSession(message.sessionId, {
        status: "failed",
        error: message.error
      });
    default:
      return undefined;
  }
}

async function attachScreenshotFromShortcut(): Promise<void> {
  const session = await getSession();
  if (!session) {
    const created = await createScreenshotSession(false);
    await patchSession(created.id, {
      notice: "No active report existed, so a new screenshot report was created."
    });
    await openComposerWindow(created.id);
    return;
  }
  await addScreenshotToSession(session.id);
  await openComposerWindow(session.id);
}

async function attachVideoFromShortcut(): Promise<void> {
  const session = await getSession();
  if (!session) {
    const created = await createVideoSession(false);
    await patchSession(created.id, {
      notice: "No active report existed, so a new video report was created."
    });
    await openComposerWindow(created.id);
    return;
  }
  await addVideoToSession(session.id);
  await openComposerWindow(session.id);
}

async function addScreenshotToSession(sessionId: string): Promise<CaptureSession | undefined> {
  const session = normalizeSession(await getSession(sessionId));
  if (!session) throw new Error("No capture session found.");
  const tab = await getActiveTab();
  const [metadata, consoleErrors, screenshotDataUrl] = await Promise.all([
    collectPageMetadata(tab.id),
    getConsoleEntries(tab.id),
    captureVisibleTab(tab.windowId)
  ]);
  const screenshot = {
    id: crypto.randomUUID(),
    dataUrl: screenshotDataUrl,
    createdAt: new Date().toISOString(),
    url: metadata.url,
    title: metadata.title
  };

  return patchSession(sessionId, {
    tabId: tab.id,
    windowId: tab.windowId,
    metadata,
    consoleErrors,
    screenshots: [...(session.screenshots ?? []), screenshot],
    screenshotDataUrl
  });
}

async function completeRecordingSession(
  sessionId: string,
  dataUrl: string,
  mimeType: string
): Promise<CaptureSession | undefined> {
  await refreshSessionConsole(sessionId);
  const session = normalizeSession(await getSession(sessionId));
  if (!session) throw new Error("No capture session found.");
  const recording = {
    id: crypto.randomUUID(),
    dataUrl,
    mimeType,
    createdAt: new Date().toISOString(),
    url: session.metadata?.url,
    title: session.metadata?.title
  };
  return patchSession(sessionId, {
    status: "ready",
    recordings: [...(session.recordings ?? []), recording],
    recordingDataUrl: dataUrl,
    recordingMimeType: mimeType
  });
}

async function addVideoToSession(sessionId: string): Promise<CaptureSession | undefined> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("No capture session found.");
  const tab = await getActiveTab();

  try {
    const [metadata, consoleErrors] = await Promise.all([
      collectPageMetadata(tab.id),
      getConsoleEntries(tab.id)
    ]);

    await patchSession(sessionId, {
      status: "recording",
      tabId: tab.id,
      windowId: tab.windowId,
      metadata,
      consoleErrors,
      notice: "Recording video for the current report."
    });

    await ensureOffscreenDocument();
    const streamId = await getTabMediaStreamId(tab.id);
    await chrome.runtime.sendMessage({
      type: "OFFSCREEN_START_RECORDING",
      streamId,
      sessionId
    } satisfies RuntimeMessage);

    return (await getSession(sessionId)) ?? session;
  } catch (error) {
    return patchSession(sessionId, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function refreshSessionConsole(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (typeof session?.tabId !== "number") return;
  await patchSession(sessionId, {
    consoleErrors: await getConsoleEntries(session.tabId)
  });
}

async function createScreenshotSession(openComposer: boolean): Promise<CaptureSession> {
  const tab = await getActiveTab();
  const session = await createBaseSession("screenshot", tab);
  await saveSession(session);

  try {
    const [metadata, consoleErrors, screenshotDataUrl] = await Promise.all([
      collectPageMetadata(tab.id),
      getConsoleEntries(tab.id),
      captureVisibleTab(tab.windowId)
    ]);

    const updated = await patchSession(session.id, {
      status: "ready",
      metadata,
      consoleErrors,
      screenshots: [
        {
          id: crypto.randomUUID(),
          dataUrl: screenshotDataUrl,
          createdAt: new Date().toISOString(),
          url: metadata.url,
          title: metadata.title
        }
      ],
      screenshotDataUrl
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

async function createVideoSession(openComposer: boolean): Promise<CaptureSession> {
  const tab = await getActiveTab();
  const session = await createBaseSession("video", tab);
  await saveSession(session);

  try {
    const [metadata, consoleErrors] = await Promise.all([
      collectPageMetadata(tab.id),
      getConsoleEntries(tab.id)
    ]);

    await patchSession(session.id, {
      status: "recording",
      metadata,
      consoleErrors
    });

    await ensureOffscreenDocument();
    const streamId = await getTabMediaStreamId(tab.id);
    await chrome.runtime.sendMessage({
      type: "OFFSCREEN_START_RECORDING",
      streamId,
      sessionId: session.id
    } satisfies RuntimeMessage);

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
    consoleErrors: []
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

async function captureVisibleTab(windowId?: number): Promise<string> {
  if (typeof windowId !== "number") {
    throw new Error("Cannot capture without an active window.");
  }
  return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
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
