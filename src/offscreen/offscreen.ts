import type { RuntimeMessage } from "../shared/types";
import type { CaptureRegion } from "../shared/types";

let recorder: MediaRecorder | undefined;
let stream: MediaStream | undefined;
let sourceStream: MediaStream | undefined;
let chunks: Blob[] = [];
let currentSessionId: string | undefined;
let currentRegion: CaptureRegion | undefined;
let drawFrameHandle: number | undefined;
let cropVideo: HTMLVideoElement | undefined;

chrome.runtime.onMessage.addListener((message: RuntimeMessage) => {
  if (message.type === "OFFSCREEN_START_RECORDING") {
    void startRecording(message.sessionId, message.streamId, message.region);
  }
  if (message.type === "OFFSCREEN_STOP_RECORDING") {
    stopRecording(message.sessionId);
  }
});

async function startRecording(
  sessionId: string,
  streamId: string,
  region?: CaptureRegion
): Promise<void> {
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
      } as unknown as MediaTrackConstraints
    });
    stream = region ? await createCroppedStream(sourceStream, region) : sourceStream;

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
  cleanupStreams();
  const blob = new Blob(chunks, { type: mimeType });
  const dataUrl = await blobToDataUrl(blob);

  await chrome.runtime.sendMessage({
    type: "OFFSCREEN_RECORDING_COMPLETE",
    sessionId,
    dataUrl,
    mimeType,
    region: currentRegion
  } satisfies RuntimeMessage);

  recorder = undefined;
  stream = undefined;
  sourceStream = undefined;
  chunks = [];
  currentSessionId = undefined;
  currentRegion = undefined;
}

async function notifyError(sessionId: string, error: string): Promise<void> {
  cleanupStreams();
  await chrome.runtime.sendMessage({
    type: "OFFSCREEN_RECORDING_ERROR",
    sessionId,
    error
  } satisfies RuntimeMessage);
  recorder = undefined;
  stream = undefined;
  sourceStream = undefined;
  chunks = [];
  currentSessionId = undefined;
  currentRegion = undefined;
}

async function createCroppedStream(
  input: MediaStream,
  region: CaptureRegion
): Promise<MediaStream> {
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

function cleanupStreams(): void {
  if (typeof drawFrameHandle === "number") {
    cancelAnimationFrame(drawFrameHandle);
    drawFrameHandle = undefined;
  }
  cropVideo?.pause();
  cropVideo = undefined;
  stream?.getTracks().forEach((track) => track.stop());
  if (sourceStream !== stream) {
    sourceStream?.getTracks().forEach((track) => track.stop());
  }
}

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("Could not read selected-area video dimensions."));
    }, 2000);
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
