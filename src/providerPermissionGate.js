import {
  PROVIDER_CONTENT_SCRIPT_PATH,
  providerContentScript,
  providerRequestUrls,
} from "@umia/reclaim-browser-extension-sdk/provider-access";
import { getDomain } from "tldts";
import {
  exactExternalCallerPattern,
  isBroadInfrastructurePattern,
  SHARED_TENANT_HOST_SUFFIXES,
  senderOrigin,
} from "./callerOrigin.js";
import { OVERLAY_THEME_PATH } from "./themePaths.js";

const CONTENT_SCRIPT_ID = "reclaim-provider-sites";
const POPUP_PATCH_CSS_PATH = "popup-patches.css";
const GRANT_PAGE = "grant.html";
const GRANT_PORT = "umia-provider-grant";

// Message types on the externally_connectable channel from the hub. Kept in sync
// with the hub's constants in web/hub/lib/zktls-extension.ts (separate bundles, so the
// literals are duplicated on purpose; grep the string to find both sides).
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

// The extension SDK re-issues tabs.create for the same provider within one verification
// (it emits "started" more than once per session). Before access is granted the pending
// grant window dedupes those; once granted — e.g. after the app+provider merge grants the
// site up front — each call would open another tab. Collapse duplicate opens for the same
// site within this window to a single tab.
const PROVIDER_TAB_DEDUPE_MS = 5000;
const recentProviderOpens = new Map();

function backendPatternForCaller(sender) {
  const origin = senderOrigin(sender);
  const profile = ENDPOINT_PROFILES.find((entry) => entry.callerOrigin === origin);
  if (!profile) return null;
  const url = new URL(profile.backendUrl);
  return `${url.protocol}//${url.hostname}:${url.port || "443"}/*`;
}

function getOptionalHostPatterns() {
  const manifest = chrome.runtime.getManifest();
  return Array.isArray(manifest.optional_host_permissions)
    ? manifest.optional_host_permissions
    : [];
}

// Split a match pattern like "https://*.github.com/*" into its scheme and host.
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

// True when the extension may request host access for this scheme+host — i.e. it
// falls within the declared optional_host_permissions (now a broad wildcard).
function isWithinOptionalScope(scheme, host) {
  return getOptionalHostPatterns().some((pattern) => patternMatchesHost(pattern, scheme, host));
}

// The specific per-site pattern to request/grant for a URL. With a wildcard optional
// permission we must never request the wildcard itself (that would prompt for every
// site); instead we grant the URL's registrable domain so the
// provider's subdomains are covered by one grant — matching the old per-site entries.
// Public suffix parsing prevents a multi-part suffix such as co.uk from becoming a grant.
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
  if (SHARED_TENANT_HOST_SUFFIXES.some((base) => host.endsWith(`.${base}`))) {
    return `https://${host}:${port || "443"}/*`;
  }
  const domain = getDomain(host, { allowPrivateDomains: true });
  if (!domain) return `https://${host}:${port || "443"}/*`;
  return `https://*.${domain}/*`;
}

// Whether a full host pattern (e.g. https://*.github.com/*) is one we may request —
// vets the hub's requested provider origins before folding them into a grant, and
// rejects the bare wildcard so a caller can't trigger an all-sites prompt.
export function isPatternWithinOptionalScope(pattern) {
  const parsed = parsePattern(pattern);
  if (!parsed) return false;
  if (isBroadInfrastructurePattern(pattern, ALLOWED_CALLER_ORIGINS)) return false;
  const base = parsed.host.startsWith("*.") ? parsed.host.slice(2) : parsed.host;
  // Reject a wildcard host (e.g. https://*/*) so a caller can't request every site.
  if (base.includes("*")) return false;
  if (parsed.host.startsWith("*.") && getDomain(base, { allowPrivateDomains: true }) !== base)
    return false;
  return isWithinOptionalScope(parsed.scheme, base);
}

function patternSiteLabel(pattern) {
  const host = parsePattern(pattern)?.host ?? pattern;
  return host.startsWith("*.") ? host.slice(2) : host;
}

// The specific host patterns actually granted (from a wildcard optional permission,
// only concrete per-site grants are ever held, never the wildcard itself), so the
// content-script registration mirrors exactly what the user approved.
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

  const definition = providerContentScript({
    id: CONTENT_SCRIPT_ID,
    matches: granted,
    // The overlay theme defines the tokens popup-patches.css reads, so it loads first.
    css: [OVERLAY_THEME_PATH, POPUP_PATCH_CSS_PATH],
  });

  if (isRegistered) {
    await chrome.scripting.updateContentScripts([definition]);
  } else {
    await chrome.scripting.registerContentScripts([definition]);
  }
}

// Serialized so a lifecycle trigger (onAdded/onStartup) and the grant flow can never run two
// register/update calls at once and collide on the script id. Each caller still observes its
// own run's outcome.
function reconcileProviderContentScripts() {
  const run = reconcileTail.then(runReconcile, runReconcile);
  reconcileTail = run.catch(() => {});
  return run;
}

// A runtime grant only registers the relay for FUTURE loads (reconcile); tabs open
// at grant time have no relay until they reload. Inject it into every currently-open
// tab the new grant covers so the app tab that asked for access becomes detectable
// without a reload. Driven off permissions.onAdded — the signal that the grant is
// live — rather than the grant-port message, so it runs with the worker's updated
// permission view and doesn't depend on the grant window keeping this worker alive.
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
      // Inject only into tabs this grant actually covers. Without the "tabs"
      // permission tab.url is populated for every origin we hold access to (not
      // just the new one), so match the tab's pattern against addedOrigins rather
      // than the whole optional scope, so a later grant does not re-inject into
      // tabs granted earlier.
      if (tab.id == null || !tab.url) return;
      const tabPattern = findOptionalPatternForUrl(tab.url);
      if (!tabPattern || !addedOrigins.includes(tabPattern)) return;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: [PROVIDER_CONTENT_SCRIPT_PATH],
        });
      } catch {
        // A tab we can't script (restricted page, race with a close) — skip it.
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

// Register the relay for future loads and inject it into the already-open app tab.
// Dynamic registration only reaches future navigations, so the current hub tab
// needs the live injection; the bundle's readyState guard inits it immediately.
async function activateAppRelay(tabId) {
  await reconcileProviderContentScripts();
  if (tabId == null) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [PROVIDER_CONTENT_SCRIPT_PATH],
  });
}

async function settleGrant(granted) {
  const grant = pendingGrant;
  if (!grant || grant.resolved) return;
  grant.resolved = true;
  pendingGrant = null;

  const closeGrantWindow = () => {
    if (grant.windowId != null) chrome.windows.remove(grant.windowId).catch(() => {});
  };

  // App-domain enable: no SDK session and no provider tab to open. On grant, register for
  // future loads and inject the relay into the tab that asked, so the open verify flow
  // resumes without a page reload; on deny just close the window.
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

function openGrantWindow(request) {
  const pendingId = `grant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  pendingGrant = { ...request, pendingId, windowId: null, resolved: false };

  const origins =
    Array.isArray(request.origins) && request.origins.length > 0
      ? request.origins
      : [request.pattern];
  const siteLabel = origins.map(patternSiteLabel).join(", ");
  pendingGrant.origins = origins;
  pendingGrant.siteLabel = siteLabel;
  const params = new URLSearchParams({ pendingId });

  chrome.windows.create(
    {
      url: chrome.runtime.getURL(`${GRANT_PAGE}?${params.toString()}`),
      type: "popup",
      width: 460,
      height: 360,
    },
    (win) => {
      const err = chrome.runtime.lastError;
      if (err || !win) {
        console.error("[umia-extension] grant window failed to open:", err?.message ?? "no window");
        void failVerification(request.ctx, "PERMISSION_DENIED");
        if (pendingGrant?.pendingId === pendingId) pendingGrant = null;
        return;
      }
      if (pendingGrant?.pendingId === pendingId) pendingGrant.windowId = win.id ?? null;
      // A verification's own request; the app-domain enable has no session to report to.
      request.ctx?.reportTelemetry?.("permission_requested");
    },
  );
}

// Both grant entry points (the provider-tab wrapper and the hub's umia:enable
// request) must avoid stacking a second popup while one is still unresolved for the
// same site: openGrantWindow overwrites the single pendingGrant, which would orphan
// the open window so its later approval reports "expired". Reuse and refocus the
// pending window instead.
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
    if (await chrome.permissions.contains({ origins })) {
      // Access is already granted (e.g. via the app+provider merge), so a duplicate
      // tabs.create from the SDK would open a second tab — collapse rapid repeats.
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
  // The SDK re-issues the provider tab while the grant is still pending; reuse the
  // window already open for this site rather than stacking a duplicate. The pending
  // grant's own callback opens the provider tab once the user approves.
  reuseOrOpenGrantWindow(pattern, { ctx, original, createProperties, callback, pattern, origins });
}

// The SDK opens the provider tab with chrome.tabs.create right after resolving the
// provider's login URL. That is the only place the target origin is known, so this
// wrapper is the seam where a missing optional host permission can be requested
// (and the content script registered) before the tab exists.
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
  wrapTabsCreate(ctx);

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

  // The hub reaches the background directly over externally_connectable, because the
  // SDK content-script relay is absent until the app domain is granted. The same
  // authenticated channel carries the Hub theme for extension-owned windows.
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
      if (!backendPattern) {
        sendResponse({ installed: true, enabled: false, backendEnabled: false });
        return true;
      }
      Promise.all([
        chrome.permissions.contains({ origins: [pattern] }),
        chrome.permissions.contains({ origins: [backendPattern] }),
      ])
        .then(([appEnabled, backendEnabled]) =>
          sendResponse({ installed: true, enabled: appEnabled && backendEnabled, backendEnabled }),
        )
        .catch(() => sendResponse({ installed: true, enabled: false, backendEnabled: false }));
      return true;
    }

    if (message.type === MSG_ENABLE) {
      const requestingTabId = sender.tab?.id;
      if (requestingTabId == null || !backendPattern) {
        sendResponse({ ok: false });
        return;
      }
      // Provider origins the hub asks to grant in the same approval (e.g. github),
      // kept only if within our optional scope and not the app origin itself, so one
      // prompt covers both and verification won't prompt again when it opens the tab.
      const extraOrigins = Array.isArray(message.extraOrigins)
        ? message.extraOrigins.filter(
            (o) => typeof o === "string" && o !== pattern && isPatternWithinOptionalScope(o),
          )
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
          reuseOrOpenGrantWindow(pattern, { kind: "app", pattern, requestingTabId, origins });
          sendResponse({ ok: true });
        })
        // Without this the hub's enable modal spins forever if the check rejects
        // (mirrors the umia:status handler above, which already has a catch).
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
    reconcileSafely("permissions.onAdded");
    void injectRelayIntoGrantedTabs(permissions?.origins ?? []);
  });
  chrome.permissions.onRemoved.addListener(() => reconcileSafely("permissions.onRemoved"));
  chrome.runtime.onStartup.addListener(() => reconcileSafely("runtime.onStartup"));
  chrome.runtime.onInstalled.addListener(() => reconcileSafely("runtime.onInstalled"));
  reconcileSafely("worker-start");
}
