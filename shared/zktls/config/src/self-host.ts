export interface ZktlsAttestorAuth {
  data: {
    id: string;
    createdAt: number;
    expiresAt: number;
    hostWhitelist: string[];
  };
  signature: `0x${string}`;
}

/** The patched attestor refuses auth whose `expiresAt` is more than this after `createdAt`. */
export const ZKTLS_ATTESTOR_MAX_AUTH_LIFETIME_S = 15 * 60;

/** Unix-second attestor auth window: from now to the earliest deadline, within the attestor's maximum. */
export function zktlsAttestorAuthWindow(
  nowMs: number,
  deadlinesMs: readonly number[],
): { createdAt: number; expiresAt: number } {
  const createdAt = Math.floor(nowMs / 1000);
  const expiresAt = Math.min(
    createdAt + ZKTLS_ATTESTOR_MAX_AUTH_LIFETIME_S,
    ...deadlinesMs.map((deadline) => Math.floor(deadline / 1000)),
  );
  return { createdAt, expiresAt };
}

/** Targets accepted by the general proof-request route and browser proof controller. */
export type ZktlsAuctionOrSandboxTarget =
  | { kind: "auction"; chainId: number; auctionAddress: string }
  | { kind: "sandbox"; chainId: number };

/** All server-bound session scopes; platform credentials use their dedicated trusted route. */
export type ZktlsProofTarget =
  | ZktlsAuctionOrSandboxTarget
  | {
      kind: "platform_credential";
      chainId: number;
      domain: string;
      predicateId: string;
    };

/** The `umia` block inside the SDK's signed request; top-level sessionId is authoritative. */
export interface ZktlsSessionConfig {
  backendUrl: string;
  attestorUrl: string;
  witness: `0x${string}`;
  providerVersion: string;
  sessionToken: string;
  attestorAuth: ZktlsAttestorAuth;
  expiresAt: string;
  network: ZktlsSessionNetwork;
}

export type ZktlsEnvironment = "devnet" | "testnet" | "mainnet";

/** The devnet proof path serves Monad only; other environments keep their own chain sets. */
export const ZKTLS_DEVNET_CHAIN_ID = 10143 as const;

export interface ZktlsSessionNetwork {
  environment: ZktlsEnvironment;
  chainId: number;
  beaconAddress: `0x${string}`;
  expectedEpoch: number;
  authorityDigest: `sha256:${string}`;
}

export interface ZktlsNetworkAuthority {
  environment: ZktlsEnvironment;
  chainId: number;
  beaconAddress: `0x${string}`;
  epoch: number;
  attestorUrl: string;
  witnesses: `0x${string}`[];
  minimumWitnesses: number;
  digest: `sha256:${string}`;
}

export interface ZktlsAttestor {
  url: string;
  signerAddress: `0x${string}`;
  claimEpoch: number;
}

/** One chain an environment proves on: the zkTLS verifier that registers the shared attestor. */
export interface ZktlsChainNetwork {
  chainId: number;
  beaconAddress: `0x${string}`;
}

/** Registry snapshots keep every SDK-derivable claim hash separate from source drift. */
export interface ZktlsRegistryProvider {
  id: string;
  version: string;
  identityProvider: string;
  providerConfigs: Record<string, unknown>[];
  providerRuntime: Record<string, unknown>;
  providerType: string;
  useProxy: boolean;
  claimHashes: `0x${string}`[];
  recipeDigest: `sha256:${string}`;
  customInjectionSha256?: `sha256:${string}`;
  source: "reclaim" | "local";
  savedAt: string;
}

/** The `zktls_session_status` column enum: the only statuses a session row can hold. */
export const ZKTLS_STORED_SESSION_STATUSES = [
  "created",
  "pending",
  "proof_submitted",
  "failed",
  "cancelled",
] as const;
export type ZktlsStoredSessionStatus = (typeof ZKTLS_STORED_SESSION_STATUSES)[number];

/** Statuses the API reports. No job writes expiry, so `expired` exists only as a read projection. */
export const ZKTLS_SESSION_STATUSES = [...ZKTLS_STORED_SESSION_STATUSES, "expired"] as const;
export type ZktlsSessionStatus = (typeof ZKTLS_SESSION_STATUSES)[number];

export const ZKTLS_EVENT_TYPES = [
  "session_created",
  "page_ready",
  "permission_requested",
  "permission_granted",
  "request_captured",
  "proof_started",
  "proof_received",
  "verification_started",
  "status_update",
  "failed",
  "cancelled",
  "expired",
] as const;
export type ZktlsSessionEventType = (typeof ZKTLS_EVENT_TYPES)[number];

export const ZKTLS_ERROR_CODES = [
  "PERMISSION_DENIED",
  "TAB_CLOSED",
  "CONFIG_REJECTED",
  "BACKEND_UNREACHABLE",
  "SESSION_EXPIRED",
  "UNSUPPORTED_NETWORK",
  "PROVIDER_UNAVAILABLE",
  "REQUEST_NOT_CAPTURED",
  "CRITERIA_NOT_MET",
  "PROOF_GENERATION_FAILED",
  "PROOF_INVALID",
  "ATTESTOR_UNREACHABLE",
  "ATTESTOR_AUTH_FAILED",
  "VERIFICATION_FAILED",
  "CANCELLED",
  "UNKNOWN",
] as const;
export type ZktlsErrorCode = (typeof ZKTLS_ERROR_CODES)[number];

/** The patched attestor's `REJECTION_REASONS` keys, in table order; a drift test pins them to the patch. */
export const ZKTLS_ATTESTOR_REJECTION_REASONS = [
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "AUTH_EXPIRED",
  "HOST_LIST_INVALID",
  "TUNNEL_ID_IN_USE",
  "TUNNEL_NOT_FOUND",
  "HOST_NOT_ALLOWED",
  "PORT_NOT_ALLOWED",
  "PROXY_NOT_CONFIGURED",
  "TUNNEL_REQUEST_MISMATCH",
  "TRANSCRIPT_MISMATCH",
  "CLAIM_CONTEXT_INVALID",
  "CLAIM_CONTEXT_MESSAGE_UNSUPPORTED",
  "CLAIM_CONTEXT_CHAIN_NOT_ALLOWED",
  "CLAIM_CONTEXT_SESSION_MISMATCH",
  "CLAIM_REQUEST_INVALID",
  "CLAIM_SIGNATURE_INVALID",
  "CLAIM_TIMESTAMP_SKEW",
  "TRANSCRIPT_DECRYPT_FAILED",
  "TLS_HOST_MISMATCH",
  "PROVIDER_PARAMS_INVALID",
  "PROVIDER_VALIDATION_FAILED",
  "SIGNED_CONTEXT_INVALID",
  "CLAIM_PROVIDER_UNSUPPORTED",
  "CLAIM_PARAMS_INVALID",
  "CLAIM_URL_MISMATCH",
  "TEE_CLAIMS_DISABLED",
  "AUTH_LIFETIME_INVALID",
  "INIT_TIMEOUT",
  "CERTIFICATE_FETCH_DISABLED",
  "TOPRF_DISABLED",
  "AUTH_SOCKET_LIMIT",
  "CERTIFICATE_DISTRUSTED",
] as const;
export type ZktlsAttestorRejectionReason = (typeof ZKTLS_ATTESTOR_REJECTION_REASONS)[number];

const ATTESTOR_REJECTION_REASONS: ReadonlySet<string> = new Set(ZKTLS_ATTESTOR_REJECTION_REASONS);

/**
 * The reason in an attestor error's `data`: an object on a thrown error, JSON text in a
 * claim response's `error`. Anything outside the table is `undefined`.
 */
export function zktlsAttestorRejectionReason(
  error: unknown,
): ZktlsAttestorRejectionReason | undefined {
  let data = (error as { data?: unknown } | null | undefined)?.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return undefined;
    }
  }
  const reason = (data as { reason?: unknown } | null | undefined)?.reason;
  return typeof reason === "string" && ATTESTOR_REJECTION_REASONS.has(reason)
    ? (reason as ZktlsAttestorRejectionReason)
    : undefined;
}

/** The code the extension reports for each attestor rejection reason. */
export const ZKTLS_ATTESTOR_REJECTION_CODES: Readonly<
  Record<ZktlsAttestorRejectionReason, ZktlsErrorCode>
> = {
  CLAIM_CONTEXT_INVALID: "CONFIG_REJECTED",
  CLAIM_CONTEXT_MESSAGE_UNSUPPORTED: "CONFIG_REJECTED",
  CLAIM_CONTEXT_SESSION_MISMATCH: "CONFIG_REJECTED",
  SIGNED_CONTEXT_INVALID: "CONFIG_REJECTED",
  CLAIM_CONTEXT_CHAIN_NOT_ALLOWED: "UNSUPPORTED_NETWORK",
  AUTH_REQUIRED: "ATTESTOR_AUTH_FAILED",
  AUTH_INVALID: "ATTESTOR_AUTH_FAILED",
  HOST_LIST_INVALID: "ATTESTOR_AUTH_FAILED",
  AUTH_LIFETIME_INVALID: "ATTESTOR_AUTH_FAILED",
  // A socket that never presented auth, like AUTH_REQUIRED; the SDK sends init in the upgrade request.
  INIT_TIMEOUT: "ATTESTOR_AUTH_FAILED",
  AUTH_SOCKET_LIMIT: "ATTESTOR_AUTH_FAILED",
  AUTH_EXPIRED: "SESSION_EXPIRED",
  // Deterministic policy mismatches: a retry fails the same way.
  HOST_NOT_ALLOWED: "CONFIG_REJECTED",
  PORT_NOT_ALLOWED: "CONFIG_REJECTED",
  PROXY_NOT_CONFIGURED: "CONFIG_REJECTED",
  CLAIM_PROVIDER_UNSUPPORTED: "CONFIG_REJECTED",
  CLAIM_PARAMS_INVALID: "CONFIG_REJECTED",
  CLAIM_URL_MISMATCH: "CONFIG_REJECTED",
  PROVIDER_PARAMS_INVALID: "CONFIG_REJECTED",
  TEE_CLAIMS_DISABLED: "CONFIG_REJECTED",
  CERTIFICATE_FETCH_DISABLED: "CONFIG_REJECTED",
  TOPRF_DISABLED: "CONFIG_REJECTED",
  // A provider chain under a compromised or distrusted CA; the host must change its chain.
  CERTIFICATE_DISTRUSTED: "CONFIG_REJECTED",
  TUNNEL_ID_IN_USE: "PROOF_GENERATION_FAILED",
  TUNNEL_NOT_FOUND: "PROOF_GENERATION_FAILED",
  TUNNEL_REQUEST_MISMATCH: "PROOF_GENERATION_FAILED",
  TRANSCRIPT_MISMATCH: "PROOF_GENERATION_FAILED",
  CLAIM_REQUEST_INVALID: "PROOF_GENERATION_FAILED",
  CLAIM_SIGNATURE_INVALID: "PROOF_GENERATION_FAILED",
  CLAIM_TIMESTAMP_SKEW: "PROOF_GENERATION_FAILED",
  TRANSCRIPT_DECRYPT_FAILED: "PROOF_GENERATION_FAILED",
  TLS_HOST_MISMATCH: "PROOF_GENERATION_FAILED",
  // Usually an account that fails the recipe's matches; a changed site looks the same for now.
  PROVIDER_VALIDATION_FAILED: "PROOF_INVALID",
};

export const ZKTLS_EVENT_SOURCES = ["api", "extension", "hub"] as const;
export type ZktlsEventSource = (typeof ZKTLS_EVENT_SOURCES)[number];

/** Only typed, bounded diagnostic fields may be persisted; raw messages are excluded. */
export interface ZktlsEventData {
  eventType?: string;
  stage?: string;
  elapsedMs?: number;
  proofCount?: number;
  proofBytes?: number;
  clientEnv?: string;
  sdkVersion?: string;
  extensionVersion?: string;
  status?: ZktlsSessionStatus;
}

export interface ZktlsSessionEvent {
  seq: number;
  at: string;
  source: ZktlsEventSource;
  type: ZktlsSessionEventType;
  code?: ZktlsErrorCode;
  data?: ZktlsEventData;
}

/** The only breadcrumb stages the legacy `/debug` beacon may log; the API drops any other stage. */
export const ZKTLS_DEBUG_STAGES = [
  "verify:start",
  "verify:no-extension",
  "verify:cancelled",
  "verify:failed",
  "extension:checked",
  "proofRequest:fetched",
  "sdk:cancelled",
  "sdk:cancel:failed",
  "sdk:waiting",
  "sdk:event",
  "sdk:completed",
  "sdk:error",
  "sdk:timeout",
  "sdk:startVerification:called",
  "sdk:startVerification:resolved",
  "sdk:startVerification:rejected",
  "submit:skipped",
  "submit:start",
  "submit:ok",
  "submit:account-in-use",
  "submit:wallet-mismatch",
  "submit:failed",
] as const;

export interface ZktlsTelemetryBatch {
  sessionId: string;
  attemptId?: string;
  events: Array<Pick<ZktlsSessionEvent, "type" | "code" | "data">>;
}

export interface ZktlsSessionEventsResponse {
  status: ZktlsSessionStatus;
  code?: ZktlsErrorCode;
  provider: { id: string; version: string };
  attemptId?: string;
  createdAt: string;
  updatedAt: string;
  events: ZktlsSessionEvent[];
  nextAfter: number;
}

/** The one attestor every environment shares. The extension trusts only this URL, signer and epoch. */
export const ZKTLS_SHARED_ATTESTOR = {
  url: "wss://attestor.zktls.umia.finance/ws",
  signerAddress: "0xf9daa02c2f0557a8d883ffe6f86b14643c29f7b4",
  claimEpoch: 2,
} as const satisfies ZktlsAttestor;

/** The chains each environment proves on. The API serves these; the attestor signs for all of them. */
export const ZKTLS_NETWORKS: Record<ZktlsEnvironment, readonly ZktlsChainNetwork[]> = {
  devnet: [
    { chainId: ZKTLS_DEVNET_CHAIN_ID, beaconAddress: "0xebb5c8bb83ac16dee0bd37d9896ad434161e9319" },
  ],
  testnet: [
    { chainId: 8453, beaconAddress: "0x8eaea725510d2dc99e030583921d67752ca2c02b" },
    { chainId: 10143, beaconAddress: "0xc0e47ef1470a4273b1ce940add0305639f2c8e0b" },
    { chainId: 46630, beaconAddress: "0x42a9d10acb13eeb8147f92d1857105e8b1e8d388" },
    { chainId: 84532, beaconAddress: "0x4330f379feca99e4f3ac1f398b628834c227ab85" },
  ],
  mainnet: [
    { chainId: 4663, beaconAddress: "0xabbfa7b430d51b11fd91a677635cb6d401f0b5a9" },
    { chainId: 8453, beaconAddress: "0x63e2a4d4b61eb12e40930e01fd2af451b9382797" },
  ],
};

/** The session's pin to an authority: what the API stores and the extension checks. */
export function zktlsSessionNetwork(authority: ZktlsNetworkAuthority): ZktlsSessionNetwork {
  return {
    environment: authority.environment,
    chainId: authority.chainId,
    beaconAddress: authority.beaconAddress,
    expectedEpoch: authority.epoch,
    authorityDigest: authority.digest,
  };
}

/** Every chain the shared attestor signs claims for, ascending. */
export function zktlsClaimChainIds(): number[] {
  return [
    ...new Set(Object.values(ZKTLS_NETWORKS).flatMap((chains) => chains.map((c) => c.chainId))),
  ].sort((a, b) => a - b);
}

/** Every Umia app origin the extension serves; each API serves the one named by ZKTLS_ENDPOINT_PROFILE.
 * Literal rows keep the list tree-shakeable; every consumer checks attestorUrl is the shared one. */
export const ZKTLS_EXTENSION_ORIGIN_ALLOWLIST = [
  {
    profile: "cloud-devnet",
    environment: "devnet",
    callerOrigin: "https://hub.umia.conductor:8443",
    backendUrl: "https://api.umia.conductor:8443/zktls",
    attestorUrl: "wss://attestor.zktls.umia.finance/ws",
  },
  {
    profile: "native-devnet",
    environment: "devnet",
    callerOrigin: "https://hub.umia.localhost",
    backendUrl: "https://api.umia.localhost/zktls",
    attestorUrl: "wss://attestor.zktls.umia.finance/ws",
  },
  {
    profile: "hosted-devnet",
    environment: "devnet",
    callerOrigin: "https://app.devnet.umia.finance",
    backendUrl: "https://api.devnet.umia.finance/zktls",
    attestorUrl: "wss://attestor.zktls.umia.finance/ws",
  },
  {
    profile: "hosted-testnet",
    environment: "testnet",
    callerOrigin: "https://app.testnet.umia.finance",
    backendUrl: "https://api.testnet.umia.finance/zktls",
    attestorUrl: "wss://attestor.zktls.umia.finance/ws",
  },
  {
    profile: "cloud-testnet",
    environment: "testnet",
    callerOrigin: "https://hub.umia.conductor:8443",
    backendUrl: "https://api.umia.conductor:8443/zktls",
    attestorUrl: "wss://attestor.zktls.umia.finance/ws",
  },
  {
    profile: "mainnet",
    environment: "mainnet",
    callerOrigin: "https://app.umia.finance",
    backendUrl: "https://api.mainnet.umia.finance/zktls",
    attestorUrl: "wss://attestor.zktls.umia.finance/ws",
  },
] as const;

export type ZktlsEndpointProfileName = (typeof ZKTLS_EXTENSION_ORIGIN_ALLOWLIST)[number]["profile"];

type ZktlsEndpointProfile = (typeof ZKTLS_EXTENSION_ORIGIN_ALLOWLIST)[number];

/** The structural row for a known profile name; every name has exactly one row. */
export function zktlsEndpointProfile<P extends ZktlsEndpointProfileName>(
  profile: P,
): Extract<ZktlsEndpointProfile, { profile: P }> {
  return ZKTLS_EXTENSION_ORIGIN_ALLOWLIST.find((row) => row.profile === profile) as Extract<
    ZktlsEndpointProfile,
    { profile: P }
  >;
}

/**
 * Whether a recipe's named capture can become a signed `extractedParameters` key. The attestor's
 * claim-context policy carries a copy, and shared test vectors pin both.
 */
export function isAttestableExtractionKey(name: unknown): name is string {
  return typeof name === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(name);
}

/** A Reclaim release a local recipe may derive from; prereleases never derive. */
export const ZKTLS_UPSTREAM_RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * A local recipe derived from the exact Reclaim version `x.y.z` is saved as `x.y.z-umia.N`,
 * N a canonical 1..999999, so `-umia.01` never aliases `-umia.1`. Literals, not `new RegExp`, so
 * bundles that do not use them drop them; its base group is ZKTLS_UPSTREAM_RELEASE_VERSION.
 */
export const ZKTLS_LOCAL_RECIPE_VERSION = /^(\d+\.\d+\.\d+)-umia\.([1-9]\d{0,5})$/;

/** The derivation revision N when `version` derives from `fromVersion`, else null. */
export function zktlsLocalRecipeRevision(version: string, fromVersion: string): number | null {
  const match = ZKTLS_LOCAL_RECIPE_VERSION.exec(version);
  return match && match[1] === fromVersion ? Number(match[2]) : null;
}

/** One saved registry row, as far as pin resolution needs it. */
export interface ZktlsRegistryPin {
  id: string;
  version: string;
  source: "reclaim" | "local";
}

/**
 * The saved version a canonical pin runs: the exact pin, else its newest local derivation
 * (`<pin>-umia.N`, same claim hashes). Null when neither is saved; never another base.
 */
export function resolveZktlsRegistryPin(
  saved: readonly ZktlsRegistryPin[],
  pin: { id: string; version: string },
): string | null {
  if (saved.some((p) => p.id === pin.id && p.version === pin.version)) return pin.version;
  let best: { version: string; revision: number } | null = null;
  for (const p of saved) {
    if (p.id !== pin.id || p.source !== "local") continue;
    const revision = zktlsLocalRecipeRevision(p.version, pin.version);
    if (revision !== null && (!best || revision > best.revision)) {
      best = { version: p.version, revision };
    }
  }
  return best?.version ?? null;
}
