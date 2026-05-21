// src/shared/types.ts
var STORAGE_KEYS = {
  latestSessionId: "latestSessionId",
  settings: "settings",
  sessions: "sessions",
  consolePrefix: "console:"
};
var DEFAULT_MODEL = "gpt-5";

// src/shared/storage.ts
async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return result[STORAGE_KEYS.settings] ?? {};
}
async function saveSettings(settings2) {
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings2 });
}

// src/shared/github.ts
var GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
var GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
var GITHUB_API_URL = "https://api.github.com";
var GITHUB_SCOPES = "repo";
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
  const repos2 = [];
  let page = 1;
  while (page <= 5) {
    const batch = await githubFetch(
      token,
      `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`
    );
    repos2.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return repos2.filter((repo) => repo.permissions?.push || repo.permissions?.admin || repo.permissions?.maintain).map((repo) => ({
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private
  })).sort((a, b) => a.fullName.localeCompare(b.fullName));
}
async function githubFetch(token, path, init2 = {}) {
  const response = await fetch(`${GITHUB_API_URL}${path}`, {
    ...init2,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init2.headers || {}
    }
  });
  return parseGitHubResponse(response);
}
async function parseGitHubResponse(response) {
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message2 = data.message || `GitHub request failed with ${response.status}`;
    throw new Error(message2);
  }
  return data;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/options/main.ts
var app = document.querySelector("#app");
if (!app) throw new Error("Missing app root.");
var root = app;
var settings = {};
var message = "";
var busy = false;
var repos = [];
void init();
async function init() {
  settings = await getSettings();
  if (settings.githubAccessToken) {
    await refreshRepos(false);
  }
  render();
}
function render() {
  root.innerHTML = `
    <section class="shell options-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Screenshot2Bug</p>
          <h1>Settings</h1>
        </div>
      </header>

      ${message ? `<p class="notice">${escapeHtml(message)}</p>` : ""}

      <section class="panel">
        <h2>AI reports</h2>
        <label class="field">
          <span>OpenAI API key</span>
          <input id="apiKeyInput" type="password" value="${escapeHtml(settings.openaiApiKey ?? "")}" placeholder="sk-..." />
        </label>

        <label class="field">
          <span>OpenAI model</span>
          <input id="modelInput" type="text" value="${escapeHtml(settings.openaiModel ?? DEFAULT_MODEL)}" />
        </label>

        <button class="primary" id="saveAiButton">Save AI settings</button>
      </section>

      <section class="panel">
        <h2>GitHub issues</h2>
        <label class="field">
          <span>GitHub OAuth Client ID</span>
          <input id="githubClientIdInput" type="text" value="${escapeHtml(settings.githubClientId ?? "")}" placeholder="Public OAuth app client ID" />
        </label>

        <label class="field">
          <span>Default labels</span>
          <input id="githubLabelsInput" type="text" value="${escapeHtml((settings.githubDefaultLabels ?? ["bug"]).join(", "))}" placeholder="bug" />
        </label>

        <div class="actions">
          <button class="primary" id="connectGitHubButton" ${busy ? "disabled" : ""}>${settings.githubAccessToken ? "Reconnect GitHub" : "Connect GitHub"}</button>
          <button id="disconnectGitHubButton" ${!settings.githubAccessToken || busy ? "disabled" : ""}>Disconnect</button>
        </div>

        ${renderGitHubStatus()}
      </section>

      <section class="panel">
        <h2>Shortcuts</h2>
        <p class="muted">Defaults are Option+Shift+S for full-tab screenshots, Option+Shift+A for selected-area screenshots, Option+Shift+V for full-tab videos, and Option+Shift+R for selected-area videos. Chrome lets you remap them from the extensions shortcuts page.</p>
        <button id="shortcutsButton">Open Chrome shortcuts</button>
      </section>
    </section>
  `;
  document.querySelector("#saveAiButton")?.addEventListener("click", () => void saveAi());
  document.querySelector("#connectGitHubButton")?.addEventListener("click", () => void connectGitHub());
  document.querySelector("#disconnectGitHubButton")?.addEventListener("click", () => void disconnectGitHub());
  document.querySelector("#repoSelect")?.addEventListener("change", (event) => {
    void selectRepo(event.target.value);
  });
  document.querySelector("#refreshReposButton")?.addEventListener("click", () => void refreshRepos(true));
  document.querySelector("#shortcutsButton")?.addEventListener("click", () => {
    void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
}
function renderGitHubStatus() {
  if (!settings.githubAccessToken) {
    return `<p class="muted">Connect GitHub to create issues from bug reports. The token is stored locally in Chrome extension storage.</p>`;
  }
  const repoOptions = repos.map(
    (repo) => `<option value="${escapeHtml(repo.fullName)}" ${repo.fullName === settings.githubSelectedRepo?.fullName ? "selected" : ""}>${escapeHtml(repo.fullName)}${repo.private ? " (private)" : ""}</option>`
  ).join("");
  return `
    <p class="muted">Connected as <strong>${escapeHtml(settings.githubUserLogin ?? "GitHub user")}</strong>.</p>
    <label class="field">
      <span>Issue destination repository</span>
      <select id="repoSelect">
        <option value="">Select a repository</option>
        ${repoOptions}
      </select>
    </label>
    <button id="refreshReposButton" ${busy ? "disabled" : ""}>Refresh repositories</button>
  `;
}
async function saveAi() {
  const openaiApiKey = document.querySelector("#apiKeyInput")?.value.trim();
  const openaiModel = document.querySelector("#modelInput")?.value.trim() || DEFAULT_MODEL;
  settings = { ...settings, openaiApiKey, openaiModel };
  await saveSettings(settings);
  message = "AI settings saved.";
  render();
}
async function connectGitHub() {
  const githubClientId = document.querySelector("#githubClientIdInput")?.value.trim();
  const githubDefaultLabels = parseLabels(
    document.querySelector("#githubLabelsInput")?.value ?? "bug"
  );
  if (!githubClientId) {
    message = "Add a GitHub OAuth Client ID first.";
    render();
    return;
  }
  busy = true;
  message = "Starting GitHub authorization...";
  render();
  try {
    const flow = await startGitHubDeviceFlow(githubClientId);
    message = `Open ${flow.verification_uri} and enter code ${flow.user_code}. Waiting for authorization...`;
    render();
    await chrome.tabs.create({ url: flow.verification_uri });
    const token = await waitForGitHubDeviceToken({
      clientId: githubClientId,
      deviceCode: flow.device_code,
      interval: flow.interval,
      expiresIn: flow.expires_in
    });
    const user = await getGitHubUser(token.access_token);
    settings = {
      ...settings,
      githubClientId,
      githubDefaultLabels,
      githubAccessToken: token.access_token,
      githubUserLogin: user.login
    };
    await saveSettings(settings);
    await refreshRepos(false);
    message = `Connected to GitHub as ${user.login}.`;
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  } finally {
    busy = false;
    render();
  }
}
async function refreshRepos(showMessage) {
  if (!settings.githubAccessToken) return;
  try {
    repos = await listGitHubRepositories(settings.githubAccessToken);
    if (settings.githubSelectedRepo && !repos.some((repo) => repo.fullName === settings.githubSelectedRepo?.fullName)) {
      settings = { ...settings, githubSelectedRepo: void 0 };
      await saveSettings(settings);
    }
    if (showMessage) message = "Repositories refreshed.";
  } catch (error) {
    repos = [];
    message = error instanceof Error ? error.message : String(error);
  }
  render();
}
async function selectRepo(fullName) {
  const selected = repos.find((repo) => repo.fullName === fullName);
  settings = { ...settings, githubSelectedRepo: selected };
  await saveSettings(settings);
  message = selected ? `GitHub issues will be created in ${selected.fullName}.` : "Repository selection cleared.";
  render();
}
async function disconnectGitHub() {
  settings = {
    ...settings,
    githubAccessToken: void 0,
    githubUserLogin: void 0,
    githubSelectedRepo: void 0
  };
  repos = [];
  await saveSettings(settings);
  message = "GitHub disconnected.";
  render();
}
function parseLabels(value) {
  const labels = value.split(",").map((label) => label.trim()).filter(Boolean);
  return labels.length ? labels : ["bug"];
}
function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
