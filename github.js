export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_API_URL = "https://api.github.com";
export const GITHUB_SCOPES = "repo";

export async function startGitHubDeviceFlow(clientId) {
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

export async function pollGitHubDeviceToken({ clientId, deviceCode }) {
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

export async function waitForGitHubDeviceToken({ clientId, deviceCode, interval = 5, expiresIn = 900 }) {
  const startedAt = Date.now();
  let delay = interval * 1000;

  while (Date.now() - startedAt < expiresIn * 1000) {
    await sleep(delay);
    try {
      return await pollGitHubDeviceToken({ clientId, deviceCode });
    } catch (error) {
      if (error.code === "authorization_pending") continue;
      if (error.code === "slow_down") {
        delay += 5000;
        continue;
      }
      throw error;
    }
  }

  throw new Error("GitHub authorization timed out.");
}

export async function getGitHubUser(token) {
  return githubFetch(token, "/user");
}

export async function listGitHubRepositories(token) {
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
  return repos
    .filter((repo) => repo.permissions?.push || repo.permissions?.admin || repo.permissions?.maintain)
    .map((repo) => ({
      owner: repo.owner.login,
      name: repo.name,
      fullName: repo.full_name,
      private: repo.private
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function createGitHubIssue(token, repo, issue) {
  return githubFetch(token, `/repos/${repo.owner}/${repo.name}/issues`, {
    method: "POST",
    body: JSON.stringify(issue)
  });
}

export function buildGitHubIssue({ session, report, labels = ["bug"] }) {
  const title = buildIssueTitle(session, report);
  const body = `${report.trim()}

---

## RAW Console
${formatRawConsole(session.consoleErrors ?? [])}

## RAW Network
${formatRawNetwork(session.networkRequests ?? [])}

---

Created with Screenshot2Bug.

Note: screenshots and recordings are kept in the local ZIP export for this report and are not uploaded to GitHub in this version.`;
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
  const lines = report
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const bugLine = lines
    .slice(0, 20)
    .find((line) => /^#{0,6}\s*bug\s*:/i.test(line) && !/^#{0,6}\s*bug report\s*:/i.test(line));
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
  return fencedJson(entries);
}

function formatRawNetwork(entries) {
  if (!entries.length) return "_No raw network entries captured._";
  return fencedJson(entries);
}

function fencedJson(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

async function githubFetch(token, path, init = {}) {
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

async function parseGitHubResponse(response) {
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data.message || `GitHub request failed with ${response.status}`;
    throw new Error(message);
  }
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
