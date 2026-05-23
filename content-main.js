"use strict";
(() => {
  // src/content/content-main.ts
  (() => {
    const bridgeKey = "__screenshot2bug_console_bridge__";
    if (Reflect.get(window, bridgeKey)) return;
    Reflect.set(window, bridgeKey, true);
    const PREVIEW_LIMIT = 32 * 1024;
    const REDACTED = "[redacted]";
    const serialize = (value) => {
      try {
        if (value instanceof Error) return value.stack || value.message;
        if (typeof value === "string") return value;
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };
    const publishConsole = (source, message, extras = {}) => {
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
    const publishNetwork = (entry) => {
      window.postMessage(
        {
          source: "screenshot2bug",
          networkEntry: sanitizeNetworkEntry(entry)
        },
        "*"
      );
    };
    const originalError = console.error;
    console.error = (...args) => {
      publishConsole("console", args.map(serialize).join(" "));
      originalError.apply(console, args);
    };
    window.addEventListener(
      "error",
      (event) => {
        const target = event.target;
        if (target && target !== window) {
          const url = target.currentSrc || target.src || target.href || target.data || "";
          const tag = target.tagName ? target.tagName.toLowerCase() : "resource";
          publishConsole("resource", `Failed to load ${tag}${url ? `: ${url}` : ""}`);
          return;
        }
        publishConsole("error", event.message || "Window error", {
          line: event.lineno,
          column: event.colno,
          stack: event.error?.stack
        });
      },
      true
    );
    window.addEventListener("unhandledrejection", (event) => {
      publishConsole("unhandledrejection", serialize(event.reason));
    });
    window.addEventListener("securitypolicyviolation", (event) => {
      publishConsole(
        "securitypolicyviolation",
        `${event.violatedDirective}: blocked ${event.blockedURI || "inline code"}`
      );
    });
    installFetchCapture();
    installXhrCapture();
    function installFetchCapture() {
      if (typeof window.fetch !== "function") return;
      const originalFetch = window.fetch;
      window.fetch = async function screenshot2bugFetch(input, init) {
        const startedAt = performance.now();
        const timestamp = (/* @__PURE__ */ new Date()).toISOString();
        const request = describeFetchRequest(input, init);
        const requestBody = await previewBody(init?.body);
        try {
          const response = await originalFetch.apply(this, arguments);
          const responsePreview = await previewFetchResponse(response);
          const completedAt = (/* @__PURE__ */ new Date()).toISOString();
          publishNetwork({
            id: crypto.randomUUID(),
            source: "page",
            type: "fetch",
            method: request.method,
            url: request.url,
            timestamp,
            completedAt,
            durationMs: Math.round(performance.now() - startedAt),
            status: response.status,
            statusText: response.statusText,
            ok: response.ok,
            fromCache: false,
            requestHeaders: request.headers,
            responseHeaders: headersToRecord(response.headers),
            requestBodyPreview: requestBody?.preview,
            requestBodyTruncated: requestBody?.truncated,
            responseBodyPreview: responsePreview?.preview,
            responseBodyTruncated: responsePreview?.truncated,
            responseBodyUnavailableReason: responsePreview?.unavailableReason,
            responseContentType: response.headers.get("content-type") || void 0
          });
          return response;
        } catch (error) {
          publishNetwork({
            id: crypto.randomUUID(),
            source: "page",
            type: "fetch",
            method: request.method,
            url: request.url,
            timestamp,
            completedAt: (/* @__PURE__ */ new Date()).toISOString(),
            durationMs: Math.round(performance.now() - startedAt),
            ok: false,
            requestHeaders: request.headers,
            requestBodyPreview: requestBody?.preview,
            requestBodyTruncated: requestBody?.truncated,
            responseBodyUnavailableReason: "request failed before a response was available",
            error: error instanceof Error ? error.message : String(error)
          });
          throw error;
        }
      };
    }
    function installXhrCapture() {
      const OriginalXHR = window.XMLHttpRequest;
      if (!OriginalXHR?.prototype) return;
      const originalOpen = OriginalXHR.prototype.open;
      const originalSend = OriginalXHR.prototype.send;
      const originalSetRequestHeader = OriginalXHR.prototype.setRequestHeader;
      const requests = /* @__PURE__ */ new WeakMap();
      OriginalXHR.prototype.open = function screenshot2bugOpen(method, url) {
        requests.set(this, {
          method: String(method || "GET").toUpperCase(),
          url: String(url || window.location.href),
          requestHeaders: {}
        });
        return originalOpen.apply(this, arguments);
      };
      OriginalXHR.prototype.setRequestHeader = function screenshot2bugSetHeader(name, value) {
        const meta = requests.get(this);
        if (meta) meta.requestHeaders[name] = String(value);
        return originalSetRequestHeader.apply(this, arguments);
      };
      OriginalXHR.prototype.send = function screenshot2bugSend(body) {
        const xhr = this;
        const meta = requests.get(xhr) ?? {
          method: "GET",
          url: window.location.href,
          requestHeaders: {}
        };
        requests.set(xhr, meta);
        const startedAt = performance.now();
        const timestamp = (/* @__PURE__ */ new Date()).toISOString();
        const requestBody = previewBody(body);
        let published = false;
        const publishOnce = async (state, error) => {
          if (published) return;
          published = true;
          const requestPreview = await requestBody;
          const responseHeaders = parseRawHeaders(safeCall(() => xhr.getAllResponseHeaders()) || "");
          const contentType = responseHeaders["content-type"];
          const responsePreview = previewXhrResponse(xhr, contentType);
          publishNetwork({
            id: crypto.randomUUID(),
            source: "page",
            type: "xmlhttprequest",
            method: meta.method,
            url: meta.url,
            timestamp,
            completedAt: (/* @__PURE__ */ new Date()).toISOString(),
            durationMs: Math.round(performance.now() - startedAt),
            status: xhr.status || void 0,
            statusText: xhr.statusText || state,
            ok: xhr.status >= 200 && xhr.status < 400,
            requestHeaders: meta.requestHeaders,
            responseHeaders,
            requestBodyPreview: requestPreview?.preview,
            requestBodyTruncated: requestPreview?.truncated,
            responseBodyPreview: responsePreview?.preview,
            responseBodyTruncated: responsePreview?.truncated,
            responseBodyUnavailableReason: responsePreview?.unavailableReason,
            responseContentType: contentType,
            error
          });
        };
        xhr.addEventListener("loadend", () => {
          void publishOnce("complete");
        });
        xhr.addEventListener("error", () => {
          void publishOnce("error", "XMLHttpRequest failed");
        });
        xhr.addEventListener("abort", () => {
          void publishOnce("abort", "XMLHttpRequest aborted");
        });
        xhr.addEventListener("timeout", () => {
          void publishOnce("timeout", "XMLHttpRequest timed out");
        });
        return originalSend.apply(xhr, arguments);
      };
    }
    function describeFetchRequest(input, init = {}) {
      const method = String(init?.method || input?.method || "GET").toUpperCase();
      const url = String(input?.url || input || window.location.href);
      const headers = {
        ...input?.headers ? headersToRecord(input.headers) : {},
        ...init?.headers ? headersToRecord(init.headers) : {}
      };
      return { method, url, headers };
    }
    async function previewFetchResponse(response) {
      if (!response) return { unavailableReason: "no response object" };
      if (response.bodyUsed) return { unavailableReason: "response body was already consumed" };
      if (response.type === "opaque") return { unavailableReason: "opaque response" };
      const contentType = response.headers.get("content-type") || "";
      if (!isTextLike(contentType) || response.status === 204 || response.status === 304) {
        return {
          unavailableReason: response.status === 204 || response.status === 304 ? `status ${response.status} has no response body` : `non-text response (${contentType || "unknown content type"})`
        };
      }
      try {
        const clone = response.clone();
        const preview = clone.body?.getReader ? await readStreamPreview(clone.body, contentType) : truncateAndSanitize(await clone.text(), contentType);
        return preview?.preview ? preview : { ...preview, unavailableReason: "empty response body" };
      } catch {
        return { unavailableReason: "response body could not be read" };
      }
    }
    function previewXhrResponse(xhr, contentType = "") {
      if (!isTextLike(contentType) || xhr.responseType && xhr.responseType !== "text") {
        return {
          unavailableReason: xhr.responseType ? `XHR responseType ${xhr.responseType} is not text` : `non-text response (${contentType || "unknown content type"})`
        };
      }
      try {
        const preview = truncateAndSanitize(xhr.responseText || "", contentType);
        return preview.preview ? preview : { ...preview, unavailableReason: "empty response body" };
      } catch {
        return { unavailableReason: "XHR response body could not be read" };
      }
    }
    async function previewBody(body) {
      if (body == null) return void 0;
      try {
        if (typeof body === "string") return truncateAndSanitize(body);
        if (body instanceof URLSearchParams) return truncateAndSanitize(body.toString());
        if (body instanceof FormData) return truncateAndSanitize(serializeFormData(body));
        if (body instanceof Blob) {
          if (!isTextLike(body.type)) {
            return {
              preview: `[${body.constructor.name}: ${body.type || "application/octet-stream"}, ${body.size} bytes]`,
              truncated: false
            };
          }
          return truncateAndSanitize(await body.slice(0, PREVIEW_LIMIT + 1).text(), body.type);
        }
        if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
          const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
          return decodeBytesPreview(bytes);
        }
        if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
          return {
            preview: "[ReadableStream body not inspected]",
            truncated: false
          };
        }
        return truncateAndSanitize(String(body));
      } catch {
        return void 0;
      }
    }
    async function readStreamPreview(stream, contentType = "") {
      const reader = stream.getReader();
      const chunks = [];
      let received = 0;
      let truncated = false;
      try {
        while (received <= PREVIEW_LIMIT) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          chunks.push(value);
          received += value.byteLength ?? value.length ?? 0;
          if (received > PREVIEW_LIMIT) {
            truncated = true;
            await reader.cancel();
            break;
          }
        }
      } catch {
        return void 0;
      }
      const bytes = new Uint8Array(Math.min(received, PREVIEW_LIMIT));
      let offset = 0;
      for (const chunk of chunks) {
        const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        bytes.set(view.slice(0, bytes.length - offset), offset);
        offset += view.byteLength;
        if (offset >= bytes.length) break;
      }
      const decoded = new TextDecoder().decode(bytes);
      const sanitized = sanitizePreview(decoded, contentType);
      return { preview: sanitized, truncated };
    }
    function decodeBytesPreview(bytes) {
      const truncated = bytes.byteLength > PREVIEW_LIMIT;
      const previewBytes = bytes.slice(0, PREVIEW_LIMIT);
      return {
        preview: sanitizePreview(new TextDecoder().decode(previewBytes)),
        truncated
      };
    }
    function truncateAndSanitize(value, contentType = "") {
      const truncated = value.length > PREVIEW_LIMIT;
      return {
        preview: sanitizePreview(value.slice(0, PREVIEW_LIMIT), contentType),
        truncated
      };
    }
    function sanitizeNetworkEntry(entry) {
      return {
        ...entry,
        url: sanitizeUrl(entry.url),
        requestHeaders: sanitizeHeaders(entry.requestHeaders),
        responseHeaders: sanitizeHeaders(entry.responseHeaders),
        requestBodyPreview: entry.requestBodyPreview ? sanitizePreview(entry.requestBodyPreview, entry.requestHeaders?.["content-type"]) : void 0,
        responseBodyPreview: entry.responseBodyPreview ? sanitizePreview(entry.responseBodyPreview, entry.responseContentType) : void 0,
        responseBodyUnavailableReason: entry.responseBodyUnavailableReason ? sanitizePreview(entry.responseBodyUnavailableReason) : void 0
      };
    }
    function sanitizeHeaders(headers = {}) {
      return Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [
          name.toLowerCase(),
          isSensitiveName(name) ? REDACTED : sanitizePreview(String(value))
        ])
      );
    }
    function sanitizeUrl(input) {
      try {
        const url = new URL(input, window.location.href);
        for (const key of [...url.searchParams.keys()]) {
          if (isSensitiveName(key)) url.searchParams.set(key, REDACTED);
        }
        return url.href;
      } catch {
        return sanitizePreview(String(input));
      }
    }
    function sanitizePreview(value, contentType = "") {
      let text = String(value);
      if (isJsonLike(contentType) || looksJson(text)) {
        try {
          return JSON.stringify(redactJson(JSON.parse(text)), null, 2);
        } catch {
        }
      }
      if (contentType.includes("x-www-form-urlencoded") || looksFormEncoded(text)) {
        try {
          const params = new URLSearchParams(text);
          for (const key of [...params.keys()]) {
            if (isSensitiveName(key)) params.set(key, REDACTED);
          }
          text = params.toString();
        } catch {
        }
      }
      return text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`).replace(
        /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|client[_-]?secret)=([^&\s]+)/gi,
        `$1=${REDACTED}`
      );
    }
    function redactJson(value) {
      if (Array.isArray(value)) return value.map(redactJson);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [
          key,
          isSensitiveName(key) ? REDACTED : redactJson(nested)
        ])
      );
    }
    function isSensitiveName(name = "") {
      return /authorization|cookie|token|password|passwd|secret|api[-_]?key|session|credential|csrf|xsrf/i.test(
        name
      );
    }
    function isTextLike(contentType = "") {
      return !contentType || /text|json|xml|javascript|typescript|html|css|svg|form-urlencoded/i.test(contentType);
    }
    function isJsonLike(contentType = "") {
      return /json/i.test(contentType);
    }
    function looksJson(value) {
      const text = value.trim();
      return text.startsWith("{") && text.endsWith("}") || text.startsWith("[") && text.endsWith("]");
    }
    function looksFormEncoded(value) {
      return /^[^=\s&]+=[\s\S]*(&[^=\s&]+=[\s\S]*)*$/.test(value.trim());
    }
    function headersToRecord(headers) {
      const record = {};
      try {
        if (headers instanceof Headers) {
          headers.forEach((value, key) => {
            record[key] = value;
          });
          return record;
        }
        if (Array.isArray(headers)) {
          for (const [key, value] of headers) record[String(key)] = String(value);
          return record;
        }
        for (const [key, value] of Object.entries(headers ?? {})) {
          record[key] = Array.isArray(value) ? value.join(", ") : String(value);
        }
      } catch {
        return record;
      }
      return record;
    }
    function parseRawHeaders(raw) {
      const headers = {};
      for (const line of raw.split(/\r?\n/)) {
        const index = line.indexOf(":");
        if (index === -1) continue;
        headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
      }
      return headers;
    }
    function serializeFormData(formData) {
      const values = {};
      for (const [key, value] of formData.entries()) {
        values[key] = value instanceof File ? `[File: ${value.name}, ${value.type || "application/octet-stream"}, ${value.size} bytes]` : value;
      }
      return JSON.stringify(values);
    }
    function safeCall(fn) {
      try {
        return fn();
      } catch {
        return void 0;
      }
    }
  })();
})();
