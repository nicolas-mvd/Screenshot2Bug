import type { RuntimeMessage } from "../shared/types";

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "screenshot2bug") return;

  chrome.runtime
    .sendMessage({
      type: "LOG_CONSOLE_ENTRY",
      entry: event.data.entry
    } satisfies RuntimeMessage)
    .catch(() => {
      // The extension context can disappear during reloads; ignore transient logging failures.
    });
});
