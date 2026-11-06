const KEEPALIVE_INTERVAL_MS = 10_000;

/**
 * The site-access window's protocol with the background, rendered through `render(view)`.
 * Origins come only from the background's `ready` message, never from the query string, and
 * `grant()` must be called straight from the click so Chrome sees the user gesture.
 */
export function startGrantPage({ chrome, search, render, setInterval, clearInterval }) {
  const pendingId = new URLSearchParams(search).get("pendingId") || "";
  const view = { phase: "loading", site: null, locked: false };
  const show = (patch) => {
    Object.assign(view, patch);
    render({ ...view });
  };
  let origins = null;
  let expired = false;

  function showExpired() {
    if (expired) return;
    expired = true;
    show({ phase: "expired" });
  }

  show({});
  const port = chrome.runtime.connect({ name: "umia-provider-grant" });
  port.onMessage.addListener((message) => {
    if (message?.type === "expired") showExpired();
    if (message?.type === "ready" && !expired) {
      if (!Array.isArray(message.origins) || message.origins.length === 0) {
        showExpired();
        return;
      }
      origins = message.origins;
      show({ phase: "ready", site: message.site });
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

  async function grant() {
    if (!origins || expired || view.locked) return;
    let request;
    try {
      request = chrome.permissions.request({ origins });
    } catch {
      send("denied");
      return;
    }
    show({ locked: true });
    let granted = false;
    try {
      granted = Boolean(await request);
    } catch {
      granted = false;
    }
    if (granted && !expired) show({ phase: "granted" });
    send(granted ? "granted" : "denied");
  }

  function deny() {
    if (!origins || view.locked || expired) return;
    show({ locked: true });
    send("denied");
  }

  return { grant, deny };
}
