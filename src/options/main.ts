import "../shared/styles.css";
import { getSettings, saveSettings } from "../shared/storage";
import { DEFAULT_MODEL } from "../shared/types";
import type { Settings } from "../shared/types";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing app root.");

let settings: Settings = {};
let message = "";

void init();

async function init(): Promise<void> {
  settings = await getSettings();
  render();
}

function render(): void {
  app.innerHTML = `
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
        <p class="muted">Defaults are Option+Shift+S/V for new reports and Control+Shift+S/V for attaching evidence. Chrome lets you remap them from the extensions shortcuts page.</p>
        <button id="shortcutsButton">Open Chrome shortcuts</button>
      </section>
    </section>
  `;

  document.querySelector("#saveButton")?.addEventListener("click", () => void save());
  document.querySelector("#shortcutsButton")?.addEventListener("click", () => {
    void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
}

async function save(): Promise<void> {
  const openaiApiKey = document.querySelector<HTMLInputElement>("#apiKeyInput")?.value.trim();
  const openaiModel = document.querySelector<HTMLInputElement>("#modelInput")?.value.trim() || DEFAULT_MODEL;
  settings = { openaiApiKey, openaiModel };
  await saveSettings(settings);
  message = "Settings saved.";
  render();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
