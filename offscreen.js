// src/offscreen/offscreen.ts
var recorder;
var stream;
var sourceStream;
var chunks = [];
var currentSessionId;
var currentRegion;
var drawFrameHandle;
var cropVideo;
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "OFFSCREEN_START_RECORDING") {
    void startRecording(message.sessionId, message.streamId, message.region);
  }
  if (message.type === "OFFSCREEN_STOP_RECORDING") {
    stopRecording(message.sessionId);
  }
});
async function startRecording(sessionId, streamId, region) {
  try {
    currentSessionId = sessionId;
    currentRegion = region;
    chunks = [];
    sourceStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      }
    });
    stream = region ? await createCroppedStream(sourceStream, region) : sourceStream;
    const mimeType = pickMimeType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : void 0);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = (event) => {
      const recorderError = event;
      void notifyError(sessionId, recorderError.error?.message ?? "Recording failed.");
    };
    recorder.onstop = () => void completeRecording(sessionId);
    recorder.start(1e3);
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
  cleanupStreams();
  const blob = new Blob(chunks, { type: mimeType });
  const dataUrl = await blobToDataUrl(blob);
  await chrome.runtime.sendMessage({
    type: "OFFSCREEN_RECORDING_COMPLETE",
    sessionId,
    dataUrl,
    mimeType,
    region: currentRegion
  });
  recorder = void 0;
  stream = void 0;
  sourceStream = void 0;
  chunks = [];
  currentSessionId = void 0;
  currentRegion = void 0;
}
async function notifyError(sessionId, error) {
  cleanupStreams();
  await chrome.runtime.sendMessage({
    type: "OFFSCREEN_RECORDING_ERROR",
    sessionId,
    error
  });
  recorder = void 0;
  stream = void 0;
  sourceStream = void 0;
  chunks = [];
  currentSessionId = void 0;
  currentRegion = void 0;
}
async function createCroppedStream(input, region) {
  cropVideo = document.createElement("video");
  cropVideo.srcObject = input;
  cropVideo.muted = true;
  cropVideo.playsInline = true;
  await cropVideo.play();
  if (!cropVideo.videoWidth || !cropVideo.videoHeight) {
    await waitForVideoMetadata(cropVideo);
  }
  const scaleX = cropVideo.videoWidth / region.viewportWidth;
  const scaleY = cropVideo.videoHeight / region.viewportHeight;
  const sourceX = Math.round(region.x * scaleX);
  const sourceY = Math.round(region.y * scaleY);
  const sourceWidth = Math.max(1, Math.round(region.width * scaleX));
  const sourceHeight = Math.max(1, Math.round(region.height * scaleY));
  const canvas = document.createElement("canvas");
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare selected-area recording.");
  const draw = () => {
    if (!cropVideo) return;
    context.drawImage(
      cropVideo,
      sourceX,
      sourceY,
      Math.min(sourceWidth, cropVideo.videoWidth - sourceX),
      Math.min(sourceHeight, cropVideo.videoHeight - sourceY),
      0,
      0,
      sourceWidth,
      sourceHeight
    );
    drawFrameHandle = requestAnimationFrame(draw);
  };
  draw();
  return canvas.captureStream(30);
}
function cleanupStreams() {
  if (typeof drawFrameHandle === "number") {
    cancelAnimationFrame(drawFrameHandle);
    drawFrameHandle = void 0;
  }
  cropVideo?.pause();
  cropVideo = void 0;
  stream?.getTracks().forEach((track) => track.stop());
  if (sourceStream !== stream) {
    sourceStream?.getTracks().forEach((track) => track.stop());
  }
}
function waitForVideoMetadata(video) {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("Could not read selected-area video dimensions."));
    }, 2e3);
    video.addEventListener(
      "loadedmetadata",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
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
