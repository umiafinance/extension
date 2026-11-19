import assert from "node:assert/strict";
import { jest, mock, test } from "bun:test";
import {
  ZKTLS_ATTESTOR_REJECTION_REASONS,
  zktlsEndpointProfile,
} from "@umia/zktls-config/self-host";
import { MESSAGE_ACTIONS, MESSAGE_SOURCES } from "../src/utils/constants/interfaces.js";
import { PROOF_GENERATION_TIMEOUT_MS, ZK_WORKER_POOL_SIZE } from "../src/utils/constants/config.js";

const devnet = zktlsEndpointProfile("native-devnet");
let listener;
let complete;
let pendingClaim;
let resolvePending;
let rejectPending;
let claimResult = { claim: { identifier: "synthetic" } };
const sent = [];
const clients = [];
const sockets = [];
const fetches = [];

class Socket extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.OPEN = 1;
    this.CLOSED = 3;
    this.readyState = this.OPEN;
    this.closed = false;
    sockets.push(this);
  }
  send() {}
  close() {
    this.closed = true;
    this.readyState = this.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

globalThis.window = { URL, WebSocket: Socket, addEventListener() {} };
const actualAttestor = await import("@reclaimprotocol/attestor-core/browser");

mock.module("@reclaimprotocol/attestor-core/browser", () => ({
  ...actualAttestor,
  createClaimOnAttestor: async ({ client }) => {
    assert.ok(client.metadata);
    clients.push(client);
    if (pendingClaim) {
      return new Promise((resolve, reject) => {
        resolvePending = resolve;
        rejectPending = reject;
      });
    }
    return claimResult;
  },
}));

globalThis.document = { createElement: () => ({}), head: { appendChild() {} } };
globalThis.chrome = {
  runtime: {
    id: "test-extension",
    getURL: () => "chrome-extension://test-extension/",
    onMessage: { addListener: (callback) => (listener = callback) },
    sendMessage(message) {
      sent.push(message);
      if (message.action === MESSAGE_ACTIONS.GENERATE_PROOF_RESPONSE) complete?.(message);
      return Promise.resolve();
    },
  },
  storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
};
globalThis.fetch = async (url, options) => {
  fetches.push({ url, options });
  return new Response(JSON.stringify({ status: "success" }), { status: 200 });
};

await import("../src/offscreen/offscreen.js");

function boundMessage(client) {
  const now = Math.floor(Date.now() / 1000);
  const { attestorUrl } = devnet;
  return {
    session: {
      sessionId: "synthetic-session",
      umia: {
        sessionToken: "d".repeat(64),
        attestorAuth: {
          data: {
            id: "synthetic-session",
            createdAt: now - 1,
            expiresAt: now + 300,
            hostWhitelist: ["fixture.example"],
          },
          signature: `0x${"e".repeat(130)}`,
        },
        expiresAt: new Date((now + 600) * 1000).toISOString(),
      },
      route: {
        backendUrl: devnet.backendUrl,
        attestorUrl,
        network: { authorityDigest: `sha256:${"c".repeat(64)}` },
      },
    },
    name: "http",
    secretParams: { cookies: "synthetic-private-input" },
    client,
  };
}

function request(data, transportRequestId = "synthetic-request") {
  const result = new Promise((resolve) => (complete = resolve));
  listener(
    {
      action: MESSAGE_ACTIONS.GENERATE_PROOF,
      source: MESSAGE_SOURCES.BACKGROUND,
      target: MESSAGE_SOURCES.OFFSCREEN,
      transportRequestId,
      data,
    },
    { id: "test-extension" },
    () => {},
  );
  return result;
}

test("offscreen uses the bound signed client and discards page-supplied auth", async () => {
  assert.equal(typeof listener, "function");
  const result = await request(
    boundMessage({
      url: devnet.attestorUrl,
      authRequest: { data: { id: "attacker" }, signature: "forged" },
    }),
  );
  assert.equal(result.success, true);
  assert.equal(result.sessionId, "synthetic-session");
  assert.equal(result.transportRequestId, "synthetic-request");
  assert.equal(clients.length, 1);
  const encoded = new URL(sockets[0].url).searchParams.get("messages");
  const auth = actualAttestor.proto.RPCMessages.decode(Buffer.from(encoded, "base64")).messages[0]
    .initRequest.auth;
  assert.equal(auth.data.id, "synthetic-session");
  assert.deepEqual(auth.data.hostWhitelist, ["fixture.example"]);
  assert.equal(Buffer.from(auth.signature).toString("hex"), "e".repeat(130));
  assert.equal(sockets[0].closed, true);
  assert.equal(fetches.length, 2);
  assert.ok(
    fetches.every(({ options }) => options.headers.Authorization === `Bearer ${"d".repeat(64)}`),
  );
  assert.equal(JSON.stringify(sent).includes("synthetic-private-input"), false);
  assert.equal(JSON.stringify(sent).includes("forged"), false);
});

test("close cancels a pending claim and suppresses its late success", async () => {
  pendingClaim = true;
  const before = sent.length;
  const result = request(boundMessage({ url: devnet.attestorUrl }), "pending");
  for (let i = 0; i < 20 && !resolvePending; i += 1) await Promise.resolve();
  assert.equal(typeof resolvePending, "function");
  let closeResponse;
  listener(
    {
      action: MESSAGE_ACTIONS.CLOSE_BOUND_SESSION,
      source: MESSAGE_SOURCES.BACKGROUND,
      target: MESSAGE_SOURCES.OFFSCREEN,
      sessionId: "synthetic-session",
    },
    { id: "test-extension" },
    (response) => (closeResponse = response),
  );
  assert.equal(closeResponse.success, true);
  assert.equal((await result).error, "CANCELLED");
  resolvePending({ claim: { identifier: "late" } });
  await Promise.resolve();
  assert.equal(sent.slice(before).filter((message) => message.success === true).length, 0);
  assert.equal(sockets.at(-1).closed, true);
  pendingClaim = false;
  resolvePending = null;
});

test("cancelled and completed claims release their workers before another engine starts", async () => {
  const OriginalWorker = globalThis.Worker;
  let activeWorkers = 0;
  let peakWorkers = 0;
  class MockWorker {
    constructor() {
      activeWorkers++;
      peakWorkers = Math.max(peakWorkers, activeWorkers);
    }
    terminate() {
      if (this.terminated) return;
      this.terminated = true;
      activeWorkers--;
    }
  }
  globalThis.Worker = MockWorker;
  pendingClaim = true;
  resolvePending = null;
  try {
    const stwo = boundMessage({ url: devnet.attestorUrl });
    stwo.zkEngine = "stwo";
    const cancelled = request(stwo, "cancelled-stwo-workers");
    for (let i = 0; i < 20 && !resolvePending; i += 1) await Promise.resolve();
    assert.equal(typeof resolvePending, "function");
    assert.equal(activeWorkers, ZK_WORKER_POOL_SIZE);
    listener(
      {
        action: MESSAGE_ACTIONS.CLOSE_BOUND_SESSION,
        source: MESSAGE_SOURCES.BACKGROUND,
        target: MESSAGE_SOURCES.OFFSCREEN,
        sessionId: "synthetic-session",
      },
      { id: "test-extension" },
      () => {},
    );
    assert.equal((await cancelled).error, "CANCELLED");
    assert.equal(activeWorkers, 0);
    resolvePending({ claim: { identifier: "late" } });
    pendingClaim = false;

    const snarkjs = boundMessage({ url: devnet.attestorUrl });
    snarkjs.zkEngine = "snarkjs";
    assert.equal((await request(snarkjs, "completed-snarkjs-workers")).success, true);
    assert.equal(activeWorkers, 0);
    assert.equal(peakWorkers, ZK_WORKER_POOL_SIZE);
  } finally {
    globalThis.Worker = OriginalWorker;
    pendingClaim = false;
    resolvePending = null;
  }
});

test("a pending claim that reaches the session deadline reports SESSION_EXPIRED, not CANCELLED", async () => {
  pendingClaim = true;
  resolvePending = null;
  const before = sent.length;
  const message = boundMessage({ url: devnet.attestorUrl });
  // Signed auth carries whole seconds; +2 keeps the deadline 1-2s out, so a busy runner can't pass it
  // before the claim starts.
  message.session.umia.attestorAuth.data.expiresAt = Math.floor(Date.now() / 1000) + 2;
  const result = request(message, "expiring");
  for (let i = 0; i < 20 && !resolvePending; i += 1) await Promise.resolve();
  assert.equal(typeof resolvePending, "function");
  assert.equal((await result).error, "SESSION_EXPIRED");
  resolvePending({ claim: { identifier: "late" } });
  await Promise.resolve();
  assert.equal(sent.slice(before).filter((reply) => reply.success === true).length, 0);
  assert.equal(sockets.at(-1).closed, true);
  pendingClaim = false;
  resolvePending = null;
});

test("a proof timeout reports ATTESTOR_UNREACHABLE and a backend outage keeps its own code", async () => {
  pendingClaim = true;
  resolvePending = null;
  jest.useFakeTimers();
  try {
    const result = request(boundMessage({ url: devnet.attestorUrl }), "slow");
    for (let i = 0; i < 20 && !resolvePending; i += 1) await Promise.resolve();
    assert.equal(typeof resolvePending, "function");
    jest.advanceTimersByTime(PROOF_GENERATION_TIMEOUT_MS + 1);
    assert.equal((await result).error, "ATTESTOR_UNREACHABLE");
  } finally {
    jest.useRealTimers();
    pendingClaim = false;
    resolvePending = null;
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  try {
    const result = request(boundMessage({ url: devnet.attestorUrl }), "down");
    assert.equal((await result).error, "BACKEND_UNREACHABLE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("attestor failures report finite codes to the page and the session status", async () => {
  const failedStatus = () =>
    fetches
      .map(({ options }) => JSON.parse(options.body))
      .filter(({ status }) => status === "PROOF_GENERATION_FAILED")
      .at(-1);

  claimResult = { error: "attestor said: private detail" };
  try {
    const embedded = await request(boundMessage({ url: devnet.attestorUrl }), "embedded");
    assert.equal(embedded.error, "PROOF_GENERATION_FAILED");
    assert.equal(JSON.stringify(sent).includes("private detail"), false);
  } finally {
    claimResult = { claim: { identifier: "synthetic" } };
  }

  pendingClaim = true;
  try {
    for (const [dialFails, attestorCode, code] of [
      [true, undefined, "ATTESTOR_UNREACHABLE"],
      [false, undefined, "PROOF_GENERATION_FAILED"],
      // The attestor rejected the signed auth, e.g. a wrong configured auth public key.
      [false, "ERROR_AUTHENTICATION_FAILED", "ATTESTOR_AUTH_FAILED"],
    ]) {
      resolvePending = null;
      const result = request(boundMessage({ url: devnet.attestorUrl }), code);
      for (let i = 0; i < 20 && !resolvePending; i += 1) await Promise.resolve();
      assert.equal(typeof resolvePending, "function");
      if (dialFails) sockets.at(-1).dispatchEvent(new Event("error"));
      rejectPending(
        Object.assign(new Error("socket closed: private detail"), { code: attestorCode }),
      );
      assert.equal((await result).error, code);
      assert.equal(failedStatus().code, code);
    }
  } finally {
    pendingClaim = false;
    resolvePending = null;
  }
});

test("an attestor rejection reason picks the page and status code, thrown or embedded", async () => {
  const { AttestorError, proto } = actualAttestor;
  // The rejection table's extension column, kept independent of the shared map.
  const expected = {
    CLAIM_CONTEXT_INVALID: "CONFIG_REJECTED",
    CLAIM_CONTEXT_MESSAGE_UNSUPPORTED: "CONFIG_REJECTED",
    CLAIM_CONTEXT_SESSION_MISMATCH: "CONFIG_REJECTED",
    SIGNED_CONTEXT_INVALID: "CONFIG_REJECTED",
    CLAIM_CONTEXT_CHAIN_NOT_ALLOWED: "UNSUPPORTED_NETWORK",
    AUTH_REQUIRED: "ATTESTOR_AUTH_FAILED",
    AUTH_INVALID: "ATTESTOR_AUTH_FAILED",
    HOST_LIST_INVALID: "ATTESTOR_AUTH_FAILED",
    AUTH_EXPIRED: "SESSION_EXPIRED",
    AUTH_LIFETIME_INVALID: "ATTESTOR_AUTH_FAILED",
    INIT_TIMEOUT: "ATTESTOR_AUTH_FAILED",
    AUTH_SOCKET_LIMIT: "ATTESTOR_AUTH_FAILED",
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
    PROVIDER_VALIDATION_FAILED: "PROOF_INVALID",
  };
  assert.deepEqual(Object.keys(expected).sort(), [...ZKTLS_ATTESTOR_REJECTION_REASONS].sort());
  // The wire shape: a request error decodes into a thrown AttestorError, a claim
  // response keeps its proto ErrorData with JSON text.
  const errorData = (code, reason) =>
    proto.ErrorData.create({
      code: proto.ErrorCode[code],
      message: "private detail",
      data: JSON.stringify(reason === undefined ? { detail: "private" } : { reason }),
    });
  const failedStatus = () =>
    fetches
      .map(({ options }) => JSON.parse(options.body))
      .filter(({ status }) => status === "PROOF_GENERATION_FAILED")
      .at(-1);
  const rejectWith = async (thrown, label) => {
    pendingClaim = true;
    resolvePending = null;
    try {
      const result = request(boundMessage({ url: devnet.attestorUrl }), label);
      for (let i = 0; i < 20 && !resolvePending; i += 1) await Promise.resolve();
      assert.equal(typeof resolvePending, "function");
      rejectPending(thrown);
      return await result;
    } finally {
      pendingClaim = false;
      resolvePending = null;
    }
  };

  for (const [reason, code] of Object.entries(expected)) {
    const before = fetches.length;
    // An auth code with a non-auth reason proves the reason decides.
    const thrown = AttestorError.fromProto(errorData("ERROR_AUTHENTICATION_FAILED", reason));
    assert.equal((await rejectWith(thrown, `thrown-${reason}`)).error, code, reason);
    const reported = fetches
      .slice(before)
      .map(({ options }) => JSON.parse(options.body).code)
      .filter(Boolean);
    // The background reports SESSION_EXPIRED once the session ends; offscreen leaves it.
    assert.deepEqual(reported, code === "SESSION_EXPIRED" ? [] : [code], reason);

    claimResult = { error: errorData("ERROR_INVALID_CLAIM", reason) };
    try {
      const embedded = await request(
        boundMessage({ url: devnet.attestorUrl }),
        `embedded-${reason}`,
      );
      assert.equal(embedded.error, code, reason);
    } finally {
      claimResult = { claim: { identifier: "synthetic" } };
    }
  }
  assert.equal(JSON.stringify(sent).includes("private"), false);

  // No reason or an unknown one keeps the code-based fallback.
  for (const reason of [undefined, "SOMETHING_NEW", "auth_invalid"]) {
    for (const [attestorCode, code] of [
      ["ERROR_AUTHENTICATION_FAILED", "ATTESTOR_AUTH_FAILED"],
      ["ERROR_BAD_REQUEST", "PROOF_GENERATION_FAILED"],
    ]) {
      const thrown = AttestorError.fromProto(errorData(attestorCode, reason));
      assert.equal((await rejectWith(thrown, `fallback-${attestorCode}`)).error, code);
      assert.equal(failedStatus().code, code);
    }
    claimResult = { error: errorData("ERROR_AUTHENTICATION_FAILED", reason) };
    try {
      const embedded = await request(
        boundMessage({ url: devnet.attestorUrl }),
        "embedded-fallback",
      );
      assert.equal(embedded.error, "ATTESTOR_AUTH_FAILED");
    } finally {
      claimResult = { claim: { identifier: "synthetic" } };
    }
  }
});

test("embedded rejection diagnostics expose only known wire codes and reasons", async () => {
  const privateDetail = "synthetic-private-claim-response";
  for (const [error, expectedCode, expectedReason, failure] of [
    [
      { code: actualAttestor.proto.ErrorCode.ERROR_INVALID_CLAIM, message: privateDetail,
        data: JSON.stringify({ reason: "TRANSCRIPT_DECRYPT_FAILED", detail: privateDetail }) },
      "ERROR_INVALID_CLAIM", "TRANSCRIPT_DECRYPT_FAILED", "PROOF_GENERATION_FAILED",
    ],
    // An error without message text must never be accepted as a successful proof.
    [{ code: actualAttestor.proto.ErrorCode.ERROR_AUTHENTICATION_FAILED },
      "ERROR_AUTHENTICATION_FAILED", "unknown", "ATTESTOR_AUTH_FAILED"],
    [{ code: "ERROR_BAD_REQUEST", message: privateDetail, data: { reason: privateDetail } },
      "ERROR_BAD_REQUEST", "unknown", "PROOF_GENERATION_FAILED"],
    [{ code: privateDetail, message: privateDetail, data: privateDetail },
      "unknown", "unknown", "PROOF_GENERATION_FAILED"],
    [{ code: 123456, message: privateDetail }, "unknown", "unknown", "PROOF_GENERATION_FAILED"],
    [privateDetail, "unknown", "unknown", "PROOF_GENERATION_FAILED"],
  ]) {
    const beforeSent = sent.length;
    const beforeFetches = fetches.length;
    claimResult = { error };
    try {
      const result = await request(boundMessage({ url: devnet.attestorUrl }), "safe-diagnostic");
      assert.equal(result.success, false);
      assert.equal(result.error, failure);
      const emitted = sent.slice(beforeSent);
      const diagnostic = emitted.find((message) =>
        message.action === MESSAGE_ACTIONS.LOG_MESSAGE &&
        message.data.message.startsWith("[OFFSCREEN] Proof contains embedded error"));
      assert.equal(diagnostic?.data.message,
        `[OFFSCREEN] Proof contains embedded error code=${expectedCode} rejectionReason=${expectedReason}`);
      assert.equal(JSON.stringify(emitted).includes(privateDetail), false);
      assert.equal(fetches.slice(beforeFetches).some(({ options }) =>
        JSON.parse(options.body).status === "PROOF_GENERATION_SUCCESS"), false);
    } finally {
      claimResult = { claim: { identifier: "synthetic" } };
    }
  }
});

test("the owner key is generated only for this extension's own background", () => {
  for (const sender of [{ id: "test-extension", tab: { id: 4 } }, { id: "other-extension" }]) {
    const before = sent.length;
    let reply;
    listener(
      {
        action: MESSAGE_ACTIONS.GET_PRIVATE_KEY,
        source: MESSAGE_SOURCES.BACKGROUND,
        target: MESSAGE_SOURCES.OFFSCREEN,
      },
      sender,
      (response) => (reply = response),
    );
    assert.equal(reply.success, false);
    assert.equal(sent.length, before);
  }
});
