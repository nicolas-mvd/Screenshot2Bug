export const STORAGE_KEYS = {
  latestSessionId: "latestSessionId",
  settings: "settings",
  sessions: "sessions",
  consolePrefix: "console:"
};

export const DEFAULT_MODEL = "gpt-5";

export async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return result[STORAGE_KEYS.settings] ?? {};
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
}

export async function getSessions() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.sessions);
  return result[STORAGE_KEYS.sessions] ?? {};
}

export async function getSortedSessions() {
  const sessions = await getSessions();
  return Object.values(sessions).map(normalizeSession).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function getSession(sessionId) {
  const latest = await chrome.storage.local.get(STORAGE_KEYS.latestSessionId);
  const id = sessionId ?? latest[STORAGE_KEYS.latestSessionId];
  if (!id) return undefined;
  const sessions = await getSessions();
  return normalizeSession(sessions[id]);
}

export async function saveSession(session) {
  const sessions = await getSessions();
  sessions[session.id] = normalizeSession(session);
  await chrome.storage.local.set({
    [STORAGE_KEYS.sessions]: sessions,
    [STORAGE_KEYS.latestSessionId]: session.id
  });
}

export async function patchSession(sessionId, patch) {
  const sessions = await getSessions();
  const existing = normalizeSession(sessions[sessionId]);
  if (!existing) return undefined;
  const updated = normalizeSession({
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString()
  });
  sessions[sessionId] = updated;
  await chrome.storage.local.set({
    [STORAGE_KEYS.sessions]: sessions,
    [STORAGE_KEYS.latestSessionId]: sessionId
  });
  return updated;
}

export async function setActiveSession(sessionId) {
  const sessions = await getSessions();
  if (!sessions[sessionId]) throw new Error("Report not found.");
  await chrome.storage.local.set({ [STORAGE_KEYS.latestSessionId]: sessionId });
  return normalizeSession(sessions[sessionId]);
}

export async function appendConsoleEntry(tabId, entry) {
  const key = `${STORAGE_KEYS.consolePrefix}${tabId}`;
  const result = await chrome.storage.local.get(key);
  const current = result[key] ?? [];
  await chrome.storage.local.set({ [key]: [...current.slice(-49), entry] });
}

export async function getConsoleEntries(tabId) {
  if (typeof tabId !== "number") return [];
  const key = `${STORAGE_KEYS.consolePrefix}${tabId}`;
  const result = await chrome.storage.local.get(key);
  return result[key] ?? [];
}

export function normalizeSession(session) {
  if (!session) return session;
  const screenshots = [...(session.screenshots ?? [])];
  const recordings = [...(session.recordings ?? [])];
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
    screenshots,
    recordings,
    screenshotDataUrl: screenshots.at(-1)?.dataUrl,
    recordingDataUrl: recordings.at(-1)?.dataUrl,
    recordingMimeType: recordings.at(-1)?.mimeType
  };
}

export function buildTemplateReport({ session, steps, notes }) {
  const normalized = normalizeSession(session);
  const metadata = normalized.metadata;
  const title = metadata?.title || "Untitled page";
  const url = metadata?.url || "Unknown URL";
  const errorLines = normalized.consoleErrors.length
    ? normalized.consoleErrors
        .map((entry) => `- [${entry.timestamp}] ${entry.source}: ${entry.message}`)
        .join("\n")
    : "- No console errors captured.";

  const screenshots = normalized.screenshots ?? [];
  const recordings = normalized.recordings ?? [];
  const attachments = [
    screenshots.length ? `- Screenshots: ${screenshots.length} PNG file${screenshots.length === 1 ? "" : "s"}` : "",
    recordings.length ? `- Recordings: ${recordings.length} WebM file${recordings.length === 1 ? "" : "s"}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  return `# Bug Report: ${title}

## Summary
Issue captured on ${url}.

## Environment
- URL: ${url}
- Browser: ${metadata?.userAgent ?? "Unknown"}
- Viewport: ${metadata ? `${metadata.viewport.width}x${metadata.viewport.height} @ ${metadata.viewport.devicePixelRatio}x` : "Unknown"}
- Screen: ${metadata ? `${metadata.screen.width}x${metadata.screen.height}` : "Unknown"}
- Captured at: ${session.createdAt}
- Capture mode: ${normalized.mode}

## Reproduction Steps
${steps.trim() || "No steps provided."}

## Observed Behavior
${notes.trim() || "No notes provided."}

## Console Errors
${errorLines}

## Attachments
${attachments || "- No binary attachments."}
`;
}

export async function buildReportZip({ session, report }) {
  const normalized = normalizeSession(session);
  const files = [
    {
      name: "report.md",
      bytes: textBytes(report),
      modifiedAt: new Date(session.updatedAt || session.createdAt)
    },
    {
      name: "metadata.json",
      bytes: textBytes(JSON.stringify(normalized, null, 2)),
      modifiedAt: new Date(normalized.updatedAt || normalized.createdAt)
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
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
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
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
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
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
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
  const date = Number.isNaN(value.getTime()) ? new Date() : value;
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export async function generateAiReport(apiKey, model, input) {
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
              text: `Turn this captured browser bug context into a concise, founder/product-team friendly Markdown bug report. Keep the same facts, infer severity only if justified, and include actionable reproduction details.\n\n${fallback}`
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) throw new Error(`OpenAI request failed with ${response.status}`);
  const data = await response.json();
  const text = extractResponseText(data);
  if (!text) throw new Error("OpenAI response did not include text output.");
  return text;
}

function extractResponseText(data) {
  if (data.output_text) return data.output_text;
  return (
    data.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) =>
        content.type === "output_text" || content.text ? content.text ?? "" : ""
      )
      .join("")
      .trim() ?? ""
  );
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
