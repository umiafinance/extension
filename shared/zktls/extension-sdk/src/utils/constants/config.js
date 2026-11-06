/**
 * SDK Configuration Constants
 *
 * Centralized timeouts, intervals, and limits used across the SDK.
 * Adjust these values to tune performance and behavior.
 */

// --- Proof Generation ---

/**
 * ZK engine used when a provider doesn't specify one in
 * `extensionConfig.zkEngine`.
 *
 * This must be an engine the pinned attestor-core's **prebuilt browser bundle**
 * actually registers a ZK operator maker for, otherwise proof generation dies in
 * the offscreen document with "No ZK operator maker for <engine>". The bundle is
 * a checked-in artifact upstream and its engine support has silently changed
 * between patch releases — see attestor-zk-engine.test.js, which guards this.
 *
 * The verified Stwo operator is the safe default for eligibility proofs.
 * snarkjs remains available only when a caller selects it explicitly.
 */
export const DEFAULT_ZK_ENGINE = "stwo";

/** Set ZK_WORKER_POOL_SIZE=0..4 at build time for either proof engine. */
const requestedWorkers = Number(process.env.ZK_WORKER_POOL_SIZE);
export const ZK_WORKER_POOL_SIZE =
  process.env.ZK_WORKER_POOL_SIZE !== "" &&
  Number.isInteger(requestedWorkers) &&
  requestedWorkers >= 0
    ? Math.min(requestedWorkers, 4)
    : Math.min(typeof navigator === "undefined" ? 4 : navigator.hardwareConcurrency || 4, 4);

/** Set STWO_PROOF_COMPRESSION=0 at build time for an uncompressed baseline. */
export const STWO_PROOF_COMPRESSION = process.env.STWO_PROOF_COMPRESSION !== "0";

/**
 * Max time for attestor proof generation in offscreen document (ms).
 *
 * This is the real proof budget: offscreen.js races `createClaimOnAttestor`
 * against it.
 */
export const PROOF_GENERATION_TIMEOUT_MS = 120000; // 2 minutes

/**
 * Max time the background waits for the offscreen document's response (ms).
 *
 * **Must stay strictly greater than PROOF_GENERATION_TIMEOUT_MS**, hence the
 * derivation rather than a literal: otherwise the background kills a proof the
 * offscreen document is still working on, and the offscreen's own, more
 * specific timeout never surfaces.
 *
 * The headroom covers the PROOF_GENERATION_FAILED `updateSessionStatus` POST
 * the offscreen makes on its way out, plus the chrome-messaging hop. This
 * timeout is only a backstop for an offscreen document that died without
 * answering at all.
 */
export const PROOF_RESPONSE_TIMEOUT_MS = PROOF_GENERATION_TIMEOUT_MS + 15000; // 2m15s

/** Max time waiting for private key generation from offscreen (ms) */
export const PRIVATE_KEY_TIMEOUT_MS = 10000; // 10 seconds

// --- Offscreen Document ---

/** Default timeout waiting for offscreen document readiness (ms) */
export const OFFSCREEN_READY_TIMEOUT_MS = 15000; // 15 seconds

/** Timeout when offscreen context exists but not yet ready (ms) */
export const OFFSCREEN_CONTEXT_EXISTS_TIMEOUT_MS = 5000; // 5 seconds

/** Final timeout for offscreen document initialization (ms) */
export const OFFSCREEN_FINAL_INIT_TIMEOUT_MS = 50000; // 50 seconds

// --- Session & Verification ---

/** Session inactivity timeout — fails if no proof generated within this window (ms) */
export const SESSION_TIMER_DURATION_MS = 30000; // 30 seconds

/** Max time for network request filtering before giving up (ms) */
export const NETWORK_FILTERING_TIMEOUT_MS = 600000; // 10 minutes

/** Interval for checking intercepted network requests (ms) */
export const NETWORK_FILTERING_INTERVAL_MS = 1000; // 1 second

/** Max age for intercepted request/response data before cleanup (ms) */
export const INTERCEPTED_DATA_MAX_AGE_MS = 120000; // 2 minutes
export const INTERCEPTED_DATA_MAX_ENTRIES = 32;
export const INTERCEPTED_DATA_MAX_ENTRY_CHARS = 1024 * 1024;

/** Wait between document-replay attempts while the page-world interceptor loads (ms) */
export const REPLAY_READY_RETRY_MS = 500;

/** Document-replay attempts before giving up on an interceptor that never loads */
export const REPLAY_READY_RETRIES = 6;

/** Delay before switching tabs after verification completes (ms) */
export const TAB_TRANSITION_DELAY_MS = 3000; // 3 seconds
