import type { RuntimeMessage } from "../shared/types";

let recorder: MediaRecorder | undefined;
let stream: MediaStream | undefined;
let chunks: Blob[] = [];
let currentSessionId: string | undefined;

chrome.runtime.onMessage.addListener((message: RuntimeMessage) => {
  if (message.type === "OFFSCREEN_START_RECORDING") {
    void startRecording(message.sessionId, message.streamId);
  }
  if (message.type === "OFFSCREEN_STOP_RECORDING") {
    stopRecording(message.sessionId);
  }
});

async function startRecording(sessionId: string, streamId: string): Promise<void> {
  try {
    currentSessionId = sessionId;
    chunks = [];
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      } as unknown as MediaTrackConstraints
    });

    const mimeType = pickMimeType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = (event) => {
      const recorderError = event as Event & { error?: Error };
      void notifyError(sessionId, recorderError.error?.message ?? "Recording failed.");
    };
    recorder.onstop = () => void completeRecording(sessionId);
    recorder.start(1000);
  } catch (error) {
    await notifyError(sessionId, error instanceof Error ? error.message : String(error));
  }
}

function stopRecording(sessionId: string): void {
  if (sessionId !== currentSessionId) return;
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  } else {
    void notifyError(sessionId, "No active recording found.");
  }
}

async function completeRecording(sessionId: string): Promise<void> {
  const mimeType = recorder?.mimeType || "video/webm";
  stream?.getTracks().forEach((track) => track.stop());
  const blob = new Blob(chunks, { type: mimeType });
  const dataUrl = await blobToDataUrl(blob);

  await chrome.runtime.sendMessage({
    type: "OFFSCREEN_RECORDING_COMPLETE",
    sessionId,
    dataUrl,
    mimeType
  } satisfies RuntimeMessage);

  recorder = undefined;
  stream = undefined;
  chunks = [];
  currentSessionId = undefined;
}

async function notifyError(sessionId: string, error: string): Promise<void> {
  stream?.getTracks().forEach((track) => track.stop());
  await chrome.runtime.sendMessage({
    type: "OFFSCREEN_RECORDING_ERROR",
    sessionId,
    error
  } satisfies RuntimeMessage);
}

function pickMimeType(): string {
  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read recording."));
    reader.readAsDataURL(blob);
  });
}
