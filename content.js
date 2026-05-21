// src/content/content-script.ts
var contentScriptKey = "__screenshot2bug_content_script__";
var contentWindow = window;
if (!contentWindow[contentScriptKey]) {
  contentWindow[contentScriptKey] = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "screenshot2bug") return;
    chrome.runtime.sendMessage({
      type: "LOG_CONSOLE_ENTRY",
      entry: event.data.entry
    }).catch(() => {
    });
  });
  chrome.runtime.onMessage.addListener(
    (message, _sender, sendResponse) => {
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
      void selectRegion().then((region) => sendResponse(region)).catch(
        (error) => sendResponse({ error: error instanceof Error ? error.message : String(error) })
      );
      return true;
    }
  );
}
function showRecordingControls(sessionId, state) {
  const existing = document.querySelector("[data-screenshot2bug-recording-controls]");
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
    chrome.runtime.sendMessage({
      type: "STOP_VIDEO_CAPTURE",
      sessionId
    }).catch((error) => {
      updateRecordingControls(controls, "recording");
      label.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  controls.append(label, button);
  document.documentElement.append(controls);
  updateRecordingControls(controls, state);
}
function updateRecordingControls(container, state) {
  const label = container.querySelector("[data-role='label']");
  const button = container.querySelector("[data-role='stop']");
  if (label) label.textContent = state === "saving" ? "Saving recording..." : "Recording selected area";
  if (button) {
    button.textContent = state === "saving" ? "Saving..." : "Stop";
    button.disabled = state === "saving";
    button.style.opacity = state === "saving" ? "0.7" : "1";
    button.style.cursor = state === "saving" ? "wait" : "pointer";
  }
}
function hideRecordingControls(sessionId) {
  const controls = document.querySelector("[data-screenshot2bug-recording-controls]");
  if (controls?.dataset.sessionId === sessionId) controls.remove();
}
function selectRegion() {
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
    let current;
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
    function onPointerDown(event) {
      dragging = true;
      startX = clamp(event.clientX, 0, window.innerWidth);
      startY = clamp(event.clientY, 0, window.innerHeight);
      overlay.setPointerCapture(event.pointerId);
      updateSelection(startX, startY);
    }
    function onPointerMove(event) {
      if (!dragging) return;
      updateSelection(event.clientX, event.clientY);
    }
    function onPointerUp(event) {
      if (!dragging) return;
      dragging = false;
      updateSelection(event.clientX, event.clientY);
      finish();
    }
    function onKeyDown(event) {
      if (event.key === "Escape") {
        cleanup();
        reject(new Error("Region selection canceled."));
      }
      if (event.key === "Enter") {
        finish();
      }
    }
    function updateSelection(clientX, clientY) {
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
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
