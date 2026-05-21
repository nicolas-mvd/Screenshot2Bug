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

// src/options/main.ts
var app = document.querySelector("#app");
if (!app) throw new Error("Missing app root.");
var root = app;
var settings = {};
var message = "";
void init();
async function init() {
  settings = await getSettings();
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

      ${message ? `<p class="notice">${message}</p>` : ""}

      <section class="panel">
        <label class="field">
          <span>OpenAI API key</span>
          <input id="apiKeyInput" type="password" value="${escapeHtml(settings.openaiApiKey ?? "")}" placeholder="sk-..." />
        </label>

        <label class="field">
          <span>OpenAI model</span>
          <input id="modelInput" type="text" value="${escapeHtml(settings.openaiModel ?? DEFAULT_MODEL)}" />
        </label>

        <button class="primary" id="saveButton">Save settings</button>
      </section>

      <section class="panel">
        <h2>Shortcuts</h2>
        <p class="muted">Defaults are Option+Shift+S for full-tab screenshots, Option+Shift+A for selected-area screenshots, Option+Shift+V for full-tab videos, and Option+Shift+R for selected-area videos. Chrome lets you remap them from the extensions shortcuts page.</p>
        <button id="shortcutsButton">Open Chrome shortcuts</button>
      </section>
    </section>
  `;
  document.querySelector("#saveButton")?.addEventListener("click", () => void save());
  document.querySelector("#shortcutsButton")?.addEventListener("click", () => {
    void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
}
async function save() {
  const openaiApiKey = document.querySelector("#apiKeyInput")?.value.trim();
  const openaiModel = document.querySelector("#modelInput")?.value.trim() || DEFAULT_MODEL;
  settings = { openaiApiKey, openaiModel };
  await saveSettings(settings);
  message = "Settings saved.";
  render();
}
function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
