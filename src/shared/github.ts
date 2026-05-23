import type {
  CaptureSession,
  ConsoleEntry,
  NetworkEntry
} from "./types";

export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_API_URL = "https://api.github.com";
export const GITHUB_SCOPES = "repo";
const GITHUB_ISSUE_BODY_LIMIT = 65536;
const GITHUB_ISSUE_BODY_TARGET = 64000;
const RAW_CONSOLE_JSON_LIMIT = 8000;
const RAW_NETWORK_JSON_LIMIT = 24000;

export interface GitHubDeviceFlow {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

export interface GitHubRepoSelection {
  owner: string;
  name: string;
  fullName: string;
  private?: boolean;
  defaultBranch?: string;
}

export interface GitHubIssueInput {
  title: string;
  body: string;
  labels: string[];
}

export interface IssueScreenshotLink {
  screenshotId: string;
  label: string;
  markdownUrl: string;
  path: string;
}

export async function startGitHubDeviceFlow(clientId: string): Promise<GitHubDeviceFlow> {
  if (!clientId) throw new Error("GitHub OAuth Client ID is required.");
  const response = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: clientId,
      scope: GITHUB_SCOPES
    })
  });
  return parseGitHubResponse(response);
}

export async function pollGitHubDeviceToken({
  clientId,
  deviceCode
}: {
  clientId: string;
  deviceCode: string;
}): Promise<GitHubTokenResponse> {
  const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code"
    })
  });
  const data = await parseGitHubResponse(response);
  if (data.error) {
    const error = new Error(data.error_description || data.error) as Error & {
      code?: string;
    };
    error.code = data.error;
    throw error;
  }
  return data;
}

export async function waitForGitHubDeviceToken({
  clientId,
  deviceCode,
  interval = 5,
  expiresIn = 900
}: {
  clientId: string;
  deviceCode: string;
  interval?: number;
  expiresIn?: number;
}): Promise<GitHubTokenResponse> {
  const startedAt = Date.now();
  let delay = interval * 1000;

  while (Date.now() - startedAt < expiresIn * 1000) {
    await sleep(delay);
    try {
      return await pollGitHubDeviceToken({ clientId, deviceCode });
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      if (code === "authorization_pending") continue;
      if (code === "slow_down") {
        delay += 5000;
        continue;
      }
      throw error;
    }
  }

  throw new Error("GitHub authorization timed out.");
}

export async function getGitHubUser(token: string): Promise<{ login: string }> {
  return githubFetch(token, "/user");
}

export async function listGitHubRepositories(token: string): Promise<GitHubRepoSelection[]> {
  const repos: Array<Record<string, any>> = [];
  let page = 1;
  while (page <= 5) {
    const batch = await githubFetch(
      token,
      `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`
    );
    repos.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return repos
    .filter((repo) => repo.permissions?.push || repo.permissions?.admin || repo.permissions?.maintain)
    .map((repo) => ({
      owner: repo.owner.login,
      name: repo.name,
      fullName: repo.full_name,
      private: repo.private,
      defaultBranch: repo.default_branch
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function createGitHubIssue(
  token: string,
  repo: GitHubRepoSelection,
  issue: GitHubIssueInput
): Promise<{ html_url: string; number: number }> {
  try {
    return await createGitHubIssueRequest(token, repo, issue);
  } catch (error) {
    if (issue.labels.length && isLabelValidationError(error)) {
      return createGitHubIssueRequest(token, repo, { ...issue, labels: [] });
    }
    throw error;
  }
}

export function buildGitHubIssue({
  session,
  report,
  labels = ["bug"],
  screenshotLinks = []
}: {
  session: Pick<CaptureSession, "id" | "metadata" | "consoleErrors" | "networkRequests">;
  report: string;
  labels?: string[];
  screenshotLinks?: IssueScreenshotLink[];
}): GitHubIssueInput {
  const title = buildIssueTitle(session, report);
  const screenshots = formatScreenshotLinks(screenshotLinks);
  const body = fitGitHubIssueBody(`${report.trim()}

${screenshots}

---

## RAW Console
${formatRawConsole(session.consoleErrors)}

## RAW Network
${formatRawNetwork(session.networkRequests)}

---

Created with Screenshot2Bug.

Note: uploaded screenshots are hosted on the configured image service. Recordings remain available through the local ZIP export.`);
  return {
    title,
    body,
    labels: labels.filter(Boolean)
  };
}

function buildIssueTitle(
  session: Pick<CaptureSession, "id" | "metadata">,
  report: string
): string {
  const reportTitle = extractReportTitle(report);
  if (reportTitle) return normalizeIssueTitle(reportTitle);
  const pageTitle = session.metadata?.title?.trim();
  const url = session.metadata?.url?.trim();
  if (pageTitle) return normalizeIssueTitle(pageTitle);
  if (url) return normalizeIssueTitle(url);
  return `Bug report ${session.id.slice(0, 8)}`;
}

function extractReportTitle(report: string): string | undefined {
  const lines = report
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const bugLine = lines
    .slice(0, 20)
    .find((line) => /^#{0,6}\s*bug\s*:/i.test(line) && !/^#{0,6}\s*bug report\s*:/i.test(line));
  const heading = lines.find((line) => /^#{1,2}\s+\S/.test(line));
  const candidate =
    bugLine?.replace(/^#{1,6}\s+/, "") ??
    heading?.replace(/^#{1,6}\s+/, "");
  return candidate?.replace(/^bug report\s*:\s*/i, "").trim();
}

function normalizeIssueTitle(title: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  const withPrefix = /^bug\s*:/i.test(normalized) ? normalized : `Bug: ${normalized}`;
  return withPrefix.slice(0, 256);
}

function formatRawConsole(entries: ConsoleEntry[]): string {
  if (!entries.length) return "_No raw console entries captured._";
  return fencedJson(entries, RAW_CONSOLE_JSON_LIMIT);
}

function formatRawNetwork(entries: NetworkEntry[]): string {
  if (!entries.length) return "_No raw network entries captured._";
  return fencedJson(entries, RAW_NETWORK_JSON_LIMIT);
}

function formatScreenshotLinks(links: IssueScreenshotLink[]): string {
  if (!links.length) return "## Screenshots\n_No screenshots uploaded._";
  return `## Screenshots\n${links
    .map((link) => `![${link.label}](${link.markdownUrl})`)
    .join("\n\n")}`;
}

function createGitHubIssueRequest(
  token: string,
  repo: GitHubRepoSelection,
  issue: GitHubIssueInput
): Promise<{ html_url: string; number: number }> {
  return githubFetch(token, `/repos/${repo.owner}/${repo.name}/issues`, {
    method: "POST",
    body: JSON.stringify(issue)
  });
}

function fencedJson(value: unknown, maxJsonChars?: number): string {
  const json = JSON.stringify(value, null, 2);
  if (!maxJsonChars || json.length <= maxJsonChars) {
    return `\`\`\`json\n${json}\n\`\`\``;
  }

  const omitted = json.length - maxJsonChars;
  return `\`\`\`json\n${json.slice(0, maxJsonChars).trimEnd()}
... truncated ${omitted} characters; full evidence remains in the ZIP export ...
\`\`\``;
}

function fitGitHubIssueBody(body: string): string {
  if (body.length <= GITHUB_ISSUE_BODY_TARGET) return body;

  const suffix = `

---

_Issue body truncated to fit GitHub's ${GITHUB_ISSUE_BODY_LIMIT} character limit. Full evidence remains in the ZIP export._`;
  return `${body.slice(0, GITHUB_ISSUE_BODY_TARGET - suffix.length).trimEnd()}${suffix}`;
}

async function githubFetch<T = any>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${GITHUB_API_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {})
    }
  });
  return parseGitHubResponse(response);
}

async function parseGitHubResponse<T = any>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = formatGitHubErrorMessage(data, response.status);
    const error = new Error(message) as Error & {
      status?: number;
      errors?: unknown[];
    };
    error.status = response.status;
    error.errors = Array.isArray(data.errors) ? data.errors : undefined;
    throw error;
  }
  return data;
}

function formatGitHubErrorMessage(data: any, status: number): string {
  const message = data?.message || `GitHub request failed with ${status}`;
  const details = Array.isArray(data?.errors)
    ? data.errors.map(formatGitHubErrorDetail).filter(Boolean)
    : [];
  return details.length ? `${message}: ${details.join("; ")}` : message;
}

function formatGitHubErrorDetail(detail: any): string {
  if (typeof detail === "string") return detail;
  if (!detail || typeof detail !== "object") return "";
  return [detail.resource, detail.field, detail.code, detail.message]
    .filter(Boolean)
    .join(" ");
}

function isLabelValidationError(error: unknown): boolean {
  const typed = error as Error & { status?: number; errors?: unknown[] };
  if (typed.status !== 422) return false;
  const message = typed.message.toLowerCase();
  if (message.includes("label")) return true;
  return (typed.errors ?? []).some((detail) => {
    if (!detail || typeof detail !== "object") return false;
    const values = Object.values(detail as Record<string, unknown>)
      .map(String)
      .join(" ")
      .toLowerCase();
    return values.includes("label");
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
