// src/content/content-script.ts
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
    if (message.type !== "START_REGION_SELECTION") return false;
    void selectRegion().then((region) => sendResponse(region)).catch(
      (error) => sendResponse({ error: error instanceof Error ? error.message : String(error) })
    );
    return true;
  }
);
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
