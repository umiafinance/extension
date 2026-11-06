// Host-access helpers for a consumer that grants provider sites as optional permissions.
// Dependency-free so the consumer's background bundle and its tests import it from source.

export const PROVIDER_CONTENT_SCRIPT_PATH =
  "reclaim-browser-extension-sdk/content/content.bundle.js";

// A provider's requests need not live on its login URL's site: it may log in on a partner
// page and POST to its own domain. A grant covering only the login tab would leave those
// requests uninterceptable, so the consumer grants their hosts too.
export function providerRequestUrls(providerData) {
  const requests = providerData?.requestData;
  if (!Array.isArray(requests)) return [];
  return [
    ...new Set(requests.map((request) => request?.url).filter((url) => typeof url === "string")),
  ];
}

// The dynamic registration for granted provider sites. Chrome defaults allFrames to false,
// which silently misses a provider whose request fires inside an iframe, such as a portal
// that refuses to load top-level and is only observable in a cross-origin frame.
export function providerContentScript({ id, matches, css = [] }) {
  return {
    id,
    matches,
    js: [PROVIDER_CONTENT_SCRIPT_PATH],
    css,
    runAt: "document_start",
    persistAcrossSessions: true,
    allFrames: true,
  };
}
