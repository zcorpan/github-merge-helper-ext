import { DEFAULTS } from "./defaults.js";

const form = document.getElementById("settings");
const status = document.getElementById("status");
const savedKey = document.getElementById("saved-key");
const testStatus = document.getElementById("test-status");

// Enough to tell keys apart (and spot a truncated paste) without showing it.
function describeKey(key) {
  return key ? `Saved key: ${key.slice(0, 10)}…${key.slice(-4)} (${key.length} characters).` : "No key saved.";
}

browser.storage.local.get(null).then((stored) => {
  const settings = { ...DEFAULTS, ...stored };
  for (const name of Object.keys(DEFAULTS)) form.elements[name].value = settings[name];
  savedKey.textContent = describeKey(settings.apiKey);
});

document.getElementById("test-key").addEventListener("click", async () => {
  testStatus.textContent = "Testing…";
  const result = await browser.runtime.sendMessage({ type: "testKey", apiKey: form.elements.apiKey.value.trim() });
  testStatus.textContent = result.ok ? "The key works." : result.error;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = {};
  for (const name of Object.keys(DEFAULTS)) {
    settings[name] = form.elements[name].value.trim() || DEFAULTS[name];
  }
  await browser.storage.local.set(settings);
  savedKey.textContent = describeKey(settings.apiKey);
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 2000);
});
