import {
  ZKTLS_DEVNET_CHAIN_ID,
  ZKTLS_EXTENSION_ORIGIN_ALLOWLIST,
  ZKTLS_SHARED_ATTESTOR,
} from "@umia/zktls-config/self-host";
import { freezeBoundSession, freezeSessionRoute } from "./session-transport.js";

const ADDRESS = /^0x[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const SESSION_TOKEN = /^[0-9a-f]{64}$/;
const IDENTITY_PROVIDER = /^[a-z][a-z0-9_]{0,63}$/;
const CLAIM_HASH = /^0x[0-9a-f]{64}$/;
const NETWORK_FIELDS = ["authorityDigest", "beaconAddress", "chainId", "environment", "expectedEpoch"].join();

function authIdMatchesSession(id, sessionId) {
  if (id === sessionId) return true; // Existing session fixtures and older clients.
  if (typeof id !== "string") return false;
  const [version, boundSession, namespace, hashes, scope, extra] = id.split(":");
  return (
    extra === undefined &&
    version === "umia1" &&
    boundSession === sessionId &&
    IDENTITY_PROVIDER.test(namespace ?? "") &&
    typeof hashes === "string" &&
    hashes.split(",").every((hash) => CLAIM_HASH.test(hash)) &&
    /^[0-9a-f]{64}$/.test(scope ?? "")
  );
}

function canonicalSignedHost(host) {
  if (typeof host !== "string" || host.length > 253) return false;
  const labels = host.split(".");
  if (
    labels.length < 2 ||
    !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    ["local", "internal", "localhost"].includes(labels.at(-1)) ||
    /^[0-9.]+$/.test(host)
  ) {
    return false;
  }
  try {
    return new URL(`https://${host}`).hostname === host;
  } catch {
    return false;
  }
}

// The signed fields the attestor checks, bounded by every expiry the session carries.
function checkAttestorAuth(auth, sessionId, ...expiriesMs) {
  if (
    !auth?.data ||
    !authIdMatchesSession(auth.data.id, sessionId) ||
    !Number.isInteger(auth.data.createdAt) ||
    auth.data.createdAt < 0 ||
    !Number.isInteger(auth.data.expiresAt) ||
    auth.data.expiresAt > 4294967295 ||
    auth.data.createdAt >= auth.data.expiresAt ||
    expiriesMs.some((expiry) => auth.data.expiresAt * 1000 > expiry) ||
    auth.data.expiresAt * 1000 <= Date.now() ||
    !Array.isArray(auth.data.hostWhitelist) ||
    auth.data.hostWhitelist.length === 0 ||
    !auth.data.hostWhitelist.every(canonicalSignedHost) ||
    !SIGNATURE.test(auth.signature)
  ) {
    throw new Error("Invalid attestor authorization");
  }
  return auth;
}

function exactUrl(value, expected, kind) {
  if (typeof value !== "string" || /[%\\?#]|\/\.{1,2}(?:\/|$)/.test(value)) {
    throw new Error(`Invalid ${kind} URL`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${kind} URL`);
  }
  const approved = new URL(expected);
  if (url.username || url.password || url.search || url.hash)
    throw new Error(`Invalid ${kind} URL`);
  if (url.href !== approved.href) throw new Error(`Unapproved ${kind} URL`);
  return url;
}

function callerOrigin(sender) {
  const source = sender?.url || sender?.origin;
  // Chrome retains an OAuth callback's document URL after history.replaceState clears
  // the address bar. Query/fragment data does not change the caller's trusted origin.
  if (
    typeof source !== "string" ||
    /[%\\]|\/\.{1,2}(?:\/|$)/.test(source.split(/[?#]/, 1)[0])
  ) {
    throw new Error("Invalid caller URL");
  }
  let url;
  try {
    url = new URL(source);
  } catch {
    throw new Error("Invalid caller URL");
  }
  if (url.username || url.password) throw new Error("Invalid caller URL");
  if (sender?.origin) {
    if (typeof sender.origin !== "string" || /[%\\?#]/.test(sender.origin)) {
      throw new Error("Invalid caller origin");
    }
    let declared;
    try {
      declared = new URL(sender.origin);
    } catch {
      throw new Error("Invalid caller origin");
    }
    if (
      declared.username ||
      declared.password ||
      declared.pathname !== "/" ||
      declared.origin !== url.origin
    ) {
      throw new Error("Caller origin mismatch");
    }
  }
  return url.origin;
}

// The extension narrows this to the profiles its build serves before any session starts.
let approvedProfiles = ZKTLS_EXTENSION_ORIGIN_ALLOWLIST;

export function approveProfiles(names) {
  const selected = ZKTLS_EXTENSION_ORIGIN_ALLOWLIST.filter((entry) =>
    names.includes(entry.profile),
  );
  if (selected.length === 0 || selected.length !== new Set(names).size) {
    throw new Error("Unknown endpoint profile");
  }
  approvedProfiles = Object.freeze(selected);
}

export function approvedProfileNames() {
  return approvedProfiles.map((entry) => entry.profile);
}

function matchingProfile(selectedProfile, profiles) {
  const profile = profiles.find((entry) => entry.profile === selectedProfile);
  if (!profile) throw new Error("Endpoint profile is not configured");
  return profile;
}

export function requireSessionToken(value) {
  if (typeof value !== "string" || !SESSION_TOKEN.test(value)) {
    throw new Error("Invalid session token");
  }
  return value;
}

export function approvedBackendUrl(value, profiles = approvedProfiles) {
  for (const profile of profiles) {
    try {
      exactUrl(value, profile.backendUrl, "backend");
      return profile.backendUrl;
    } catch {}
  }
  throw new Error("Unapproved backend destination");
}

export async function authorizeStart(
  request,
  sender,
  profiles = approvedProfiles,
  attestor = ZKTLS_SHARED_ATTESTOR,
) {
  if (
    typeof request?.sessionId !== "string" ||
    !request.sessionId ||
    request.sessionId.length > 256
  ) {
    throw new Error("Invalid top-level session ID");
  }
  if (sender?.frameId !== 0 || !Number.isInteger(sender?.tab?.id) || sender.tab.id < 0) {
    throw new Error("Verification must start in the caller top frame");
  }
  const extensionId = globalThis.chrome?.runtime?.id;
  if (extensionId && sender.id !== extensionId) {
    throw new Error("Wrong extension sender");
  }
  const origin = callerOrigin(sender);
  if (!profiles.some((profile) => profile.callerOrigin === origin)) {
    throw new Error("Caller is not approved");
  }
  // One caller origin can serve several environments; the session's network picks one.
  const matches = profiles.filter(
    (profile) =>
      profile.callerOrigin === origin &&
      profile.backendUrl === request.umia?.backendUrl &&
      profile.attestorUrl === attestor.url &&
      profile.environment === request.umia?.network?.environment,
  );
  if (matches.length !== 1) throw new Error("Session route is not provisioned");
  const [profile] = matches;
  const umia = validateSessionConfig(request, sender, profile, attestor);
  const route = freezeSessionRoute({
    profile: profile.profile,
    callerOrigin: profile.callerOrigin,
    backendUrl: profile.backendUrl,
    attestorUrl: attestor.url,
    witness: attestor.signerAddress,
    network: umia.network,
  });
  const bound = freezeBoundSession({ sessionId: request.sessionId, umia, route });
  // The auth must also end before the session; fail now, not after provider login.
  requireAttestorAuth(bound);
  return bound;
}

// The bound session stops working once its signed auth or its own expiry lapses.
export function boundSessionDeadline({ umia }) {
  return Math.min(umia.attestorAuth.data.expiresAt * 1000, Date.parse(umia.expiresAt));
}

export function requireLiveSession(session) {
  const { sessionId, umia, route } = session ?? {};
  if (
    typeof sessionId !== "string" ||
    !sessionId ||
    !authIdMatchesSession(umia?.attestorAuth?.data?.id, sessionId) ||
    !route?.network
  ) {
    throw new Error("Bound session route mismatch");
  }
  const sessionExpiry = Date.parse(umia.expiresAt);
  const authExpiry = umia.attestorAuth.data.expiresAt;
  if (
    !Number.isFinite(sessionExpiry) ||
    !Number.isInteger(authExpiry) ||
    sessionExpiry <= Date.now() ||
    authExpiry * 1000 <= Date.now()
  ) {
    throw new Error("SESSION_EXPIRED");
  }
  return session;
}

// Recheck the exact signed fields at client construction and before socket use.
// The auth may expire sooner than the session.
export function requireAttestorAuth(session) {
  requireLiveSession(session);
  const { sessionId, umia } = session;
  return checkAttestorAuth(umia.attestorAuth, sessionId, Date.parse(umia.expiresAt));
}

export function validateCaller(
  sender,
  selectedProfile,
  profiles = approvedProfiles,
) {
  const profile = matchingProfile(selectedProfile, profiles);
  if (callerOrigin(sender) !== profile.callerOrigin) throw new Error("Caller is not approved");
  return profile;
}

// The extension trusts only the shared attestor; the API's network reference must name it.
export function validateSessionConfig(request, sender, profile, attestor = ZKTLS_SHARED_ATTESTOR) {
  if (callerOrigin(sender) !== profile.callerOrigin) throw new Error("Caller is not approved");
  const umia = request?.umia;
  if (!umia || typeof umia !== "object" || Array.isArray(umia)) {
    throw new Error("Bound session configuration is required");
  }
  if (typeof request.sessionId !== "string" || !request.sessionId || umia.sessionId !== undefined) {
    throw new Error("Invalid top-level session ID");
  }
  if (typeof request.providerId !== "string" || !request.providerId) {
    throw new Error("Invalid provider ID");
  }
  const network = umia.network;
  if (
    !network ||
    typeof network !== "object" ||
    Array.isArray(network) ||
    Object.keys(network).sort().join() !== NETWORK_FIELDS
  ) {
    throw new Error("Session network is required");
  }
  if (network.environment === "devnet" && network.chainId !== ZKTLS_DEVNET_CHAIN_ID) {
    throw new Error("UNSUPPORTED_NETWORK");
  }
  if (
    network.environment !== profile.environment ||
    !Number.isSafeInteger(network.chainId) ||
    network.chainId < 1 ||
    !ADDRESS.test(network.beaconAddress) ||
    network.expectedEpoch !== attestor.claimEpoch ||
    !DIGEST.test(network.authorityDigest) ||
    umia.witness !== attestor.signerAddress
  ) {
    throw new Error("Session network authority mismatch");
  }
  exactUrl(umia.backendUrl, profile.backendUrl, "backend");
  exactUrl(umia.attestorUrl, attestor.url, "attestor");
  requireSessionToken(umia.sessionToken);
  const expiresAt = Date.parse(umia.expiresAt);
  if (
    typeof umia.expiresAt !== "string" ||
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== umia.expiresAt
  )
    throw new Error("Session expiry invalid");
  if (expiresAt <= Date.now()) throw new Error("SESSION_EXPIRED");
  checkAttestorAuth(umia.attestorAuth, request.sessionId, expiresAt);
  return structuredClone(umia);
}
