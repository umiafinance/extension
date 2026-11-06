import {
  PROVIDER_CONTENT_SCRIPT_PATH,
  providerContentScript,
  providerRequestUrls,
} from "@umia/zktls-extension-sdk/provider-access";
import { exactExternalCallerPattern, normalizeOrigin, senderOrigin } from "./callerOrigin.js";

const CONTENT_SCRIPT_ID = "reclaim-provider-sites";
const GRANT_PAGE = "grant.html";
const GRANT_PORT = "umia-provider-grant";

// Message types on the externally_connectable channel from the Umia app, which keeps its
// own copy of these literals: the two sides ship in separate bundles.
const MSG_STATUS = "umia:status";
const MSG_ENABLE = "umia:enable";
const MSG_THEME = "umia:theme";
const THEME_STORAGE_KEY = "umiaTheme";
const ALLOWED_CALLER_ORIGINS = new Set(__UMIA_EXTENSION_CALLERS__);
const ENDPOINT_PROFILES = __UMIA_EXTENSION_ENDPOINT_PROFILES__;
let savedTheme;
let themeTail = Promise.resolve();

function saveHubTheme(theme) {
  if (theme !== "light" && theme !== "dark" && theme !== "system") return Promise.resolve(false);
  const run = themeTail.then(async () => {
    try {
      if (theme === savedTheme) return true;
      if (!chrome.storage?.local) throw new Error("extension storage is unavailable");
      await chrome.storage.local.set({ [THEME_STORAGE_KEY]: theme });
      savedTheme = theme;
      return true;
    } catch (error) {
      console.error("[umia-extension] Hub theme sync failed:", error);
      return false;
    }
  });
  themeTail = run;
  return run;
}

let pendingGrant = null;
let reconcileTail = Promise.resolve();

// The SDK re-issues tabs.create for the same provider within one verification. The pending
// grant window dedupes those before access exists; once the site is granted (for example
// folded into the enable step), repeats within this window collapse to one tab.
const PROVIDER_TAB_DEDUPE_MS = 5000;
const recentProviderOpens = new Map();

function backendPattern(backendUrl) {
  const url = new URL(backendUrl);
  return `${url.protocol}//${url.hostname}:${url.port || "443"}/*`;
}

function backendPatternForCaller(sender) {
  const origin = senderOrigin(sender);
  const profile = ENDPOINT_PROFILES.find((entry) => entry.callerOrigin === origin);
  return profile ? backendPattern(profile.backendUrl) : null;
}

// The Umia app and API grants the user enables once. Every other granted origin is a provider site.
const APP_PATTERNS = new Set(
  ENDPOINT_PROFILES.flatMap((profile) => [
    `${normalizeOrigin(profile.callerOrigin)}/*`,
    backendPattern(profile.backendUrl),
  ]),
);

function getOptionalHostPatterns() {
  const manifest = chrome.runtime.getManifest();
  return Array.isArray(manifest.optional_host_permissions)
    ? manifest.optional_host_permissions
    : [];
}

// Split a match pattern like "https://github.com:443/*" into its scheme and host.
// The host keeps any leading "*." wildcard; callers strip it when they want the
// base domain. Require Chrome's full host-pattern form before permission checks.
function parsePattern(pattern) {
  const m =
    /^(https?|\*):\/\/(\*|(?:\*\.)?[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*|\[[a-fA-F0-9:]+\])(?::([0-9]{1,5}))?\/\*$/.exec(
      pattern,
    );
  return m ? { scheme: m[1], host: `${m[2]}${m[3] ? `:${m[3]}` : ""}` } : null;
}

function patternMatchesHost(pattern, scheme, host) {
  const parsed = parsePattern(pattern);
  if (!parsed) return false;
  const { scheme: patternScheme, host: patternHost } = parsed;
  if (patternScheme !== "*" && patternScheme !== scheme) return false;
  if (patternHost === "*") return true;
  if (patternHost.startsWith("*.")) {
    const base = patternHost.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return host === patternHost;
}

// True when the scheme and host fall within the declared optional_host_permissions.
function isWithinOptionalScope(scheme, host) {
  return getOptionalHostPatterns().some((pattern) => patternMatchesHost(pattern, scheme, host));
}

// The exact host to request for a URL, never the optional wildcard and never a whole domain:
// verifying on developers.google.com must not grant mail.google.com.
export function findOptionalPatternForUrl(url) {
  let host;
  let port;
  let scheme;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    port = parsed.port;
    scheme = parsed.protocol.replace(/:$/, "");
  } catch {
    return null;
  }
  if (!isWithinOptionalScope(scheme, host)) return null;
  if (scheme !== "https") return `${scheme}://${host}/*`;
  return `https://${host}:${port || "443"}/*`;
}

// A provider pattern the Umia app folds into an enable grant, pinned like the gate's own grants:
// one exact host in the optional scope, on port 443 unless it names one. Null otherwise.
export function foldableProviderPattern(pattern) {
  const parsed = typeof pattern === "string" ? parsePattern(pattern) : null;
  if (!parsed || parsed.host.includes("*")) return null;
  const hasPort = /:\d+$/.test(parsed.host);
  if (!isWithinOptionalScope(parsed.scheme, parsed.host.replace(/:\d+$/, ""))) return null;
  if (parsed.scheme !== "https" || hasPort) return pattern;
  return `https://${parsed.host}:443/*`;
}

function patternSiteLabel(pattern) {
  const host = (parsePattern(pattern)?.host ?? pattern).replace(/:443$/, "");
  return host.startsWith("*.") ? host.slice(2) : host;
}

// The grant window names only the provider sites; the Umia app, its backend and local
// dev hosts ride along in the same grant but mean nothing to the user.
function providerSiteLabel(patterns) {
  const sites = patterns
    .map(patternSiteLabel)
    .filter((site) => !/(^|\.)localhost(:\d+)?$/.test(site));
  return [...new Set(sites)].join(", ");
}

// The concrete per-site grants held (never the wildcard itself), so the content-script
// registration mirrors exactly what the user approved.
async function grantedOptionalPatterns() {
  try {
    const all = await chrome.permissions.getAll();
    return Array.isArray(all.origins) ? all.origins : [];
  } catch {
    return [];
  }
}

// Provider sites are optional host permissions, so the SDK content script cannot be
// declared statically for them. Mirror whatever is currently granted into one dynamic
// registration; document_start injection only reaches tabs opened after registration.
async function runReconcile() {
  const granted = await grantedOptionalPatterns();

  let existing = [];
  try {
    existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  } catch {
    existing = [];
  }
  const isRegistered = existing.length > 0;

  if (granted.length === 0) {
    if (isRegistered) {
      await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] }).catch(() => {});
    }
    return;
  }

  const definition = providerContentScript({ id: CONTENT_SCRIPT_ID, matches: granted });

  if (isRegistered) {
    await chrome.scripting.updateContentScripts([definition]);
  } else {
    await chrome.scripting.registerContentScripts([definition]);
  }
}

// Serialized so a lifecycle trigger and the grant flow never run two register/update calls at
// once and collide on the script id. Each caller still sees its own run's outcome.
function reconcileProviderContentScripts() {
  const run = reconcileTail.then(runReconcile, runReconcile);
  reconcileTail = run.catch(() => {});
  return run;
}

let gateCtx = null;
let revokeTail = Promise.resolve();
// The latest session end whose cleanup a pending grant held back.
let deferredBefore = null;

// When each provider origin was granted, in session storage: it outlives a worker restart but not a
// browser restart or extension update, so a grant with no lease predates them.
const LEASES_KEY = "umiaProviderGrants";
// No verification outlives the attestor's 15-minute auth window, so an older grant is abandoned.
const LEASE_MS = 15 * 60 * 1000;

async function storedLeases() {
  try {
    return (await chrome.storage.session.get(LEASES_KEY))[LEASES_KEY] ?? {};
  } catch {
    return {};
  }
}

// After any pending write, so a cleanup sees a grant leased just before it.
async function readLeases() {
  await leaseTail;
  return storedLeases();
}

let leaseTail = Promise.resolve();

// Serialized read-modify-write, so concurrent grants and removals never drop each other's entries.
function updateLeases(update) {
  leaseTail = leaseTail
    .then(async () =>
      chrome.storage.session.set({ [LEASES_KEY]: update({ ...(await storedLeases()) }) }),
    )
    .catch((error) => console.error("[umia-extension] grant lease update failed:", error));
  return leaseTail;
}

function leaseOrigins(origins) {
  const added = providerOrigins(origins);
  if (added.length === 0) return Promise.resolve();
  const now = Date.now();
  return updateLeases((leases) => {
    for (const origin of added) leases[origin] = now;
    return leases;
  });
}

const providerOrigins = (origins) => (origins ?? []).filter((origin) => !APP_PATTERNS.has(origin));

// A running session removes access itself when it ends. A pending grant could still add access,
// so a session-end cleanup waits for it to settle (retryDeferredRevoke).
function blockedByFlow(ctx, before) {
  if (ctx?.activeSessionId) return true;
  if (!pendingGrant) return false;
  if (before != null) deferredBefore = Math.max(deferredBefore ?? 0, before);
  return true;
}

// Removes provider grants made before `before` (a session end), or, without it, every grant with no
// lease or an expired one. Never pulls access from a flow in progress or a grant made after.
async function runRevoke(ctx, before) {
  if (blockedByFlow(ctx, before)) return;
  const [granted, leases] = await Promise.all([grantedOptionalPatterns(), readLeases()]);
  // A verification or grant may have started during the read.
  if (blockedByFlow(ctx, before)) return;
  const now = Date.now();
  const expired = providerOrigins(granted).filter((origin) => {
    const grantedAt = leases[origin];
    if (before != null) return grantedAt == null || grantedAt < before;
    return grantedAt == null || now - grantedAt > LEASE_MS;
  });
  if (expired.length === 0) return;
  await chrome.permissions.remove({ origins: expired });
}

function revokeProviderAccess(ctx, trigger, before) {
  const run = revokeTail.then(() => runRevoke(ctx, before));
  revokeTail = run.catch((error) =>
    console.error(`[umia-extension] provider access removal failed (${trigger}):`, error),
  );
  return revokeTail;
}

function retryDeferredRevoke() {
  if (deferredBefore == null || pendingGrant) return;
  const before = deferredBefore;
  deferredBefore = null;
  void revokeProviderAccess(gateCtx, "grant-settled", before);
}

// Registration only reaches future loads, so inject the relay into open tabs the new grant
// covers. Driven by permissions.onAdded rather than the grant port, so it sees the updated
// permissions and does not depend on the grant window keeping the worker alive.
async function injectRelayIntoGrantedTabs(addedOrigins) {
  if (!Array.isArray(addedOrigins) || addedOrigins.length === 0) return;
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  await Promise.all(
    tabs.map(async (tab) => {
      // Without the "tabs" permission, tab.url is set for every origin already held, so match
      // against addedOrigins or a later grant would re-inject into earlier tabs.
      if (tab.id == null || !tab.url) return;
      const tabPattern = findOptionalPatternForUrl(tab.url);
      if (!tabPattern || !addedOrigins.includes(tabPattern)) return;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: [PROVIDER_CONTENT_SCRIPT_PATH],
        });
      } catch {
        // Restricted page or a tab closing mid-injection.
      }
    }),
  );
}

// `code` is a ZktlsErrorCode; the SDK forwards only fixed codes to the page.
async function failVerification(ctx, code) {
  try {
    if (ctx && typeof ctx.failSession === "function") await ctx.failSession(code);
  } catch (error) {
    console.error("[umia-extension] failSession dispatch failed:", error);
  }
}

async function openProviderTab(grant) {
  recentProviderOpens.set(grant.pattern, Date.now());
  let createProperties = grant.createProperties;
  const originalTabId = grant.ctx?.originalTabId;
  if (originalTabId != null) {
    try {
      const tab = await chrome.tabs.get(originalTabId);
      if (tab?.windowId != null) createProperties = { ...createProperties, windowId: tab.windowId };
    } catch {}
  }
  await new Promise((resolve, reject) => {
    try {
      grant.original(createProperties, (tab) => {
        const err = chrome.runtime.lastError;
        try {
          grant.callback?.(tab);
        } catch {}
        if (err || !tab) reject(new Error(err?.message || "provider tab was not created"));
        else resolve(tab);
      });
    } catch (error) {
      reject(error);
    }
  });
}

// Register the relay for future loads and inject it into the already-open Umia app tab, which
// registration alone would miss; the bundle's readyState guard inits it immediately.
async function activateAppRelay(tabId) {
  await reconcileProviderContentScripts();
  if (tabId == null) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [PROVIDER_CONTENT_SCRIPT_PATH],
  });
}

async function settleGrant(granted) {
  const origins = pendingGrant?.origins;
  try {
    // Leased before any held-back cleanup runs, so that cleanup keeps what was just granted.
    if (granted) await leaseOrigins(origins);
    await settlePendingGrant(granted);
  } finally {
    retryDeferredRevoke();
  }
}

async function settlePendingGrant(granted) {
  const grant = pendingGrant;
  if (!grant || grant.resolved) return;
  grant.resolved = true;
  pendingGrant = null;

  const closeGrantWindow = () => {
    if (grant.windowId != null) chrome.windows.remove(grant.windowId).catch(() => {});
  };

  // App-domain enable has no SDK session or provider tab. On grant, activate the relay in the
  // asking tab so its verification resumes without a reload.
  if (grant.kind === "app") {
    if (granted) {
      try {
        await activateAppRelay(grant.requestingTabId);
      } catch (error) {
        console.error("[umia-extension] app-relay activation after grant failed:", error);
      }
    }
    closeGrantWindow();
    return;
  }

  // The grant window only closes after the flow's terminal action completed. Closing it
  // earlier races the SDK's tabs.onRemoved cleanup: with no managed provider tab yet, that
  // listener nulls ctx.originalTabId (or fails the session outright), and the page never
  // hears the outcome.
  if (!granted) {
    await failVerification(grant.ctx, "PERMISSION_DENIED");
    closeGrantWindow();
    return;
  }
  grant.ctx?.reportTelemetry?.("permission_granted");

  try {
    await reconcileProviderContentScripts();
    await openProviderTab(grant);
  } catch (error) {
    console.error("[umia-extension] resume after grant failed:", error);
    await failVerification(grant.ctx, "PROVIDER_UNAVAILABLE");
    closeGrantWindow();
    return;
  }
  closeGrantWindow();
}

const GRANT_WINDOW_SIZE = { width: 440, height: 640 };

// A popup created without a position lands near the screen's top-left corner. Centre it on the
// browser window the user is in, which also places Chrome's permission prompt attached to it.
async function centredOnFocusedWindow({ width, height }) {
  try {
    const parent = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (![parent?.left, parent?.top, parent?.width, parent?.height].every(Number.isFinite)) {
      return {};
    }
    return {
      left: Math.round(parent.left + (parent.width - width) / 2),
      top: Math.round(parent.top + (parent.height - height) / 2),
    };
  } catch {
    return {};
  }
}

function openGrantWindow(request) {
  const pendingId = `grant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  pendingGrant = { ...request, pendingId, windowId: null, resolved: false };

  const origins =
    Array.isArray(request.origins) && request.origins.length > 0
      ? request.origins
      : [request.pattern];
  const siteLabel = providerSiteLabel(request.providerOrigins ?? origins);
  pendingGrant.origins = origins;
  pendingGrant.siteLabel = siteLabel;
  const params = new URLSearchParams({ pendingId });

  void centredOnFocusedWindow(GRANT_WINDOW_SIZE).then((position) =>
    chrome.windows.create(
      {
        url: chrome.runtime.getURL(`${GRANT_PAGE}?${params.toString()}`),
        type: "popup",
        ...GRANT_WINDOW_SIZE,
        ...position,
      },
      (win) => {
        const err = chrome.runtime.lastError;
        if (err || !win) {
          console.error(
            "[umia-extension] grant window failed to open:",
            err?.message ?? "no window",
          );
          void failVerification(request.ctx, "PERMISSION_DENIED");
          if (pendingGrant?.pendingId === pendingId) pendingGrant = null;
          retryDeferredRevoke();
          return;
        }
        if (pendingGrant?.pendingId === pendingId) pendingGrant.windowId = win.id ?? null;
        // A verification's own request; the app-domain enable has no session to report to.
        request.ctx?.reportTelemetry?.("permission_requested");
      },
    ),
  );
}

// openGrantWindow overwrites the single pendingGrant, so a second popup for the same site would
// orphan the first and its approval would report "expired". Refocus the pending window instead.
function reuseOrOpenGrantWindow(pattern, request) {
  if (pendingGrant && !pendingGrant.resolved && pendingGrant.pattern === pattern) {
    if (pendingGrant.windowId != null) {
      chrome.windows.update(pendingGrant.windowId, { focused: true }).catch(() => {});
    }
    return;
  }
  openGrantWindow(request);
}

async function gateProviderTab(ctx, original, createProperties, callback, pattern) {
  // `pattern` stays the primary: it keys the dedupe map and labels the grant window.
  const requestPatterns = providerRequestUrls(ctx?.providerData).map(findOptionalPatternForUrl);
  const origins = [...new Set([pattern, ...requestPatterns.filter(Boolean)])];
  try {
    // Let an in-flight cleanup finish, so it cannot remove access after this check.
    await revokeTail;
    if (await chrome.permissions.contains({ origins })) {
      // Already granted, so collapse the SDK's rapid duplicate tabs.create calls.
      const now = Date.now();
      const last = recentProviderOpens.get(pattern);
      if (last != null && now - last < PROVIDER_TAB_DEDUPE_MS) return;
      recentProviderOpens.set(pattern, now);
      await reconcileProviderContentScripts();
      original(createProperties, callback);
      return;
    }
  } catch (error) {
    console.error("[umia-extension] provider access check failed:", error);
    await failVerification(ctx, "PERMISSION_DENIED");
    return;
  }
  // The pending grant opens the provider tab once the user approves.
  reuseOrOpenGrantWindow(pattern, { ctx, original, createProperties, callback, pattern, origins });
}

// chrome.tabs.create for the provider tab is the only point where the SDK's target origin is
// known, so host access is requested and the content script registered here, before the tab exists.
function wrapTabsCreate(ctx) {
  const original = chrome.tabs.create.bind(chrome.tabs);
  chrome.tabs.create = (createProperties, callback) => {
    const url = createProperties?.url;
    const pattern = typeof url === "string" ? findOptionalPatternForUrl(url) : null;
    if (!pattern) return original(createProperties, callback);
    void gateProviderTab(ctx, original, createProperties, callback, pattern);
    return undefined;
  };
}

export function installProviderPermissionGate(ctx) {
  gateCtx = ctx;
  wrapTabsCreate(ctx);
  ctx.onSessionEnd = () => void revokeProviderAccess(ctx, "session-end", Date.now());

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== GRANT_PORT) return;
    let verifiedPendingId = null;
    port.onMessage.addListener((message) => {
      // Keepalive pings need no handling: delivery alone resets the worker's idle timer.
      if (!message || message.type === "ping") return;
      if (message.type === "getPending") {
        const grant = pendingGrant;
        verifiedPendingId =
          grant && !grant.resolved && message.pendingId === grant.pendingId
            ? grant.pendingId
            : null;
        port.postMessage(
          verifiedPendingId
            ? { type: "ready", origins: grant.origins, site: grant.siteLabel }
            : { type: "expired" },
        );
        return;
      }
      if (message.type !== "granted" && message.type !== "denied") return;
      if (
        !pendingGrant ||
        pendingGrant.resolved ||
        message.pendingId !== verifiedPendingId ||
        message.pendingId !== pendingGrant.pendingId
      ) {
        // A reborn worker has no pending state for this window; tell it instead of hanging.
        try {
          port.postMessage({ type: "expired" });
        } catch {}
        return;
      }
      void settleGrant(message.type === "granted");
    });
    port.onDisconnect.addListener(() => {
      if (pendingGrant && !pendingGrant.resolved && verifiedPendingId === pendingGrant.pendingId)
        void settleGrant(false);
    });
  });

  // The Umia app uses externally_connectable because the content-script relay is absent until
  // the app domain is granted. The same channel carries its theme for the extension's windows.
  chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;
    const pattern = exactExternalCallerPattern(sender, ALLOWED_CALLER_ORIGINS);
    if (!pattern) return;
    const backendPattern = backendPatternForCaller(sender);

    if (message.type === MSG_THEME) {
      void saveHubTheme(message.theme).then((ok) => sendResponse({ ok }));
      return true;
    }

    if (message.type === MSG_STATUS) {
      void saveHubTheme(message.theme);
      const version = chrome.runtime.getManifest().version;
      if (!backendPattern) {
        sendResponse({ installed: true, enabled: false, backendEnabled: false, version });
        return true;
      }
      Promise.all([
        chrome.permissions.contains({ origins: [pattern] }),
        chrome.permissions.contains({ origins: [backendPattern] }),
      ])
        .then(([appEnabled, backendEnabled]) =>
          sendResponse({
            installed: true,
            enabled: appEnabled && backendEnabled,
            backendEnabled,
            version,
          }),
        )
        .catch(() =>
          sendResponse({ installed: true, enabled: false, backendEnabled: false, version }),
        );
      return true;
    }

    if (message.type === MSG_ENABLE) {
      const requestingTabId = sender.tab?.id;
      if (requestingTabId == null || !backendPattern) {
        sendResponse({ ok: false });
        return;
      }
      // Provider sites folded into the same approval so the verification does not prompt again.
      const extraOrigins = Array.isArray(message.extraOrigins)
        ? [
            ...new Set(
              message.extraOrigins
                .map(foldableProviderPattern)
                .filter((origin) => origin && origin !== pattern),
            ),
          ]
        : [];
      void saveHubTheme(message.theme);
      const origins = [...new Set([pattern, backendPattern, ...extraOrigins])];
      chrome.permissions
        .contains({ origins })
        .then(async (alreadyGranted) => {
          if (alreadyGranted) {
            try {
              await activateAppRelay(requestingTabId);
            } catch (error) {
              console.error("[umia-extension] app-relay activation failed:", error);
            }
            sendResponse({ ok: true, alreadyEnabled: true });
            return;
          }
          reuseOrOpenGrantWindow(pattern, {
            kind: "app",
            pattern,
            requestingTabId,
            origins,
            providerOrigins: extraOrigins,
          });
          sendResponse({ ok: true });
        })
        // Always answer, or the Umia app's enable dialog waits forever.
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
  });

  const reconcileSafely = (trigger) => {
    reconcileProviderContentScripts().catch((error) =>
      console.error(`[umia-extension] content-script reconcile failed (${trigger}):`, error),
    );
  };
  chrome.permissions.onAdded.addListener((permissions) => {
    void leaseOrigins(permissions?.origins);
    reconcileSafely("permissions.onAdded");
    void injectRelayIntoGrantedTabs(permissions?.origins ?? []);
  });
  chrome.permissions.onRemoved.addListener((permissions) => {
    const removed = permissions?.origins ?? [];
    if (removed.length) {
      void updateLeases((leases) => {
        for (const origin of removed) delete leases[origin];
        return leases;
      });
    }
    reconcileSafely("permissions.onRemoved");
  });
  // A worker restart drops any session in progress, so grants it held are abandoned; a fresh
  // grant, such as a provider folded into the app's enable step, keeps its lease.
  chrome.runtime.onStartup.addListener(() => {
    reconcileSafely("runtime.onStartup");
    void revokeProviderAccess(ctx, "runtime.onStartup");
  });
  chrome.runtime.onInstalled.addListener(() => {
    reconcileSafely("runtime.onInstalled");
    void revokeProviderAccess(ctx, "runtime.onInstalled");
  });
  reconcileSafely("worker-start");
  void revokeProviderAccess(ctx, "worker-start");
}
