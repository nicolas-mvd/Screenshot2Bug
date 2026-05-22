import type { CaptureSession } from "./types";
import { normalizeSession } from "./storage";

export interface ReportInput {
  session: CaptureSession;
  steps: string;
  notes: string;
}

export function buildTemplateReport({ session, steps, notes }: ReportInput): string {
  const normalized = normalizeSession(session) ?? session;
  const metadata = normalized.metadata;
  const title = metadata?.title || "Untitled page";
  const url = metadata?.url || "Unknown URL";
  const errorLines = normalized.consoleErrors.length
    ? normalized.consoleErrors
        .map((entry) => `- [${entry.timestamp}] ${entry.source}: ${entry.message}`)
        .join("\n")
    : "- No console errors captured.";
  const networkLines = formatNetworkRequests(normalized);

  const screenshots = normalized.screenshots ?? [];
  const recordings = normalized.recordings ?? [];
  const attachments = [
    screenshots.length
      ? `- Screenshots: ${screenshots.length} PNG file${screenshots.length === 1 ? "" : "s"}${formatEvidenceDetails(screenshots)}`
      : "",
    recordings.length
      ? `- Recordings: ${recordings.length} WebM file${recordings.length === 1 ? "" : "s"}${formatEvidenceDetails(recordings)}`
      : ""
  ]
    .filter(Boolean)
    .join("\n");

  return `# Bug Report: ${title}

## Summary
Issue captured on ${url}.

## Environment
- URL: ${url}
- Browser: ${metadata?.userAgent ?? "Unknown"}
- Viewport: ${metadata ? `${metadata.viewport.width}x${metadata.viewport.height} @ ${metadata.viewport.devicePixelRatio}x` : "Unknown"}
- Screen: ${metadata ? `${metadata.screen.width}x${metadata.screen.height}` : "Unknown"}
- Captured at: ${normalized.createdAt}
- Capture mode: ${normalized.mode}

## Reproduction Steps
${steps.trim() || "No steps provided."}

## Observed Behavior
${notes.trim() || "No notes provided."}

## Console Errors
${errorLines}

## Network Requests
${networkLines}

## Attachments
${attachments || "- No binary attachments."}
`;
}

function formatNetworkRequests(session: CaptureSession): string {
  if (!session.networkRequests.length) return "- No network requests captured.";

  return coalesceNetworkRequests(session.networkRequests)
    .sort((first, second) => Number(isNetworkFailure(second)) - Number(isNetworkFailure(first)))
    .slice(0, 20)
    .map((entry) => {
      const status = entry.error
        ? `error: ${entry.error}`
        : typeof entry.status === "number"
          ? `${entry.status}${entry.statusText ? ` ${entry.statusText}` : ""}`
          : "no status";
      const duration =
        typeof entry.durationMs === "number" ? ` in ${entry.durationMs}ms` : "";
      const request = entry.requestBodyPreview
        ? `\n  request: ${singleLine(entry.requestBodyPreview)}`
        : "";
      const response = entry.responseBodyPreview
        ? `\n  response: ${singleLine(entry.responseBodyPreview)}`
        : entry.responseBodyUnavailableReason
          ? `\n  response: unavailable (${singleLine(entry.responseBodyUnavailableReason)})`
        : "";
      return `- [${entry.timestamp}] ${entry.method} ${entry.url} -> ${status}${duration}${request}${response}`;
    })
    .join("\n");
}

function coalesceNetworkRequests(
  entries: CaptureSession["networkRequests"]
): CaptureSession["networkRequests"] {
  const merged: CaptureSession["networkRequests"] = [];
  for (const entry of entries) {
    const index = merged.findIndex((candidate) => isDuplicateNetworkEntry(candidate, entry));
    if (index === -1) {
      merged.push(entry);
      continue;
    }

    merged[index] = preferNetworkEntry(merged[index], entry);
  }
  return merged;
}

function isDuplicateNetworkEntry(
  first: CaptureSession["networkRequests"][number],
  second: CaptureSession["networkRequests"][number]
): boolean {
  if (first.requestId && first.requestId === second.requestId) return true;
  if (first.method !== second.method || first.url !== second.url) return false;
  const firstTime = new Date(first.timestamp).getTime();
  const secondTime = new Date(second.timestamp).getTime();
  return (
    !Number.isNaN(firstTime) &&
    !Number.isNaN(secondTime) &&
    Math.abs(firstTime - secondTime) < 5000
  );
}

function preferNetworkEntry(
  first: CaptureSession["networkRequests"][number],
  second: CaptureSession["networkRequests"][number]
): CaptureSession["networkRequests"][number] {
  const firstScore = networkEntryScore(first);
  const secondScore = networkEntryScore(second);
  const primary = secondScore > firstScore ? second : first;
  const secondary = primary === first ? second : first;
  return {
    ...secondary,
    ...primary,
    requestHeaders: {
      ...(secondary.requestHeaders ?? {}),
      ...(primary.requestHeaders ?? {})
    },
    responseHeaders: {
      ...(secondary.responseHeaders ?? {}),
      ...(primary.responseHeaders ?? {})
    },
    requestBodyPreview: primary.requestBodyPreview ?? secondary.requestBodyPreview,
    responseBodyPreview: primary.responseBodyPreview ?? secondary.responseBodyPreview,
    responseBodyUnavailableReason:
      primary.responseBodyUnavailableReason ?? secondary.responseBodyUnavailableReason,
    responseContentType: primary.responseContentType ?? secondary.responseContentType,
    error: primary.error ?? secondary.error
  };
}

function networkEntryScore(entry: CaptureSession["networkRequests"][number]): number {
  return (
    (entry.responseBodyPreview ? 8 : 0) +
    (entry.requestBodyPreview ? 4 : 0) +
    (entry.source === "page" ? 2 : 0) +
    (entry.responseHeaders ? 1 : 0)
  );
}

function isNetworkFailure(entry: CaptureSession["networkRequests"][number]): boolean {
  return Boolean(entry.error || entry.ok === false || (entry.status && entry.status >= 400));
}

function singleLine(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 500)}...` : compact;
}

function formatEvidenceDetails(
  items: Array<{ captureArea?: string; editedAt?: string }>
): string {
  const selected = items.filter((item) => item.captureArea === "region").length;
  const edited = items.filter((item) => item.editedAt).length;
  const details = [
    selected ? `${selected} selected area` : "",
    edited ? `${edited} edited` : ""
  ].filter(Boolean);
  return details.length ? ` (${details.join(", ")})` : "";
}

export async function generateAiReport(
  apiKey: string,
  model: string,
  input: ReportInput
): Promise<string> {
  const fallback = buildTemplateReport(input);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Turn this captured browser bug context into a concise, founder/product-team friendly Markdown bug report. Start with one specific H1 title in the format "# Bug: <failing user action or symptom>" and avoid generic page titles. Keep the same facts, infer severity only if justified, and include actionable reproduction details.\n\n${fallback}`
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed with ${response.status}`);
  }

  const data = await response.json();
  const text = extractResponseText(data);
  if (!text) throw new Error("OpenAI response did not include text output.");
  return text;
}

function extractResponseText(data: unknown): string {
  const outputText = (data as { output_text?: string }).output_text;
  if (outputText) return outputText;

  const output = (data as { output?: Array<{ content?: Array<unknown> }> }).output;
  return (
    output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => {
        const textContent = content as { text?: string; type?: string };
        return textContent.type === "output_text" || textContent.text
          ? textContent.text ?? ""
          : "";
      })
      .join("")
      .trim() ?? ""
  );
}
