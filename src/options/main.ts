import "../shared/styles.css";
import { getSettings, saveSettings } from "../shared/storage";
import { DEFAULT_MODEL } from "../shared/types";
import type { Settings } from "../shared/types";
import {
  getGitHubUser,
  listGitHubRepositories,
  startGitHubDeviceFlow,
  waitForGitHubDeviceToken
} from "../shared/github";
import type { GitHubRepoSelection } from "../shared/github";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing app root.");
const root = app;

let settings: Settings = {};
let message = "";
let busy = false;
let repos: GitHubRepoSelection[] = [];
let apiKeyVisible = false;

void init();

async function init(): Promise<void> {
  settings = await getSettings();
  if (settings.githubAccessToken) {
    await refreshRepos(false);
  }
  render();
}

function render(): void {
  root.innerHTML = `
    <section class="shell options-shell">
      <header class="settings-nav">
        <button class="brand-lockup" id="captureNavButton" title="Open capture">
          <span class="nav-icon" aria-hidden="true">☷</span>
          <span>BugReporter</span>
        </button>
      </header>

      <main class="settings-main">
        <div class="page-heading">
          <h1>Settings</h1>
        </div>

        ${message ? `<p class="notice">${escapeHtml(message)}</p>` : ""}

        <section class="panel settings-card">
          <div class="section-title">
            <h2>AI reports</h2>
          </div>
          <label class="field">
            <span>OpenAI API key</span>
            <span class="input-shell">
              <input id="apiKeyInput" type="${apiKeyVisible ? "text" : "password"}" value="${escapeHtml(settings.openaiApiKey ?? "")}" placeholder="sk-..." />
              <button class="inline-icon-button" id="toggleApiKeyButton" type="button" title="${apiKeyVisible ? "Hide API key" : "Show API key"}" aria-label="${apiKeyVisible ? "Hide API key" : "Show API key"}">${apiKeyVisible ? "◌" : "⌁"}</button>
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
            <h2>GitHub issues</h2>
          </div>
          <label class="field">
            <span>GitHub OAuth Client ID</span>
            <input id="githubClientIdInput" type="text" value="${escapeHtml(settings.githubClientId ?? "")}" placeholder="Public OAuth app client ID" />
          </label>

          <label class="field">
            <span>Default labels</span>
            <span class="label-input">
              ${(settings.githubDefaultLabels ?? ["bug"])
                .map((label) => `<span class="label-chip">${escapeHtml(label)} <span aria-hidden="true">×</span></span>`)
                .join("")}
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
            <span aria-hidden="true">▱</span>
            <strong>Need Help?</strong>
            <p>Join our Discord community for support.</p>
          </article>
        </section>
      </main>

      <footer class="bottom-nav" aria-label="Extension navigation">
        <button id="bottomCaptureButton">
          <span aria-hidden="true">⌗</span>
          <small>Capture</small>
        </button>
        <button id="bottomReportsButton">
          <span aria-hidden="true">▦</span>
          <small>Reports</small>
        </button>
        <button class="active" id="bottomSettingsButton">
          <span aria-hidden="true">⚙</span>
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
  document.querySelector<HTMLSelectElement>("#repoSelect")?.addEventListener("change", (event) => {
    void selectRepo((event.target as HTMLSelectElement).value);
  });
  document.querySelector("#refreshReposButton")?.addEventListener("click", () => void refreshRepos(true));
  document.querySelector("#shortcutsButton")?.addEventListener("click", () => {
    void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
  document.querySelector("#captureNavButton")?.addEventListener("click", () => void openPopupPage());
  document.querySelector("#bottomCaptureButton")?.addEventListener("click", () => void openPopupPage());
  document.querySelector("#bottomReportsButton")?.addEventListener("click", () => void openPopupPage());
}

function renderGitHubStatus(): string {
  if (!settings.githubAccessToken) {
    return `<p class="muted">Connect GitHub to create issues from bug reports. The token is stored locally in Chrome extension storage.</p>`;
  }

  const repoOptions = repos
    .map(
      (repo) =>
        `<option value="${escapeHtml(repo.fullName)}" ${repo.fullName === settings.githubSelectedRepo?.fullName ? "selected" : ""}>${escapeHtml(repo.fullName)}${repo.private ? " (private)" : ""}</option>`
    )
    .join("");

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

function renderShortcut(label: string, shortcut: string): string {
  return `
    <article class="shortcut-card">
      <span>${escapeHtml(label)}</span>
      <code>${escapeHtml(shortcut)}</code>
    </article>
  `;
}

async function openPopupPage(): Promise<void> {
  if (chrome.action?.openPopup) {
    await chrome.action.openPopup();
    return;
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
}

async function saveAi(): Promise<void> {
  const openaiApiKey = document.querySelector<HTMLInputElement>("#apiKeyInput")?.value.trim();
  const openaiModel = document.querySelector<HTMLInputElement>("#modelInput")?.value.trim() || DEFAULT_MODEL;
  settings = { ...settings, openaiApiKey, openaiModel };
  await saveSettings(settings);
  message = "AI settings saved.";
  render();
}

async function saveCloudinary(): Promise<void> {
  const cloudinaryCloudName = document
    .querySelector<HTMLInputElement>("#cloudinaryCloudNameInput")
    ?.value.trim();
  const cloudinaryUploadPreset = document
    .querySelector<HTMLInputElement>("#cloudinaryUploadPresetInput")
    ?.value.trim();
  settings = { ...settings, cloudinaryCloudName, cloudinaryUploadPreset };
  await saveSettings(settings);
  message = "Image upload settings saved.";
  render();
}

async function connectGitHub(): Promise<void> {
  const githubClientId = document.querySelector<HTMLInputElement>("#githubClientIdInput")?.value.trim();
  const labelInput = document.querySelector<HTMLInputElement>("#githubLabelsInput")?.value.trim();
  const githubDefaultLabels = labelInput
    ? parseLabels(labelInput)
    : (settings.githubDefaultLabels ?? ["bug"]);
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

async function refreshRepos(showMessage: boolean): Promise<void> {
  if (!settings.githubAccessToken) return;
  try {
    repos = await listGitHubRepositories(settings.githubAccessToken);
    if (settings.githubSelectedRepo) {
      const selected = repos.find((repo) => repo.fullName === settings.githubSelectedRepo?.fullName);
      if (selected) {
        settings = { ...settings, githubSelectedRepo: selected };
      } else {
        settings = { ...settings, githubSelectedRepo: undefined };
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

async function selectRepo(fullName: string): Promise<void> {
  const selected = repos.find((repo) => repo.fullName === fullName);
  settings = { ...settings, githubSelectedRepo: selected };
  await saveSettings(settings);
  message = selected ? `GitHub issues will be created in ${selected.fullName}.` : "Repository selection cleared.";
  render();
}

async function disconnectGitHub(): Promise<void> {
  settings = {
    ...settings,
    githubAccessToken: undefined,
    githubUserLogin: undefined,
    githubSelectedRepo: undefined
  };
  repos = [];
  await saveSettings(settings);
  message = "GitHub disconnected.";
  render();
}

function parseLabels(value: string): string[] {
  const labels = value
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  return labels.length ? labels : ["bug"];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
