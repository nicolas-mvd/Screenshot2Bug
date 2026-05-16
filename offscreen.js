let recorder;
let stream;
let chunks = [];
let currentSessionId;

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "OFFSCREEN_START_RECORDING") {
    void startRecording(message.sessionId, message.streamId);
  }
  if (message.type === "OFFSCREEN_STOP_RECORDING") {
    stopRecording(message.sessionId);
  }
});

async function startRecording(sessionId, streamId) {
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
      }
    });

    const mimeType = pickMimeType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = (event) => {
      void notifyError(sessionId, event.error?.message ?? "Recording failed.");
    };
    recorder.onstop = () => void completeRecording(sessionId);
    recorder.start(1000);
  } catch (error) {
    await notifyError(sessionId, error instanceof Error ? error.message : String(error));
  }
}

function stopRecording(sessionId) {
  if (sessionId !== currentSessionId) return;
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  } else {
    void notifyError(sessionId, "No active recording found.");
  }
}

async function completeRecording(sessionId) {
  const mimeType = recorder?.mimeType || "video/webm";
  stream?.getTracks().forEach((track) => track.stop());
  const blob = new Blob(chunks, { type: mimeType });
  const dataUrl = await blobToDataUrl(blob);

  await chrome.runtime.sendMessage({
    type: "OFFSCREEN_RECORDING_COMPLETE",
    sessionId,
    dataUrl,
    mimeType
  });

  recorder = undefined;
  stream = undefined;
  chunks = [];
  currentSessionId = undefined;
}

async function notifyError(sessionId, error) {
  stream?.getTracks().forEach((track) => track.stop());
  await chrome.runtime.sendMessage({
    type: "OFFSCREEN_RECORDING_ERROR",
    sessionId,
    error
  });
}

function pickMimeType() {
  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read recording."));
    reader.readAsDataURL(blob);
  });
}
