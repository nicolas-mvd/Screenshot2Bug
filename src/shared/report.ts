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

## Attachments
${attachments || "- No binary attachments."}
`;
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
              text: `Turn this captured browser bug context into a concise, founder/product-team friendly Markdown bug report. Keep the same facts, infer severity only if justified, and include actionable reproduction details.\n\n${fallback}`
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
