// src/content/content-main.ts
(() => {
  const bridgeKey = "__screenshot2bug_console_bridge__";
  if (Reflect.get(window, bridgeKey)) return;
  Reflect.set(window, bridgeKey, true);
  const serialize = (value) => {
    try {
      if (value instanceof Error) return value.stack || value.message;
      if (typeof value === "string") return value;
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  const publish = (source, message, extras = {}) => {
    window.postMessage(
      {
        source: "screenshot2bug",
        entry: {
          level: "error",
          source,
          message,
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          url: window.location.href,
          ...extras
        }
      },
      "*"
    );
  };
  const originalError = console.error;
  console.error = (...args) => {
    publish("console", args.map(serialize).join(" "));
    originalError.apply(console, args);
  };
  window.addEventListener(
    "error",
    (event) => {
      const target = event.target;
      if (target && target !== window) {
        const url = target.currentSrc || target.src || target.href || target.data || "";
        const tag = target.tagName ? target.tagName.toLowerCase() : "resource";
        publish("resource", `Failed to load ${tag}${url ? `: ${url}` : ""}`);
        return;
      }
      publish("error", event.message || "Window error", {
        line: event.lineno,
        column: event.colno,
        stack: event.error?.stack
      });
    },
    true
  );
  window.addEventListener("unhandledrejection", (event) => {
    publish("unhandledrejection", serialize(event.reason));
  });
  window.addEventListener("securitypolicyviolation", (event) => {
    publish(
      "securitypolicyviolation",
      `${event.violatedDirective}: blocked ${event.blockedURI || "inline code"}`
    );
  });
})();
