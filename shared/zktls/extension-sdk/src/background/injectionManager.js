import { requireLiveSession } from "../utils/session-config";
import { normalizeUrlType, URL_TYPES } from "../utils/provider-normalization";
import { templateVariables } from "../utils/claim-creator/network-filter";
import { parseZktlsRequestChain } from "@umia/zktls-config/request-chain";

export const REPLAY_OP = "REPLAY_BOUND_DOCUMENT";
export const REQUEST_CHAIN_OP = "RUN_REQUEST_CHAIN";
// Replays per session for each plain GET the recipe declares, so a cycling page cannot loop them.
export const MAX_REPLAYS_PER_SESSION = 3;
const REPLAY_KEY = "replay|";

export function publicProviderData(ctx) {
  if (!ctx.providerData) return ctx.providerData;
  return { ...ctx.providerData, loginUrl: ctx.providerLoginUrl };
}

function current(ctx, bound) {
  requireLiveSession(bound.session);
  return (
    !ctx.aborted &&
    ctx.session === bound.session &&
    ctx.providerData === bound.provider &&
    ctx.providerLoginUrl === bound.loginUrl &&
    ctx.activeSessionId === bound.sessionId &&
    ctx.sessionId === bound.sessionId &&
    ctx.activeTabId === bound.tabId &&
    ctx.managedTabs.has(bound.tabId) &&
    ctx.injectionOperations === bound.operations
  );
}

function originOf(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.origin !== "null"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

// An operation request is never an input channel for code, a provider, a
// backend, a URL, or a token: it carries exactly one field, its op.
function isOperation(data, op) {
  return !!data && Object.keys(data).length === 1 && data.op === op;
}

// The live session's provider tab, top frame and active document, on the login origin;
// null otherwise, including when the session has expired.
function boundSender(ctx, sender) {
  try {
    return liveBoundSender(ctx, sender);
  } catch {
    return null;
  }
}

function liveBoundSender(ctx, sender) {
  const bound = {
    tabId: sender?.tab?.id,
    documentId: sender?.documentId,
    session: ctx.session,
    provider: ctx.providerData,
    loginUrl: ctx.providerLoginUrl,
    sessionId: ctx.activeSessionId,
    operations: ctx.injectionOperations,
  };
  if (
    sender?.id !== chrome.runtime.id ||
    sender?.frameId !== 0 ||
    (sender?.documentLifecycle && sender.documentLifecycle !== "active") ||
    typeof bound.documentId !== "string" ||
    !bound.documentId ||
    !Number.isInteger(bound.tabId) ||
    !(bound.operations instanceof Map) ||
    !bound.provider ||
    !current(ctx, bound)
  ) {
    return null;
  }
  const expectedOrigin = originOf(bound.loginUrl);
  if (
    !expectedOrigin ||
    sender.origin !== expectedOrigin ||
    originOf(sender.url) !== expectedOrigin
  ) {
    return null;
  }
  return { ...bound, expectedOrigin };
}

export async function runBoundRequestChain(ctx, sender, data) {
  if (!isOperation(data, REQUEST_CHAIN_OP)) {
    return { success: false, error: "INJECTION_REJECTED" };
  }

  const bound = boundSender(ctx, sender);
  if (!bound) return { success: false, error: "INJECTION_REJECTED" };
  const { tabId, documentId, provider, operations, expectedOrigin } = bound;

  try {
    if (provider.requestChain === undefined) return { success: true, status: "skipped" };
    const chain = parseZktlsRequestChain(provider.requestChain, provider.requestData);
    if (!chain) return { success: false, error: "INJECTION_REJECTED" };
    const urls = provider.requestData.map((request) => request.url);
    const hosts = bound.session.umia.attestorAuth.data.hostWhitelist;
    if (
      !Array.isArray(hosts) ||
      [chain.readyUrl, ...urls].some((url) => !hosts.includes(new URL(url).hostname))
    ) {
      return { success: false, error: "INJECTION_REJECTED" };
    }

    if (operations.has(documentId)) {
      return operations.get(documentId) === "executed"
        ? { success: true, status: "duplicate" }
        : { success: false, error: "INJECTION_REJECTED" };
    }
    // Reserve before the first await. An uncertain executeScript outcome must
    // never re-run the chain in the same session/document.
    operations.set(documentId, "pending");

    const tab = await chrome.tabs.get(tabId);
    if (originOf(tab?.url) !== expectedOrigin || !current(ctx, bound)) {
      operations.set(documentId, "rejected");
      return { success: false, error: "INJECTION_REJECTED" };
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [documentId] },
      world: "MAIN",
      func: (requestChain, requestUrls, deadline) => {
        // Declarative fetches work under page CSP without eval or generated functions.
        // Keep this function self-contained: Chrome serializes it outside the bundle.
        var parameters = Object.create(null);
        function live() {
          return Date.now() < deadline;
        }
        function get(url) {
          return fetch(url, { credentials: "include", cache: "no-store", redirect: "error" });
        }
        function next(index) {
          if (!live() || index >= requestUrls.length) return;
          var url = requestUrls[index].replace(/\{\{(\w+)\}\}/g, function (_, key) {
            if (!Object.prototype.hasOwnProperty.call(parameters, key))
              throw new Error("Missing request parameter");
            return encodeURIComponent(parameters[key]);
          });
          return get(url).then(function (response) {
            if (!response.ok) return;
            var captures = requestChain.responseParameters.filter(function (item) {
              return item.requestIndex === index;
            });
            if (!captures.length) return next(index + 1);
            return response.json().then(function (json) {
              captures.forEach(function (capture) {
                var value = json;
                capture.path.forEach(function (key) {
                  value =
                    value && Object.prototype.hasOwnProperty.call(value, key)
                      ? value[key]
                      : undefined;
                });
                if (typeof value !== "string" || !value || value.length > 256)
                  throw new Error("Invalid request parameter");
                var part = capture.slice
                  ? value.slice(capture.slice[0], capture.slice[1])
                  : value;
                if (!part) throw new Error("Invalid request parameter");
                parameters[capture.parameter] = part;
              });
              return next(index + 1);
            });
          });
        }
        function poll() {
          if (!live()) return;
          get(requestChain.readyUrl).then(
            function (response) {
              if (response.status === 200) {
                Promise.resolve()
                  .then(function () {
                    return next(0);
                  })
                  .catch(function () {});
                return;
              }
              if (live()) setTimeout(poll, 2000);
            },
            function () {
              if (live()) setTimeout(poll, 2000);
            },
          );
        }
        poll();
        return { status: "executed" };
      },
      args: [
        chain,
        urls,
        Math.min(
          Date.parse(bound.session.umia.expiresAt),
          bound.session.umia.attestorAuth.data.expiresAt * 1000,
        ),
      ],
    });

    if (!current(ctx, bound)) {
      operations.set(documentId, "rejected");
      return { success: false, error: "CANCELLED" };
    }
    const result = results?.[0];
    if (
      results?.length !== 1 ||
      result.documentId !== documentId ||
      result.frameId !== 0 ||
      result.result?.status !== "executed"
    ) {
      operations.set(documentId, "rejected");
      return { success: false, error: "INJECTION_REJECTED" };
    }
    operations.set(documentId, "executed");
    return { success: true, status: "executed" };
  } catch {
    if (operations.get(documentId) === "pending") operations.set(documentId, "rejected");
    return { success: false, error: "INJECTION_REJECTED" };
  }
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A path variable stays inside one path segment, a query variable inside one value.
function templatePattern(template) {
  const queryStart = template.indexOf("?");
  let pattern = "";
  let literalStart = 0;
  for (const match of template.matchAll(templateVariables())) {
    const inQuery = queryStart !== -1 && match.index > queryStart;
    pattern += escapeRegex(template.slice(literalStart, match.index));
    pattern += inQuery ? "[^&=#]+" : "[^/?#]+";
    literalStart = match.index + match[0].length;
  }
  return pattern + escapeRegex(template.slice(literalStart));
}

// The whole URL must match, so the query has exactly the declared parameters, in order.
function declaresUrl(request, url) {
  if (typeof request?.url !== "string" || !request.url) return false;
  const type = normalizeUrlType(request.urlType, request.url);
  if (type === URL_TYPES.CONSTANT) return request.url === url;
  const pattern = type === URL_TYPES.TEMPLATE ? templatePattern(request.url) : request.url;
  try {
    return new RegExp(`^(?:${pattern})$`, "s").test(url);
  } catch {
    return false;
  }
}

const isPlainGet = (request) =>
  String(request?.method).toUpperCase() === "GET" && !request.bodySniff?.enabled;

const plainGets = (provider) =>
  Array.isArray(provider.requestData) ? provider.requestData.filter(isPlainGet) : [];

// A replay re-issues only a document request the pinned recipe declares as a plain GET.
function replayableUrl(provider, url) {
  return plainGets(provider).some((request) => declaresUrl(request, url));
}

// The recipe's other fixed-URL GETs on this origin, so one signed-in page yields every proof.
function companionUrls(provider, url) {
  const origin = originOf(url);
  if (!origin) return [];
  const urls = plainGets(provider)
    .filter(
      (request) =>
        typeof request.url === "string" &&
        !request.url.includes("{{") &&
        normalizeUrlType(request.urlType, request.url) !== URL_TYPES.REGEX &&
        originOf(request.url) === origin &&
        request.url !== url,
    )
    .map((request) => request.url);
  return [...new Set(urls)];
}

/**
 * Re-requests the bound provider tab's own document as a credentialed same-origin XHR,
 * which the page-world interceptor captures like any page request, together with the
 * recipe's other fixed-URL GETs on that origin. URLs come from the browser's tab record
 * and the pinned recipe, never from the message.
 */
export async function runBoundReplay(ctx, sender, data) {
  if (!isOperation(data, REPLAY_OP)) return { success: false, error: "REPLAY_REJECTED" };

  const bound = boundSender(ctx, sender);
  if (!bound) return { success: false, error: "REPLAY_REJECTED" };
  const { tabId, documentId, session, provider, operations } = bound;

  let keys = [];
  const mark = (status) => keys.forEach((key) => operations.set(key, status));
  try {
    // Upstream's default: only an explicit opt-out disables replay.
    if (provider.disableRequestReplay === true) {
      return { success: true, status: "disabled" };
    }
    const tab = await chrome.tabs.get(tabId);
    const url = tab?.url;
    const host = new URL(url).hostname;
    const hostWhitelist = session?.umia?.attestorAuth?.data?.hostWhitelist;
    if (
      !current(ctx, bound) ||
      url !== sender.url ||
      !Array.isArray(hostWhitelist) ||
      !hostWhitelist.includes(host) ||
      !replayableUrl(provider, url)
    ) {
      return { success: false, error: "REPLAY_REJECTED" };
    }

    const keyOf = (target) => `${REPLAY_KEY}${documentId}|${target}`;
    if (operations.has(keyOf(url))) {
      return operations.get(keyOf(url)) === "executed"
        ? { success: true, status: "duplicate" }
        : { success: false, error: "REPLAY_REJECTED" };
    }
    const companions = companionUrls(provider, url).filter(
      (target) => !operations.has(keyOf(target)),
    );
    const replays = [...operations.keys()].filter((k) => k.startsWith(REPLAY_KEY)).length;
    if (replays + 1 + companions.length > MAX_REPLAYS_PER_SESSION * plainGets(provider).length) {
      return { success: false, error: "REPLAY_REJECTED" };
    }
    // Reserve before the next await: an uncertain outcome must never send a request twice.
    keys = [url, ...companions].map(keyOf);
    mark("pending");

    const results = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [documentId] },
      world: "MAIN",
      func: (approvedUrl, otherUrls) => {
        if (window.location.href !== approvedUrl) return { status: "moved" };
        if (!window.reclaimInterceptor) return { status: "not-ready" };
        try {
          // This runs in the page without the bundle's Babel helpers: no spread or for...of.
          [approvedUrl].concat(otherUrls).forEach((target) => {
            const xhr = new XMLHttpRequest();
            xhr.open("GET", target, true);
            xhr.withCredentials = true;
            xhr.setRequestHeader(
              "accept",
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            );
            xhr.setRequestHeader("accept-language", "en-GB,en;q=0.5");
            xhr.setRequestHeader("cache-control", "no-store");
            xhr.send(null);
          });
          return { status: "sent" };
        } catch {
          return { status: "error" };
        }
      },
      args: [url, companions],
    });

    const result = results?.[0];
    const status =
      results?.length === 1 && result.documentId === documentId && result.frameId === 0
        ? result.result?.status
        : undefined;
    // Nothing was sent, so a later trigger may try this document and these URLs again.
    if (status === "moved" || status === "not-ready") {
      keys.forEach((key) => operations.delete(key));
      return { success: false, status };
    }
    if (status !== "sent") {
      mark("rejected");
      return { success: false, error: "REPLAY_REJECTED" };
    }
    mark("executed");
    return current(ctx, bound)
      ? { success: true, status: "executed" }
      : { success: false, error: "CANCELLED" };
  } catch {
    for (const key of keys) {
      if (operations.get(key) === "pending") operations.set(key, "rejected");
    }
    return { success: false, error: "REPLAY_REJECTED" };
  }
}
