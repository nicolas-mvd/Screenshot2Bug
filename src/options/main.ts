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
  document.querySelector<HTMLSelectElement>("#repoSelect")?.addEventListener("change", (event) => {
    void selectRepo((event.target as HTMLSelectElement).value);
  });
  document.querySelector("#refreshReposButton")?.addEventListener("click", () => void refreshRepos(true));
  document.querySelector("#shortcutsButton")?.addEventListener("click", () => {
    void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
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

async function saveAi(): Promise<void> {
  const openaiApiKey = document.querySelector<HTMLInputElement>("#apiKeyInput")?.value.trim();
  const openaiModel = document.querySelector<HTMLInputElement>("#modelInput")?.value.trim() || DEFAULT_MODEL;
  settings = { ...settings, openaiApiKey, openaiModel };
  await saveSettings(settings);
  message = "AI settings saved.";
  render();
}

async function connectGitHub(): Promise<void> {
  const githubClientId = document.querySelector<HTMLInputElement>("#githubClientIdInput")?.value.trim();
  const githubDefaultLabels = parseLabels(
    document.querySelector<HTMLInputElement>("#githubLabelsInput")?.value ?? "bug"
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

async function refreshRepos(showMessage: boolean): Promise<void> {
  if (!settings.githubAccessToken) return;
  try {
    repos = await listGitHubRepositories(settings.githubAccessToken);
    if (
      settings.githubSelectedRepo &&
      !repos.some((repo) => repo.fullName === settings.githubSelectedRepo?.fullName)
    ) {
      settings = { ...settings, githubSelectedRepo: undefined };
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
