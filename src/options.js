import { DEFAULTS } from "./defaults.js";

const form = document.getElementById("settings");
const status = document.getElementById("status");
const testStatus = document.getElementById("test-status");

browser.storage.local.get(null).then((stored) => {
  const settings = { ...DEFAULTS, ...stored };
  for (const name of Object.keys(DEFAULTS)) form.elements[name].value = settings[name];
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
    settings[name] = form.elements[name].value.trim() || DEFAULTS[name];
  }
  await browser.storage.local.set(settings);
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 2000);
});
