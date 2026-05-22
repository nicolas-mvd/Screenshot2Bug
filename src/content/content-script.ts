import type { RuntimeMessage } from "../shared/types";
import type { CaptureRegion } from "../shared/types";

const contentScriptKey = "__screenshot2bug_content_script__";
const contentWindow = window as unknown as Window & Record<string, boolean | undefined>;
let activeRecordingControl:
  | {
      sessionId: string;
      state: "recording" | "saving";
    }
  | undefined;
let recordingControlsWatchHandle: number | undefined;

if (!contentWindow[contentScriptKey]) {
  contentWindow[contentScriptKey] = true;

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "screenshot2bug") return;
    const runtimeMessage = event.data.entry
      ? ({
          type: "LOG_CONSOLE_ENTRY",
          entry: event.data.entry
        } satisfies RuntimeMessage)
      : event.data.networkEntry
        ? ({
            type: "LOG_NETWORK_ENTRY",
            entry: event.data.networkEntry
          } satisfies RuntimeMessage)
        : undefined;

    if (!runtimeMessage) return;

    chrome.runtime
      .sendMessage(runtimeMessage)
      .catch(() => {
        // The extension context can disappear during reloads; ignore transient logging failures.
      });
  });

  chrome.runtime.onMessage.addListener(
    (
      message: RuntimeMessage,
      _sender,
      sendResponse: (response: CaptureRegion | { error: string }) => void
    ) => {
      if (message.type === "SHOW_RECORDING_CONTROLS") {
        showRecordingControls(message.sessionId, message.state);
        sendResponse({ error: "" });
        return false;
      }

      if (message.type === "HIDE_RECORDING_CONTROLS") {
        hideRecordingControls(message.sessionId);
        sendResponse({ error: "" });
        return false;
      }

      if (message.type !== "START_REGION_SELECTION") return false;

      void selectRegion()
        .then((region) => sendResponse(region))
        .catch((error: unknown) =>
          sendResponse({ error: error instanceof Error ? error.message : String(error) })
        );
      return true;
    }
  );

  chrome.runtime
    .sendMessage({
      type: "CONTENT_SCRIPT_READY"
    } satisfies RuntimeMessage)
    .catch(() => {
      // The extension context can disappear during reloads; ignore transient readiness pings.
    });
}

function showRecordingControls(sessionId: string, state: "recording" | "saving"): void {
  activeRecordingControl = { sessionId, state };
  renderRecordingControls(sessionId, state);
  startRecordingControlsWatch();
}

function renderRecordingControls(sessionId: string, state: "recording" | "saving"): void {
  const existing = document.querySelector<HTMLElement>("[data-screenshot2bug-recording-controls]");
  if (existing?.dataset.sessionId === sessionId) {
    updateRecordingControls(existing, state);
    return;
  }
  existing?.remove();

  const controls = document.createElement("div");
  controls.dataset.screenshot2bugRecordingControls = "true";
  controls.dataset.sessionId = sessionId;
  controls.style.cssText = [
    "position:fixed",
    "right:18px",
    "top:18px",
    "z-index:2147483647",
    "display:flex",
    "align-items:center",
    "gap:10px",
    "border:1px solid rgba(255,255,255,.18)",
    "border-radius:8px",
    "background:#172026",
    "color:#ffffff",
    "box-shadow:0 10px 28px rgba(15,23,42,.28)",
    "font:600 13px system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "padding:9px 10px"
  ].join(";");

  const label = document.createElement("span");
  label.dataset.role = "label";
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.role = "stop";
  button.style.cssText = [
    "border:0",
    "border-radius:7px",
    "background:#b23a26",
    "color:#ffffff",
    "font:700 12px system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "min-height:30px",
    "padding:0 10px",
    "cursor:pointer"
  ].join(";");
  button.addEventListener("click", () => {
    updateRecordingControls(controls, "saving");
    chrome.runtime
      .sendMessage({
        type: "STOP_VIDEO_CAPTURE",
        sessionId
      } satisfies RuntimeMessage)
      .catch((error: unknown) => {
        updateRecordingControls(controls, "recording");
        label.textContent = error instanceof Error ? error.message : String(error);
      });
  });

  controls.append(label, button);
  document.documentElement.append(controls);
  updateRecordingControls(controls, state);
}

function startRecordingControlsWatch(): void {
  if (typeof recordingControlsWatchHandle === "number") return;
  recordingControlsWatchHandle = window.setInterval(() => {
    if (!activeRecordingControl) return;
    const controls = document.querySelector<HTMLElement>("[data-screenshot2bug-recording-controls]");
    if (controls?.dataset.sessionId === activeRecordingControl.sessionId) {
      updateRecordingControls(controls, activeRecordingControl.state);
      return;
    }
    renderRecordingControls(activeRecordingControl.sessionId, activeRecordingControl.state);
  }, 1000);
}

function updateRecordingControls(container: HTMLElement, state: "recording" | "saving"): void {
  const label = container.querySelector<HTMLElement>("[data-role='label']");
  const button = container.querySelector<HTMLButtonElement>("[data-role='stop']");
  if (label) label.textContent = state === "saving" ? "Saving recording..." : "Recording tab";
  if (button) {
    button.textContent = state === "saving" ? "Saving..." : "Stop";
    button.disabled = state === "saving";
    button.style.opacity = state === "saving" ? "0.7" : "1";
    button.style.cursor = state === "saving" ? "wait" : "pointer";
  }
}

function hideRecordingControls(sessionId: string): void {
  if (activeRecordingControl?.sessionId === sessionId) {
    activeRecordingControl = undefined;
  }
  if (!activeRecordingControl && typeof recordingControlsWatchHandle === "number") {
    window.clearInterval(recordingControlsWatchHandle);
    recordingControlsWatchHandle = undefined;
  }
  const controls = document.querySelector<HTMLElement>("[data-screenshot2bug-recording-controls]");
  if (controls?.dataset.sessionId === sessionId) controls.remove();
}

function selectRegion(): Promise<CaptureRegion> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector("[data-screenshot2bug-region-overlay]");
    existing?.remove();

    const overlay = document.createElement("div");
    overlay.dataset.screenshot2bugRegionOverlay = "true";
    overlay.tabIndex = 0;
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "cursor:crosshair",
      "background:rgba(15,23,42,.28)",
      "user-select:none"
    ].join(";");

    const box = document.createElement("div");
    box.style.cssText = [
      "position:fixed",
      "display:none",
      "border:2px solid #ffffff",
      "background:rgba(22,106,106,.22)",
      "box-shadow:0 0 0 9999px rgba(15,23,42,.34),0 0 0 1px rgba(22,106,106,.75) inset",
      "pointer-events:none"
    ].join(";");

    const label = document.createElement("div");
    label.textContent = "Drag to select. Press Esc to cancel.";
    label.style.cssText = [
      "position:fixed",
      "left:50%",
      "top:18px",
      "transform:translateX(-50%)",
      "border-radius:8px",
      "background:#172026",
      "color:#ffffff",
      "font:600 13px system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "padding:8px 11px",
      "box-shadow:0 8px 24px rgba(15,23,42,.22)",
      "pointer-events:none"
    ].join(";");

    overlay.append(box, label);
    document.documentElement.append(overlay);
    overlay.focus({ preventScroll: true });

    let startX = 0;
    let startY = 0;
    let current: CaptureRegion | undefined;
    let dragging = false;

    const cleanup = () => {
      overlay.removeEventListener("pointerdown", onPointerDown);
      overlay.removeEventListener("pointermove", onPointerMove);
      overlay.removeEventListener("pointerup", onPointerUp);
      overlay.removeEventListener("keydown", onKeyDown);
      overlay.remove();
    };

    const finish = () => {
      if (!current || current.width < 8 || current.height < 8) {
        cleanup();
        reject(new Error("Region selection canceled."));
        return;
      }
      cleanup();
      resolve(current);
    };

    function onPointerDown(event: PointerEvent): void {
      dragging = true;
      startX = clamp(event.clientX, 0, window.innerWidth);
      startY = clamp(event.clientY, 0, window.innerHeight);
      overlay.setPointerCapture(event.pointerId);
      updateSelection(startX, startY);
    }

    function onPointerMove(event: PointerEvent): void {
      if (!dragging) return;
      updateSelection(event.clientX, event.clientY);
    }

    function onPointerUp(event: PointerEvent): void {
      if (!dragging) return;
      dragging = false;
      updateSelection(event.clientX, event.clientY);
      finish();
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        cleanup();
        reject(new Error("Region selection canceled."));
      }
      if (event.key === "Enter") {
        finish();
      }
    }

    function updateSelection(clientX: number, clientY: number): void {
      const endX = clamp(clientX, 0, window.innerWidth);
      const endY = clamp(clientY, 0, window.innerHeight);
      const x = Math.min(startX, endX);
      const y = Math.min(startY, endY);
      const width = Math.abs(endX - startX);
      const height = Math.abs(endY - startY);

      current = {
        x,
        y,
        width,
        height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1
      };

      box.style.display = "block";
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
    }

    overlay.addEventListener("pointerdown", onPointerDown);
    overlay.addEventListener("pointermove", onPointerMove);
    overlay.addEventListener("pointerup", onPointerUp);
    overlay.addEventListener("keydown", onKeyDown);
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
