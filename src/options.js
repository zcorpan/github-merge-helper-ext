import { DEFAULTS } from "./defaults.js";

const form = document.getElementById("settings");
const status = document.getElementById("status");
const testStatus = document.getElementById("test-status");

browser.storage.local.get(DEFAULTS).then((settings) => {
  for (const name of Object.keys(DEFAULTS)) {
    const field = form.elements[name];
    if (field.type === "checkbox") field.checked = settings[name];
    else field.value = settings[name];
  }
});

document.getElementById("test-connection").addEventListener("click", async () => {
  testStatus.textContent = "Testing…";
  const result = await browser.runtime.sendMessage({ type: "testConnection" });
  testStatus.textContent = result.ok ? "The native helper and the API key work." : result.error;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = {};
  for (const name of Object.keys(DEFAULTS)) {
    const field = form.elements[name];
    settings[name] = field.type === "checkbox" ? field.checked : field.value.trim() || DEFAULTS[name];
  }
  await browser.storage.local.set(settings);
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 2000);
});
