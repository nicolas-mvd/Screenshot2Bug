// src/shared/github.ts
var GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
var GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
var GITHUB_API_URL = "https://api.github.com";
var GITHUB_SCOPES = "repo";
var GITHUB_ISSUE_BODY_LIMIT = 65536;
var GITHUB_ISSUE_BODY_TARGET = 64e3;
var RAW_CONSOLE_JSON_LIMIT = 8e3;
var RAW_NETWORK_JSON_LIMIT = 24e3;
async function startGitHubDeviceFlow(clientId) {
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
async function pollGitHubDeviceToken({
  clientId,
  deviceCode
}) {
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
    const error = new Error(data.error_description || data.error);
    error.code = data.error;
    throw error;
  }
  return data;
}
async function waitForGitHubDeviceToken({
  clientId,
  deviceCode,
  interval = 5,
  expiresIn = 900
}) {
  const startedAt = Date.now();
  let delay = interval * 1e3;
  while (Date.now() - startedAt < expiresIn * 1e3) {
    await sleep(delay);
    try {
      return await pollGitHubDeviceToken({ clientId, deviceCode });
    } catch (error) {
      const code = error.code;
      if (code === "authorization_pending") continue;
      if (code === "slow_down") {
        delay += 5e3;
        continue;
      }
      throw error;
    }
  }
  throw new Error("GitHub authorization timed out.");
}
async function getGitHubUser(token) {
  return githubFetch(token, "/user");
}
async function listGitHubRepositories(token) {
  const repos = [];
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
  return repos.filter((repo) => repo.permissions?.push || repo.permissions?.admin || repo.permissions?.maintain).map((repo) => ({
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    defaultBranch: repo.default_branch
  })).sort((a, b) => a.fullName.localeCompare(b.fullName));
}
async function createGitHubIssue(token, repo, issue) {
  try {
    return await createGitHubIssueRequest(token, repo, issue);
  } catch (error) {
    if (issue.labels.length && isLabelValidationError(error)) {
      return createGitHubIssueRequest(token, repo, { ...issue, labels: [] });
    }
    throw error;
  }
}
function buildGitHubIssue({
  session,
  report,
  labels = ["bug"],
  screenshotLinks = []
}) {
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
function buildIssueTitle(session, report) {
  const reportTitle = extractReportTitle(report);
  if (reportTitle) return normalizeIssueTitle(reportTitle);
  const pageTitle = session.metadata?.title?.trim();
  const url = session.metadata?.url?.trim();
  if (pageTitle) return normalizeIssueTitle(pageTitle);
  if (url) return normalizeIssueTitle(url);
  return `Bug report ${session.id.slice(0, 8)}`;
}
function extractReportTitle(report) {
  const lines = report.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const bugLine = lines.slice(0, 20).find((line) => /^#{0,6}\s*bug\s*:/i.test(line) && !/^#{0,6}\s*bug report\s*:/i.test(line));
  const heading = lines.find((line) => /^#{1,2}\s+\S/.test(line));
  const candidate = bugLine?.replace(/^#{1,6}\s+/, "") ?? heading?.replace(/^#{1,6}\s+/, "");
  return candidate?.replace(/^bug report\s*:\s*/i, "").trim();
}
function normalizeIssueTitle(title) {
  const normalized = title.replace(/\s+/g, " ").trim();
  const withPrefix = /^bug\s*:/i.test(normalized) ? normalized : `Bug: ${normalized}`;
  return withPrefix.slice(0, 256);
}
function formatRawConsole(entries) {
  if (!entries.length) return "_No raw console entries captured._";
  return fencedJson(entries, RAW_CONSOLE_JSON_LIMIT);
}
function formatRawNetwork(entries) {
  if (!entries.length) return "_No raw network entries captured._";
  return fencedJson(entries, RAW_NETWORK_JSON_LIMIT);
}
function formatScreenshotLinks(links) {
  if (!links.length) return "## Screenshots\n_No screenshots uploaded._";
  return `## Screenshots
${links.map((link) => `![${link.label}](${link.markdownUrl})`).join("\n\n")}`;
}
function createGitHubIssueRequest(token, repo, issue) {
  return githubFetch(token, `/repos/${repo.owner}/${repo.name}/issues`, {
    method: "POST",
    body: JSON.stringify(issue)
  });
}
function fencedJson(value, maxJsonChars) {
  const json = JSON.stringify(value, null, 2);
  if (!maxJsonChars || json.length <= maxJsonChars) {
    return `\`\`\`json
${json}
\`\`\``;
  }
  const omitted = json.length - maxJsonChars;
  return `\`\`\`json
${json.slice(0, maxJsonChars).trimEnd()}
... truncated ${omitted} characters; full evidence remains in the ZIP export ...
\`\`\``;
}
function fitGitHubIssueBody(body) {
  if (body.length <= GITHUB_ISSUE_BODY_TARGET) return body;
  const suffix = `

---

_Issue body truncated to fit GitHub's ${GITHUB_ISSUE_BODY_LIMIT} character limit. Full evidence remains in the ZIP export._`;
  return `${body.slice(0, GITHUB_ISSUE_BODY_TARGET - suffix.length).trimEnd()}${suffix}`;
}
async function githubFetch(token, path, init = {}) {
  const response = await fetch(`${GITHUB_API_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers || {}
    }
  });
  return parseGitHubResponse(response);
}
async function parseGitHubResponse(response) {
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = formatGitHubErrorMessage(data, response.status);
    const error = new Error(message);
    error.status = response.status;
    error.errors = Array.isArray(data.errors) ? data.errors : void 0;
    throw error;
  }
  return data;
}
function formatGitHubErrorMessage(data, status) {
  const message = data?.message || `GitHub request failed with ${status}`;
  const details = Array.isArray(data?.errors) ? data.errors.map(formatGitHubErrorDetail).filter(Boolean) : [];
  return details.length ? `${message}: ${details.join("; ")}` : message;
}
function formatGitHubErrorDetail(detail) {
  if (typeof detail === "string") return detail;
  if (!detail || typeof detail !== "object") return "";
  return [detail.resource, detail.field, detail.code, detail.message].filter(Boolean).join(" ");
}
function isLabelValidationError(error) {
  const typed = error;
  if (typed.status !== 422) return false;
  const message = typed.message.toLowerCase();
  if (message.includes("label")) return true;
  return (typed.errors ?? []).some((detail) => {
    if (!detail || typeof detail !== "object") return false;
    const values = Object.values(detail).map(String).join(" ").toLowerCase();
    return values.includes("label");
  });
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export {
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_API_URL,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_SCOPES,
  buildGitHubIssue,
  createGitHubIssue,
  getGitHubUser,
  listGitHubRepositories,
  pollGitHubDeviceToken,
  startGitHubDeviceFlow,
  waitForGitHubDeviceToken
};
