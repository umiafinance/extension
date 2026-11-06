import { describeRequestMatch } from "../utils/claim-creator/network-filter";

// The browser sets these on the real request; a page-reported value must never reach the claim.
const BROWSER_OWNED_HEADERS = new Set(["cookie", "origin", "referer"]);

function signedHosts(ctx) {
  const hosts = ctx.session?.umia?.attestorAuth?.data?.hostWhitelist;
  return Array.isArray(hosts) ? hosts : [];
}

function httpsHost(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.hostname : null;
  } catch {
    return null;
  }
}

function isSignedHost(ctx, value) {
  const host = httpsHost(value);
  return !!host && signedHosts(ctx).includes(host);
}

/**
 * A claim may come only from the live verification tab: its top frame, or a subframe whose
 * committed origin is a signed host (some providers only render inside a cross-origin frame).
 */
export function isClaimSender(ctx, sender) {
  const tabId = sender?.tab?.id;
  if (
    sender?.id !== chrome.runtime.id ||
    !Number.isInteger(tabId) ||
    tabId !== ctx.activeTabId ||
    !ctx.managedTabs.has(tabId) ||
    typeof sender.documentId !== "string" ||
    !sender.documentId ||
    (sender.documentLifecycle && sender.documentLifecycle !== "active")
  ) {
    return false;
  }
  if (sender.frameId === 0) return true;
  if (!Number.isInteger(sender.frameId) || typeof sender.origin !== "string") return false;
  try {
    return new URL(sender.url).origin === sender.origin && isSignedHost(ctx, sender.origin);
  } catch {
    return false;
  }
}

function stringRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string"));
}

// Only what the page actually observed; Cookie, Origin and Referer are the background's to set.
function pageRequest(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.url !== "string") return null;
  const headers = Object.fromEntries(
    Object.entries(stringRecord(raw.headers)).filter(
      ([name]) => !BROWSER_OWNED_HEADERS.has(name.toLowerCase()),
    ),
  );
  return {
    url: raw.url,
    method: typeof raw.method === "string" ? raw.method : "GET",
    headers,
    body: typeof raw.body === "string" ? raw.body : null,
    ...(typeof raw.responseText === "string" ? { responseText: raw.responseText } : {}),
  };
}

function recipeEntry(entries, requestHash) {
  if (typeof requestHash !== "string" || !requestHash) return null;
  return entries.find((entry) => entry?.requestHash === requestHash) ?? null;
}

/**
 * Pair a page-reported request with the pinned recipe entry it claims to satisfy. The
 * criteria are the recipe's, never the page's, and the request must still match them.
 *
 * @returns {{request: Object, criteria: Object} | null}
 */
export function resolveClaimRequest(ctx, data) {
  const entries = Array.isArray(ctx.providerData?.requestData) ? ctx.providerData.requestData : [];
  const criteria = recipeEntry(entries, data?.requestHash);
  const request = pageRequest(data?.request);
  if (!criteria || !request || !isSignedHost(ctx, request.url)) return null;
  const verdict = describeRequestMatch(request, criteria, ctx.parameters || {});
  return verdict.matched ? { request, criteria } : null;
}
