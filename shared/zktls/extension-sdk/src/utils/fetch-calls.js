import { isServableLoginUrl } from "@umia/zktls-config/login-url";
import { API_ENDPOINTS } from "./constants/constants.js";
import { withClientSource } from "./logger/client-source.js";
import { pinnedGeoLocation } from "./claim-creator/get-dynamic-geo.js";
import { failureCode } from "./constants/interfaces.js";
import {
  approvedBackendUrl,
  requireLiveSession,
  requirePinnedVersion,
  requireSessionToken,
} from "./session-config.js";

// Note: This file is used by both background and offscreen contexts.
// Logging is handled by the caller to avoid duplicate log instances.
//
// Every request carries the `reclaim-api-client` header, the same header the
// InApp SDK and Verifier app send, so extension traffic is attributable
// server-side. This is identification only: the extension contributes no device
// information, so `deviceId`/`deviceType` stay absent from request bodies.

function sessionHeaders(session, extra = {}) {
  requireLiveSession(session);
  const token = requireSessionToken(session.umia.sessionToken);
  return {
    backendUrl: approvedBackendUrl(session.route.backendUrl),
    headers: withClientSource({ ...extra, Authorization: `Bearer ${token}` }),
  };
}

// A network failure, rejected redirect or unreadable body from the bound
// backend is an availability problem, not a config one.
async function backendFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error("BACKEND_UNREACHABLE");
  }
}

async function backendJson(response) {
  try {
    return await response.json();
  } catch {
    throw new Error("BACKEND_UNREACHABLE");
  }
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

// The compatibility response carries the reviewed login URL only inside its one
// versioned config, which `recipeDigest` covers.
function versionedLoginUrl(provider) {
  const configs = provider.providerConfigs;
  const url = Array.isArray(configs) && configs.length === 1 ? configs[0]?.loginUrl : undefined;
  if (!isServableLoginUrl(url)) throw new Error("Provider login URL unavailable");
  return url;
}

export const fetchProviderData = async (providerId, session) => {
  const versionNumber = requirePinnedVersion(session?.umia?.providerVersion);
  const { backendUrl, headers } = sessionHeaders(session);
  const response = await backendFetch(
    API_ENDPOINTS.PROVIDER_URL(providerId, backendUrl, versionNumber),
    {
      redirect: "error",
      headers,
    },
  );
  if (!response.ok) {
    throw new Error("PROVIDER_UNAVAILABLE");
  }
  const data = await backendJson(response);
  if (
    !data?.providers ||
    typeof data.providers.versionNumber !== "string" ||
    data.providers.versionNumber !== versionNumber
  ) {
    throw new Error("Provider response version does not match session pin");
  }
  const provider = data.providers;
  if (
    provider.id !== providerId ||
    provider.version !== versionNumber ||
    typeof provider.recipeDigest !== "string" ||
    !SHA256_DIGEST.test(provider.recipeDigest) ||
    Object.hasOwn(provider, "loginUrl") ||
    Object.hasOwn(provider, "customInjection") ||
    Object.hasOwn(provider, "customInjectionSha256")
  ) {
    throw new Error("Pinned provider metadata rejected");
  }
  // Fail before any tab opens rather than at claim time, after login.
  pinnedGeoLocation(provider.geoLocation);
  return { provider, loginUrl: versionedLoginUrl(provider) };
};

// A failure status carries the same finite code the page receives.
export const updateSessionStatus = async (session, status, code) => {
  const { backendUrl, headers } = sessionHeaders(session, {
    "Content-Type": "application/json",
  });
  const response = await backendFetch(API_ENDPOINTS.UPDATE_SESSION_STATUS(backendUrl), {
    method: "POST",
    redirect: "error",
    headers,
    body: JSON.stringify({ sessionId: session.sessionId, status, ...(code ? { code } : {}) }),
  });

  if (!response.ok) {
    throw new Error("Failed to update session status");
  }

  const res = await backendJson(response);
  if (res?.status !== "success") throw new Error("Failed to update session status");
  return res;
};

export const postTelemetry = async (session, events) => {
  const { backendUrl, headers } = sessionHeaders(session, {
    "Content-Type": "application/json",
  });
  const response = await backendFetch(API_ENDPOINTS.TELEMETRY(backendUrl), {
    method: "POST",
    redirect: "error",
    headers,
    body: JSON.stringify({ sessionId: session.sessionId, events }),
  });
  if (response.status !== 202) throw new Error("Telemetry rejected");
};

// The private intake accepts a whole proof array only at the session-bound
// backend endpoint. Its accepted poll is authoritative; client status reports
// cannot make a proof complete.
export const submitBoundProofs = async (proofs, session) => {
  const { backendUrl, headers } = sessionHeaders(session, { "Content-Type": "text/plain" });
  if (!Array.isArray(proofs) || proofs.length < 1 || proofs.length > 64) {
    throw new Error("CONFIG_REJECTED");
  }
  let serialized;
  try {
    serialized = JSON.stringify(proofs);
  } catch {
    throw new Error("CONFIG_REJECTED");
  }
  if (new TextEncoder().encode(serialized).length > 7 * 1024 * 1024) {
    throw new Error("CONFIG_REJECTED");
  }
  const encoded = encodeURIComponent(serialized);
  if (encoded.length > 8 * 1024 * 1024) throw new Error("CONFIG_REJECTED");

  try {
    const intake = await backendFetch(
      API_ENDPOINTS.PROOF_INTAKE_URL(session.sessionId, backendUrl),
      { method: "POST", redirect: "error", headers, body: encoded },
    );
    if (intake.status !== 200 || (await backendJson(intake))?.status !== "success") {
      throw new Error("VERIFICATION_FAILED");
    }
    const accepted = await backendFetch(API_ENDPOINTS.STATUS_URL(session.sessionId, backendUrl), {
      redirect: "error",
      headers: sessionHeaders(session).headers,
    });
    if (accepted.status !== 200) throw new Error("VERIFICATION_FAILED");
    const body = await backendJson(accepted);
    if (
      body?.session?.statusV2 !== "PROOF_SUBMITTED" ||
      body.session.providerVersionString !== session.umia.providerVersion ||
      !Array.isArray(body.session.proofs) ||
      body.session.proofs.length < 1 ||
      body.session.proofs.length > 64
    ) {
      throw new Error("VERIFICATION_FAILED");
    }
    requireLiveSession(session);
    return body.session.proofs;
  } catch (error) {
    // An outage or expiry keeps its own code; any other failure is a rejection.
    throw new Error(failureCode(error, "VERIFICATION_FAILED"));
  }
};
