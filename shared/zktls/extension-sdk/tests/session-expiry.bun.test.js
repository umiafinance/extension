import assert from "node:assert/strict";
import { test } from "bun:test";
import { ZKTLS_EXTENSION_ORIGIN_ALLOWLIST } from "@umia/zktls-config/self-host";
import {
  MESSAGE_ACTIONS,
  MESSAGE_SOURCES,
  RECLAIM_SESSION_STATUS,
} from "../src/utils/constants/interfaces.js";
import { TAB_TRANSITION_DELAY_MS } from "../src/utils/constants/config.js";
import { EVENT_TYPES } from "../src/utils/logger/constants.js";

const profile = ZKTLS_EXTENSION_ORIGIN_ALLOWLIST[0];
const LIFETIME_MS = 150;
const PAST_DEADLINE_MS = 300;

function bound(id, lifetimeMs) {
  const now = Date.now();
  const second = Math.floor(now / 1000);
  return {
    sessionId: id,
    route: {
      profile: profile.profile,
      callerOrigin: profile.callerOrigin,
      backendUrl: profile.backendUrl,
      attestorUrl: profile.attestorUrl,
      network: {},
    },
    umia: {
      sessionToken: "a".repeat(64),
      expiresAt: new Date(now + lifetimeMs).toISOString(),
      attestorAuth: {
        data: {
          id,
          createdAt: second - 1,
          expiresAt: second + 300,
          hostWhitelist: ["fixture.example"],
        },
        signature: `0x${"d".repeat(130)}`,
      },
    },
  };
}

const sent = [];
const tabs = { activated: [], removed: [] };
globalThis.window = globalThis.window || globalThis;
globalThis.chrome = {
  runtime: {
    id: "test-extension",
    sendMessage: async (message) => {
      sent.push({ runtime: true, message });
      return {};
    },
  },
  tabs: {
    create: (_props, callback) => callback({ id: 85 }),
    get: async () => ({ url: `${profile.callerOrigin}/auction/1` }),
    sendMessage: async (tabId, message) => {
      sent.push({ tabId, message });
      return {};
    },
    update: async (tabId) => tabs.activated.push(tabId),
    remove: async (tabId) => tabs.removed.push(tabId),
  },
  storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
};
const { cancelSession, failSession, startVerification, submitProofs } =
  await import("../src/background/sessionManager.js");
const { addToProofGenerationQueue } = await import("../src/background/proofQueue.js");
const { SessionTimerManager } = await import("../src/utils/session-timer.js");

function context() {
  const ctx = {
    MESSAGE_ACTIONS,
    MESSAGE_SOURCES,
    RECLAIM_SESSION_STATUS,
    EVENT_TYPES,
    loggingHub: { info() {}, error() {}, debug() {}, warn() {} },
    managedTabs: new Set(),
    originalTabId: 42,
    sessionTimerManager: new SessionTimerManager(),
    statuses: [],
    closed: [],
    fetchProviderData: async () => ({
      provider: { id: "provider-one", requestData: [] },
      loginUrl: "https://fixture.example/login",
    }),
    updateSessionStatus: async (_session, status) => ctx.statuses.push(status),
    closeBoundSession: async (id) => ctx.closed.push(id),
    formatProof: () => ({ claim: { identifier: "local" } }),
    submitBoundProofs: async () => [{ claim: { identifier: "accepted" } }],
  };
  ctx.failSession = (...args) => failSession(ctx, ...args);
  return ctx;
}

async function start(ctx, id, lifetimeMs = LIFETIME_MS) {
  ctx.activeSessionId = id;
  ctx.initiatingSender = { sessionId: id, tabId: 42, documentId: "caller-document" };
  await startVerification(ctx, {
    sessionId: id,
    providerId: "provider-one",
    session: bound(id, lifetimeMs),
  });
}

function failures(code) {
  return sent.filter(
    ({ message }) =>
      message.action === MESSAGE_ACTIONS.PROOF_GENERATION_FAILED &&
      (code === undefined || message.data?.error === code),
  );
}

function failedStatuses(ctx) {
  return ctx.statuses.filter((status) => status === RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED);
}

// failSession sends exactly one failure to the provider tab and one to the caller tab.
function assertFailedOnce(ctx, id, code) {
  assert.deepEqual(
    failures().map(({ tabId, message }) => [tabId, message.data.error]),
    [
      [85, code],
      [42, code],
    ],
  );
  assert.equal(failedStatuses(ctx).length, 1);
  assert.deepEqual(ctx.closed, [id]);
}

function reset() {
  sent.length = 0;
  tabs.activated.length = 0;
  tabs.removed.length = 0;
}

test("an idle bound session is torn down exactly once at its deadline", async () => {
  reset();
  const ctx = context();
  await start(ctx, "expiring");
  await Bun.sleep(PAST_DEADLINE_MS);
  assertFailedOnce(ctx, "expiring", "SESSION_EXPIRED");
  assert.equal(ctx.activeSessionId, null);
  await Bun.sleep(TAB_TRANSITION_DELAY_MS + 100);
  assert.deepEqual(tabs.activated, [42]);
  assert.deepEqual(tabs.removed, [85]);
});

test("the offscreen self-close and the background timer report SESSION_EXPIRED once, in either order", async () => {
  for (const offscreenReplyAfterMs of [LIFETIME_MS + 100, LIFETIME_MS - 60]) {
    reset();
    const ctx = context();
    await start(ctx, "racing");
    ctx.generateProof = () =>
      Bun.sleep(offscreenReplyAfterMs).then(() => ({ success: false, error: "SESSION_EXPIRED" }));
    addToProofGenerationQueue(ctx, { session: { sessionId: "racing" } }, "request-one");
    await Bun.sleep(LIFETIME_MS + PAST_DEADLINE_MS);
    assertFailedOnce(ctx, "racing", "SESSION_EXPIRED");
  }
});

test("failing, submitting, cancelling or replacing a session clears its expiry timer", async () => {
  reset();
  const failed = context();
  await start(failed, "failed");
  await failSession(failed, "TAB_CLOSED");

  const submitted = context();
  await start(submitted, "submitted");
  submitted.generatedProofs.set("request-one", { claim: { identifier: "local" } });
  assert.deepEqual(await submitProofs(submitted), { success: true });

  const cancelled = context();
  await start(cancelled, "cancelled");
  await cancelSession(cancelled, "cancelled");

  const replaced = context();
  await start(replaced, "old");
  const oldExpiry = replaced.sessionTimerManager.cancelExpiry;
  await start(replaced, "new", 600_000);

  // The guard in expireSession would hide a leaked timer, so check the timers themselves.
  for (const ctx of [failed, submitted, cancelled]) {
    assert.equal(ctx.sessionTimerManager.cancelExpiry, null);
  }
  assert.notEqual(replaced.sessionTimerManager.cancelExpiry, oldExpiry);

  await Bun.sleep(PAST_DEADLINE_MS);
  assert.deepEqual(failures("SESSION_EXPIRED"), []);
  assert.deepEqual(
    failures().map(({ message }) => message.data.error),
    ["TAB_CLOSED", "TAB_CLOSED", "CANCELLED", "CANCELLED"],
  );
  assert.deepEqual(failed.closed, ["failed"]);
  assert.equal(failedStatuses(failed).length, 1);
  assert.deepEqual(submitted.closed, ["submitted"]);
  assert.equal(failedStatuses(submitted).length, 0);
  assert.deepEqual(cancelled.closed, ["cancelled"]);
  assert.deepEqual(replaced.closed, []);
  assert.equal(replaced.activeSessionId, "new");
  replaced.sessionTimerManager.clearAllTimers();
});

test("the expiry timer survives every proof-timer call and ends only with clearExpiryTimer", async () => {
  const manager = new SessionTimerManager();
  let fired = 0;
  manager.startExpiryTimer(Date.now() + 80, () => fired++);
  manager.startSessionTimer();
  manager.pauseSessionTimer();
  manager.resumeSessionTimer();
  manager.resetSessionTimer();
  manager.clearSessionTimer();
  manager.clearAllTimers();
  await Bun.sleep(150);
  assert.equal(fired, 1);

  manager.startExpiryTimer(Date.now() + 80, () => fired++);
  manager.clearExpiryTimer();
  await Bun.sleep(150);
  assert.equal(fired, 1);
});

const REQUEST_ONE = `0x${"1".repeat(64)}`;

test("a session idle after its first of two proofs still expires at its deadline", async () => {
  reset();
  const ctx = context();
  ctx.fetchProviderData = async () => ({
    provider: {
      id: "provider-one",
      requestData: [{ requestHash: REQUEST_ONE }, { requestHash: `0x${"2".repeat(64)}` }],
    },
    loginUrl: "https://fixture.example/login",
  });
  ctx.generateProof = async () => ({ success: true, proof: { claim: {} } });
  ctx.claimProgress = () => ({});
  await start(ctx, "half-done");
  addToProofGenerationQueue(ctx, { session: { sessionId: "half-done" } }, REQUEST_ONE);
  await Bun.sleep(PAST_DEADLINE_MS);
  assert.equal(ctx.generatedProofs.size, 1);
  assertFailedOnce(ctx, "half-done", "SESSION_EXPIRED");
});

test("a claim queued behind another proof generates without the session timer running", async () => {
  reset();
  const ctx = context();
  const requestTwo = `0x${"2".repeat(64)}`;
  ctx.fetchProviderData = async () => ({
    provider: {
      id: "provider-one",
      requestData: [{ requestHash: REQUEST_ONE }, { requestHash: requestTwo }],
    },
    loginUrl: "https://fixture.example/login",
  });
  ctx.generateProof = () => Bun.sleep(120).then(() => ({ success: true, proof: { claim: {} } }));
  ctx.claimProgress = () => ({});
  ctx.submitProofs = () => submitProofs(ctx);
  ctx.sessionTimerManager.setTimerDuration(50);
  ctx.sessionTimerManager.setCallbacks(() => ctx.failSession("REQUEST_NOT_CAPTURED"));
  await start(ctx, "queued", 600_000);
  // Both requests of one signed-in page arrive together, as a replay of every entry sends them.
  ctx.sessionTimerManager.startSessionTimer();
  addToProofGenerationQueue(ctx, { session: { sessionId: "queued" } }, REQUEST_ONE);
  addToProofGenerationQueue(ctx, { session: { sessionId: "queued" } }, requestTwo);
  const submitted = () =>
    sent.some(
      ({ tabId, message }) => tabId === 42 && message.action === MESSAGE_ACTIONS.PROOF_SUBMITTED,
    );
  for (let waited = 0; waited < 5_000 && !submitted() && !failures().length; waited += 20) {
    await Bun.sleep(20);
  }
  assert.deepEqual(failures(), []);
  assert.equal(ctx.generatedProofs.size, 2);
  assert.ok(
    sent.some(
      ({ tabId, message }) => tabId === 42 && message.action === MESSAGE_ACTIONS.PROOF_SUBMITTED,
    ),
  );
});

test("a late failure after a session ended sends no second terminal event", async () => {
  reset();
  const ctx = context();
  await start(ctx, "ended", 600_000);
  await failSession(ctx, "TAB_CLOSED");
  await failSession(ctx, "PROOF_GENERATION_FAILED", "request-one");
  ctx.sessionTimerManager.onSessionTimeout?.();
  assertFailedOnce(ctx, "ended", "TAB_CLOSED");
});

test("a fetched recipe without stored request hashes is keyed before any context reads it", async () => {
  reset();
  const ctx = context();
  const entry = { url: "https://fixture.example/api/account", method: "GET" };
  ctx.fetchProviderData = async () => ({
    provider: { id: "provider-one", requestData: [entry], allowedInjectedRequestData: [entry] },
    loginUrl: "https://fixture.example/login",
  });
  await start(ctx, "keyed", 600_000);
  assert.deepEqual(
    [...ctx.providerData.requestData, ...ctx.providerData.allowedInjectedRequestData].map(
      (keyed) => keyed.requestHash,
    ),
    ["requestData[0]", "allowedInjectedRequestData[0]"],
  );
  await failSession(ctx, "CANCELLED");
});
