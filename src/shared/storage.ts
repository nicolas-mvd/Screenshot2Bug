import { STORAGE_KEYS } from "./types";
import type { CaptureSession, ConsoleEntry, Settings } from "./types";

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return (result[STORAGE_KEYS.settings] as Settings | undefined) ?? {};
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
}

export async function getSessions(): Promise<Record<string, CaptureSession>> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.sessions);
  return (result[STORAGE_KEYS.sessions] as Record<string, CaptureSession> | undefined) ?? {};
}

export async function getSortedSessions(): Promise<CaptureSession[]> {
  const sessions = await getSessions();
  return Object.values(sessions)
    .map(normalizeSession)
    .filter((session): session is CaptureSession => !!session)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function getSession(
  sessionId?: string
): Promise<CaptureSession | undefined> {
  const latest = await chrome.storage.local.get(STORAGE_KEYS.latestSessionId);
  const id = sessionId ?? (latest[STORAGE_KEYS.latestSessionId] as string | undefined);
  if (!id) return undefined;
  const sessions = await getSessions();
  return normalizeSession(sessions[id]);
}

export async function saveSession(session: CaptureSession): Promise<void> {
  const sessions = await getSessions();
  sessions[session.id] = normalizeSession(session) ?? session;
  await chrome.storage.local.set({
    [STORAGE_KEYS.sessions]: sessions,
    [STORAGE_KEYS.latestSessionId]: session.id
  });
}

export async function patchSession(
  sessionId: string,
  patch: Partial<CaptureSession>
): Promise<CaptureSession | undefined> {
  const sessions = await getSessions();
  const existing = normalizeSession(sessions[sessionId]);
  if (!existing) return undefined;
  const updated =
    normalizeSession({
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString()
    }) ?? existing;
  sessions[sessionId] = updated;
  await chrome.storage.local.set({ [STORAGE_KEYS.sessions]: sessions });
  return updated;
}

export async function setActiveSession(sessionId: string): Promise<CaptureSession> {
  const sessions = await getSessions();
  const session = sessions[sessionId];
  if (!session) throw new Error("Report not found.");
  await chrome.storage.local.set({ [STORAGE_KEYS.latestSessionId]: sessionId });
  return normalizeSession(session) ?? session;
}

export async function clearActiveSession(sessionId?: string): Promise<void> {
  if (!sessionId) {
    await chrome.storage.local.remove(STORAGE_KEYS.latestSessionId);
    return;
  }

  const latest = await chrome.storage.local.get(STORAGE_KEYS.latestSessionId);
  const focusedId = latest[STORAGE_KEYS.latestSessionId] as string | undefined;
  if (focusedId === sessionId) {
    await chrome.storage.local.remove(STORAGE_KEYS.latestSessionId);
  }
}

export async function appendConsoleEntry(
  tabId: number,
  entry: ConsoleEntry
): Promise<void> {
  const key = `${STORAGE_KEYS.consolePrefix}${tabId}`;
  const result = await chrome.storage.local.get(key);
  const current = (result[key] as ConsoleEntry[] | undefined) ?? [];
  await chrome.storage.local.set({ [key]: [...current.slice(-49), entry] });
}

export async function getConsoleEntries(tabId?: number): Promise<ConsoleEntry[]> {
  if (typeof tabId !== "number") return [];
  const key = `${STORAGE_KEYS.consolePrefix}${tabId}`;
  const result = await chrome.storage.local.get(key);
  return (result[key] as ConsoleEntry[] | undefined) ?? [];
}

export function normalizeSession(session?: CaptureSession): CaptureSession | undefined {
  if (!session) return session;
  const screenshots = [...(session.screenshots ?? [])];
  const recordings = [...(session.recordings ?? [])];
  if (
    session.screenshotDataUrl &&
    !screenshots.some((item) => item.dataUrl === session.screenshotDataUrl)
  ) {
    screenshots.push({
      id: "legacy-screenshot",
      dataUrl: session.screenshotDataUrl,
      createdAt: session.updatedAt || session.createdAt,
      url: session.metadata?.url,
      title: session.metadata?.title
    });
  }
  if (
    session.recordingDataUrl &&
    !recordings.some((item) => item.dataUrl === session.recordingDataUrl)
  ) {
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
    screenshots,
    recordings,
    screenshotDataUrl: screenshots.at(-1)?.dataUrl,
    recordingDataUrl: recordings.at(-1)?.dataUrl,
    recordingMimeType: recordings.at(-1)?.mimeType
  };
}
