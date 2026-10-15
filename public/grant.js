const params = new URLSearchParams(location.search);
const pendingId = params.get("pendingId") || "";
let origins = null;

const KEEPALIVE_INTERVAL_MS = 10_000;

const statusEl = document.getElementById("status");
const progressEl = document.getElementById("progress");
const grantButton = document.getElementById("grant");
const denyButton = document.getElementById("deny");

grantButton.disabled = true;
denyButton.disabled = true;

function lockButtons() {
  grantButton.disabled = true;
  denyButton.disabled = true;
}

let expired = false;
function showExpired() {
  if (expired) return;
  expired = true;
  lockButtons();
  progressEl.hidden = true;
  statusEl.textContent =
    "This verification session has expired. Close this window and start the verification again from Umia.";
  statusEl.hidden = false;
}

const port = chrome.runtime.connect({ name: "umia-provider-grant" });
port.onMessage.addListener((message) => {
  if (message?.type === "expired") showExpired();
  if (message?.type === "ready" && !expired) {
    if (!Array.isArray(message.origins) || message.origins.length === 0) {
      showExpired();
      return;
    }
    origins = message.origins;
    for (const el of document.querySelectorAll("[data-site]")) {
      el.textContent = message.site;
    }
    grantButton.disabled = false;
    denyButton.disabled = false;
  }
});
port.onDisconnect.addListener(showExpired);
try {
  if (pendingId) port.postMessage({ type: "getPending", pendingId });
  else showExpired();
} catch {
  showExpired();
}

// The background worker holds this flow's state in memory and would otherwise be stopped
// after ~30s idle while the user reads the dialog; each ping resets its idle timer. A dead
// port throws, which is how a lost worker surfaces as the expired state.
const keepalive = setInterval(() => {
  try {
    port.postMessage({ type: "ping", pendingId });
  } catch {
    clearInterval(keepalive);
    showExpired();
  }
}, KEEPALIVE_INTERVAL_MS);

function send(type) {
  try {
    port.postMessage({ type, pendingId });
  } catch {
    showExpired();
  }
}

grantButton.addEventListener("click", async () => {
  if (!origins || expired) return;
  let request;
  try {
    request = chrome.permissions.request({ origins });
  } catch {
    send("denied");
    return;
  }
  lockButtons();
  let granted = false;
  try {
    granted = Boolean(await request);
  } catch {
    granted = false;
  }
  if (granted && !expired) progressEl.hidden = false;
  send(granted ? "granted" : "denied");
});

denyButton.addEventListener("click", () => {
  lockButtons();
  send("denied");
});
