// src/shared/types.ts
var STORAGE_KEYS = {
  latestSessionId: "latestSessionId",
  settings: "settings",
  sessions: "sessions",
  consolePrefix: "console:",
  networkPrefix: "network:"
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
    private: repo.private,
    defaultBranch: repo.default_branch
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
    const message2 = formatGitHubErrorMessage(data, response.status);
    const error = new Error(message2);
    error.status = response.status;
    error.errors = Array.isArray(data.errors) ? data.errors : void 0;
    throw error;
  }
  return data;
}
function formatGitHubErrorMessage(data, status) {
  const message2 = data?.message || `GitHub request failed with ${status}`;
  const details = Array.isArray(data?.errors) ? data.errors.map(formatGitHubErrorDetail).filter(Boolean) : [];
  return details.length ? `${message2}: ${details.join("; ")}` : message2;
}
function formatGitHubErrorDetail(detail) {
  if (typeof detail === "string") return detail;
  if (!detail || typeof detail !== "object") return "";
  return [detail.resource, detail.field, detail.code, detail.message].filter(Boolean).join(" ");
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
var apiKeyVisible = false;
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
      <header class="settings-nav">
        <button class="brand-lockup" id="captureNavButton" title="Open capture">
          <span class="nav-icon" aria-hidden="true">\u2637</span>
          <span>BugReporter</span>
        </button>
        <button class="nav-gear" id="settingsNavButton" title="Settings" aria-label="Settings">\u2699</button>
      </header>

      <main class="settings-main">
        <div class="page-heading">
          <p class="eyebrow">Screenshot2Bug</p>
          <h1>Settings</h1>
        </div>

        ${message ? `<p class="notice">${escapeHtml(message)}</p>` : ""}

        <section class="panel settings-card">
          <div class="section-title">
            <span class="section-icon" aria-hidden="true">\u2726</span>
            <h2>AI reports</h2>
          </div>
          <label class="field">
            <span>OpenAI API key</span>
            <span class="input-shell">
              <input id="apiKeyInput" type="${apiKeyVisible ? "text" : "password"}" value="${escapeHtml(settings.openaiApiKey ?? "")}" placeholder="sk-..." />
              <button class="inline-icon-button" id="toggleApiKeyButton" type="button" title="${apiKeyVisible ? "Hide API key" : "Show API key"}" aria-label="${apiKeyVisible ? "Hide API key" : "Show API key"}">${apiKeyVisible ? "\u25CC" : "\u2301"}</button>
            </span>
          </label>

          <label class="field">
            <span>OpenAI model</span>
            <input id="modelInput" type="text" value="${escapeHtml(settings.openaiModel ?? DEFAULT_MODEL)}" />
          </label>

          <button class="primary compact-action" id="saveAiButton">Save AI settings</button>
        </section>

        <section class="panel settings-card">
          <div class="section-title">
            <span class="section-icon" aria-hidden="true">\u2318</span>
            <h2>GitHub issues</h2>
          </div>
          <label class="field">
            <span>GitHub OAuth Client ID</span>
            <input id="githubClientIdInput" type="text" value="${escapeHtml(settings.githubClientId ?? "")}" placeholder="Public OAuth app client ID" />
          </label>

          <label class="field">
            <span>Default labels</span>
            <span class="label-input">
              ${(settings.githubDefaultLabels ?? ["bug"]).map((label) => `<span class="label-chip">${escapeHtml(label)} <span aria-hidden="true">\xD7</span></span>`).join("")}
              <input id="githubLabelsInput" type="text" value="" placeholder="Add label..." />
            </span>
          </label>

          <div class="actions">
            <button class="primary" id="connectGitHubButton" ${busy ? "disabled" : ""}>${settings.githubAccessToken ? "Reconnect GitHub" : "Connect GitHub"}</button>
            <button id="disconnectGitHubButton" ${!settings.githubAccessToken || busy ? "disabled" : ""}>Disconnect</button>
          </div>

          ${renderGitHubStatus()}
        </section>

        <section class="panel settings-card">
          <div class="section-title">
            <span class="section-icon" aria-hidden="true">\u2601</span>
            <h2>Image uploads</h2>
          </div>
          <label class="field">
            <span>Cloudinary cloud name</span>
            <input id="cloudinaryCloudNameInput" type="text" value="${escapeHtml(settings.cloudinaryCloudName ?? "")}" placeholder="your-cloud-name" />
          </label>

          <label class="field">
            <span>Unsigned upload preset</span>
            <input id="cloudinaryUploadPresetInput" type="text" value="${escapeHtml(settings.cloudinaryUploadPreset ?? "")}" placeholder="screenshot2bug" />
          </label>

          <div class="hint-panel">
            <p class="muted">Screenshots upload to Cloudinary before GitHub issue creation. Use an unsigned preset with image uploads enabled.</p>
          </div>
          <button class="primary compact-action" id="saveCloudinaryButton">Save image upload settings</button>
        </section>

        <section class="panel settings-card">
          <div class="section-title">
            <span class="section-icon" aria-hidden="true">\u2328</span>
            <h2>Shortcuts</h2>
          </div>
          <div class="shortcut-grid">
            ${renderShortcut("Full screenshot", "Opt+Shift+S")}
            ${renderShortcut("Area screenshot", "Opt+Shift+A")}
            ${renderShortcut("Full video", "Opt+Shift+V")}
            ${renderShortcut("Area video", "Opt+Shift+R")}
          </div>
          <p class="muted">Chrome lets you remap these shortcuts from the extensions shortcuts page.</p>
          <button class="compact-action" id="shortcutsButton">Open Chrome shortcuts</button>
        </section>

        <section class="resource-grid">
          <article class="docs-card">
            <div>
              <h2>Documentation</h2>
              <p>Learn how to automate your bug reporting workflow.</p>
            </div>
          </article>
          <article class="help-card">
            <span aria-hidden="true">\u25B1</span>
            <strong>Need Help?</strong>
            <p>Join our Discord community for support.</p>
          </article>
        </section>
      </main>

      <footer class="bottom-nav" aria-label="Extension navigation">
        <button id="bottomCaptureButton">
          <span aria-hidden="true">\u2317</span>
          <small>Capture</small>
        </button>
        <button id="bottomReportsButton">
          <span aria-hidden="true">\u25A6</span>
          <small>Reports</small>
        </button>
        <button class="active" id="bottomSettingsButton">
          <span aria-hidden="true">\u2699</span>
          <small>Settings</small>
        </button>
      </footer>
    </section>
  `;
  document.querySelector("#saveAiButton")?.addEventListener("click", () => void saveAi());
  document.querySelector("#toggleApiKeyButton")?.addEventListener("click", () => {
    apiKeyVisible = !apiKeyVisible;
    render();
  });
  document.querySelector("#saveCloudinaryButton")?.addEventListener("click", () => void saveCloudinary());
  document.querySelector("#connectGitHubButton")?.addEventListener("click", () => void connectGitHub());
  document.querySelector("#disconnectGitHubButton")?.addEventListener("click", () => void disconnectGitHub());
  document.querySelector("#repoSelect")?.addEventListener("change", (event) => {
    void selectRepo(event.target.value);
  });
  document.querySelector("#refreshReposButton")?.addEventListener("click", () => void refreshRepos(true));
  document.querySelector("#shortcutsButton")?.addEventListener("click", () => {
    void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
  document.querySelector("#captureNavButton")?.addEventListener("click", () => void openPopupPage());
  document.querySelector("#bottomCaptureButton")?.addEventListener("click", () => void openPopupPage());
  document.querySelector("#bottomReportsButton")?.addEventListener("click", () => void openPopupPage());
}
function renderGitHubStatus() {
  if (!settings.githubAccessToken) {
    return `<p class="muted">Connect GitHub to create issues from bug reports. The token is stored locally in Chrome extension storage.</p>`;
  }
  const repoOptions = repos.map(
    (repo) => `<option value="${escapeHtml(repo.fullName)}" ${repo.fullName === settings.githubSelectedRepo?.fullName ? "selected" : ""}>${escapeHtml(repo.fullName)}${repo.private ? " (private)" : ""}</option>`
  ).join("");
  return `
    <p class="connected-row"><span class="status-dot" aria-hidden="true"></span>Connected as <strong>${escapeHtml(settings.githubUserLogin ?? "GitHub user")}</strong></p>
    <label class="field">
      <span>Issue destination repository</span>
      <select id="repoSelect">
        <option value="">Select a repository</option>
        ${repoOptions}
      </select>
    </label>
    <button class="compact-action" id="refreshReposButton" ${busy ? "disabled" : ""}>Refresh repositories</button>
  `;
}
function renderShortcut(label, shortcut) {
  return `
    <article class="shortcut-card">
      <span>${escapeHtml(label)}</span>
      <code>${escapeHtml(shortcut)}</code>
    </article>
  `;
}
async function openPopupPage() {
  if (chrome.action?.openPopup) {
    await chrome.action.openPopup();
    return;
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
}
async function saveAi() {
  const openaiApiKey = document.querySelector("#apiKeyInput")?.value.trim();
  const openaiModel = document.querySelector("#modelInput")?.value.trim() || DEFAULT_MODEL;
  settings = { ...settings, openaiApiKey, openaiModel };
  await saveSettings(settings);
  message = "AI settings saved.";
  render();
}
async function saveCloudinary() {
  const cloudinaryCloudName = document.querySelector("#cloudinaryCloudNameInput")?.value.trim();
  const cloudinaryUploadPreset = document.querySelector("#cloudinaryUploadPresetInput")?.value.trim();
  settings = { ...settings, cloudinaryCloudName, cloudinaryUploadPreset };
  await saveSettings(settings);
  message = "Image upload settings saved.";
  render();
}
async function connectGitHub() {
  const githubClientId = document.querySelector("#githubClientIdInput")?.value.trim();
  const labelInput = document.querySelector("#githubLabelsInput")?.value.trim();
  const githubDefaultLabels = labelInput ? parseLabels(labelInput) : settings.githubDefaultLabels ?? ["bug"];
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
    if (settings.githubSelectedRepo) {
      const selected = repos.find((repo) => repo.fullName === settings.githubSelectedRepo?.fullName);
      if (selected) {
        settings = { ...settings, githubSelectedRepo: selected };
      } else {
        settings = { ...settings, githubSelectedRepo: void 0 };
      }
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
