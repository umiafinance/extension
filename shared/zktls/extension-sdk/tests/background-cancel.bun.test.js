import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { ZKTLS_ERROR_CODES, ZKTLS_EXTENSION_ORIGIN_ALLOWLIST } from "@umia/zktls-config/self-host";
import {
  MESSAGE_ACTIONS,
  MESSAGE_SOURCES,
  RECLAIM_SESSION_STATUS,
  failureCode,
} from "../src/utils/constants/interfaces.js";

const profile = ZKTLS_EXTENSION_ORIGIN_ALLOWLIST[0];
const now = Math.floor(Date.now() / 1000);
const route = {
  profile: profile.profile,
  callerOrigin: profile.callerOrigin,
  backendUrl: profile.backendUrl,
  attestorUrl: profile.attestorUrl,
  network: { environment: "devnet", chainId: 10143, authorityDigest: `sha256:${"c".repeat(64)}` },
};
function bound(id) {
  return {
    sessionId: id,
    route,
    umia: {
      sessionToken: "a".repeat(64),
      expiresAt: new Date((now + 600) * 1000).toISOString(),
      attestorAuth: {
        data: {
          id,
          createdAt: now - 1,
          expiresAt: now + 300,
          hostWhitelist: ["fixture.example"],
        },
        signature: `0x${"d".repeat(130)}`,
      },
    },
  };
}

globalThis.window = globalThis.window || globalThis;
globalThis.chrome = {
  runtime: { id: "test-extension", sendMessage: async () => ({ success: true }) },
  tabs: {
    get: async () => ({ url: `${profile.callerOrigin}/auction/1` }),
    sendMessage: async () => ({}),
    update: async () => ({}),
    remove: async () => ({}),
  },
  storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
};
const { handleMessage } = await import("../src/background/messageRouter.js");
const { cancelSession, failSession, submitProofs } =
  await import("../src/background/sessionManager.js");

function initiatingSender(id) {
  return {
    sessionId: id,
    tabId: 42,
    extensionId: "test-extension",
    documentId: "caller-document",
    profile: profile.profile,
  };
}
const sender = {
  id: "test-extension",
  tab: { id: 42 },
  frameId: 0,
  documentId: "caller-document",
  url: `${profile.callerOrigin}/auction/1`,
  origin: profile.callerOrigin,
};

test("only the initiating top-frame document can cancel its bound session", async () => {
  const closed = [];
  const statuses = [];
  const ctx = {
    MESSAGE_ACTIONS,
    MESSAGE_SOURCES,
    RECLAIM_SESSION_STATUS,
    activeSessionId: "private-one",
    sessionId: "private-one",
    session: bound("private-one"),
    initiatingSender: initiatingSender("private-one"),
    originalTabId: 42,
    activeTabId: null,
    aborted: false,
    sessionTimerManager: { clearAllTimers() {}, clearExpiryTimer() {} },
    closeBoundSession: async (id) => closed.push(id),
    updateSessionStatus: async (_session, status) => statuses.push(status),
    managedTabs: new Set(),
  };
  async function cancel(id, from) {
    let response;
    await handleMessage(
      ctx,
      {
        action: MESSAGE_ACTIONS.CANCEL_VERIFICATION,
        source: MESSAGE_SOURCES.CONTENT_SCRIPT,
        target: MESSAGE_SOURCES.BACKGROUND,
        data: { sessionId: id },
      },
      from,
      (value) => (response = value),
    );
    return response;
  }
  for (const [id, from] of [
    ["private-two", sender],
    ["private-one", { ...sender, tab: { id: 43 } }],
    ["private-one", { ...sender, frameId: 1 }],
    ["private-one", { ...sender, documentId: "other-document" }],
    ["private-one", { ...sender, documentId: undefined }],
    [
      "private-one",
      {
        ...sender,
        url: "https://other.example/",
        origin: "https://other.example",
      },
    ],
  ]) {
    assert.equal((await cancel(id, from)).success, false);
  }
  assert.deepEqual(closed, []);
  assert.equal((await cancel("private-one", sender)).success, true);
  assert.deepEqual(closed, ["private-one"]);
  assert.deepEqual(statuses, [RECLAIM_SESSION_STATUS.SESSION_CANCELLED]);
  assert.equal(ctx.aborted, true);
  assert.equal(ctx.activeSessionId, null);

  // A replacement may start before the old 200 ms tab-return task runs.
  // Its caller and provider tabs must remain untouched by that old task.
  const tabOps = [];
  const originalUpdate = chrome.tabs.update;
  const originalRemove = chrome.tabs.remove;
  chrome.tabs.update = async (id) => tabOps.push(["update", id]);
  chrome.tabs.remove = async (id) => tabOps.push(["remove", id]);
  try {
    ctx.activeSessionId = "private-two";
    ctx.initiatingSender = initiatingSender("private-two");
    ctx.originalTabId = 84;
    ctx.activeTabId = 85;
    await Bun.sleep(230);
    assert.deepEqual(tabOps, []);
    assert.equal(ctx.originalTabId, 84);
    assert.equal(ctx.activeTabId, 85);
  } finally {
    chrome.tabs.update = originalUpdate;
    chrome.tabs.remove = originalRemove;
  }
});

test("a rejected start reaches its caller document only as a finite code", async () => {
  const sent = [];
  const originalSend = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (tabId, message, options) =>
    sent.push({ tabId, message, options });
  const baseOnDevnet = {
    environment: "devnet",
    chainId: 84532,
    beaconAddress: `0x${"b".repeat(40)}`,
    expectedEpoch: 2,
    authorityDigest: `sha256:${"c".repeat(64)}`,
  };
  try {
    for (const [umia, code] of [
      [{}, "CONFIG_REJECTED"],
      [{ backendUrl: profile.backendUrl, network: baseOnDevnet }, "UNSUPPORTED_NETWORK"],
    ]) {
      const ctx = { MESSAGE_ACTIONS, MESSAGE_SOURCES };
      let response;
      await handleMessage(
        ctx,
        {
          action: MESSAGE_ACTIONS.START_VERIFICATION,
          source: MESSAGE_SOURCES.CONTENT_SCRIPT,
          target: MESSAGE_SOURCES.BACKGROUND,
          data: {
            sessionId: "rejected-one",
            providerId: "provider-one",
            umia,
          },
        },
        sender,
        (value) => (response = value),
      );
      assert.deepEqual(response, { success: false, error: code });
      assert.deepEqual(sent.splice(0), [
        {
          tabId: 42,
          message: {
            action: MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
            source: MESSAGE_SOURCES.BACKGROUND,
            target: MESSAGE_SOURCES.CONTENT_SCRIPT,
            data: { error: code, sessionId: "rejected-one" },
          },
          options: { frameId: 0, documentId: "caller-document" },
        },
      ]);
    }
  } finally {
    chrome.tabs.sendMessage = originalSend;
  }
});

test("a duplicate start from the initiating document leaves the live proof alone", async () => {
  const sent = [];
  const originalSend = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (...args) => sent.push(args);
  const ctx = {
    MESSAGE_ACTIONS,
    MESSAGE_SOURCES,
    activeSessionId: "private-one",
    initiatingSender: initiatingSender("private-one"),
  };
  try {
    let response;
    await handleMessage(
      ctx,
      {
        action: MESSAGE_ACTIONS.START_VERIFICATION,
        source: MESSAGE_SOURCES.CONTENT_SCRIPT,
        target: MESSAGE_SOURCES.BACKGROUND,
        data: { sessionId: "private-one" },
      },
      sender,
      (value) => (response = value),
    );
    assert.deepEqual(response, { success: true, alreadyStarted: true });
    assert.equal(ctx.activeSessionId, "private-one");
    assert.deepEqual(sent, []);
  } finally {
    chrome.tabs.sendMessage = originalSend;
  }
});

test("cancel tab return contains a delayed Chrome rejection", async () => {
  const originalUpdate = chrome.tabs.update;
  let updates = 0;
  chrome.tabs.update = async () => {
    updates += 1;
    throw new Error("synthetic tab was closed");
  };
  const ctx = {
    MESSAGE_ACTIONS,
    MESSAGE_SOURCES,
    RECLAIM_SESSION_STATUS,
    activeSessionId: "private-one",
    sessionId: "private-one",
    session: bound("private-one"),
    initiatingSender: initiatingSender("private-one"),
    originalTabId: 42,
    activeTabId: null,
    aborted: false,
    sessionTimerManager: { clearAllTimers() {}, clearExpiryTimer() {} },
    closeBoundSession: async () => {},
    updateSessionStatus: async () => {},
    managedTabs: new Set(),
  };
  try {
    await cancelSession(ctx, "private-one");
    await Bun.sleep(230);
    assert.equal(updates, 1);
    assert.equal(ctx.originalTabId, null);
  } finally {
    chrome.tabs.update = originalUpdate;
  }
});

test("bound completion delivers only server-accepted proofs to the initiating document", async () => {
  const sent = [];
  const originalSend = chrome.tabs.sendMessage;
  const originalRuntimeSend = chrome.runtime.sendMessage;
  chrome.tabs.sendMessage = async (tabId, message, options) => {
    sent.push({ tabId, message, options });
    return {};
  };
  chrome.runtime.sendMessage = async (message) => {
    sent.push({ runtime: message });
    return {};
  };
  const accepted = [{ claim: { identifier: "accepted-synthetic" } }];
  let intakeCalls = 0;
  const closed = [];
  const ctx = {
    MESSAGE_ACTIONS,
    MESSAGE_SOURCES,
    RECLAIM_SESSION_STATUS,
    aborted: false,
    sessionId: "private-one",
    activeSessionId: "private-one",
    session: bound("private-one"),
    initiatingSender: initiatingSender("private-one"),
    originalTabId: 42,
    activeTabId: 99,
    generatedProofs: new Map([["request-one", { claim: { identifier: "local" } }]]),
    providerRequestsByHash: new Map(),
    providerData: { requestData: [] },
    sessionTimerManager: { clearAllTimers() {}, clearExpiryTimer() {} },
    formatProof: () => ({ claim: { identifier: "local" } }),
    submitBoundProofs: async (proofs, session) => {
      intakeCalls += 1;
      assert.equal(session.sessionId, "private-one");
      assert.equal(proofs.length, 1);
      return accepted;
    },
    closeBoundSession: async (id) => closed.push(id),
  };
  try {
    assert.deepEqual(await submitProofs(ctx), { success: true });
    assert.equal(intakeCalls, 1);
    assert.deepEqual(closed, ["private-one"]);
    const delivery = sent.find((item) => item.message?.action === MESSAGE_ACTIONS.PROOF_SUBMITTED);
    assert.equal(delivery.tabId, 42);
    assert.deepEqual(delivery.message.data.formattedProofs, accepted);
    assert.deepEqual(delivery.options, { frameId: 0, documentId: "caller-document" });
    assert.equal(
      sent.some(
        (item) => item.tabId === 99 && item.message?.action === MESSAGE_ACTIONS.PROOF_SUBMITTED,
      ),
      false,
    );
    assert.equal(
      sent.some((item) => item.runtime?.action === MESSAGE_ACTIONS.PROOF_SUBMITTED),
      false,
    );
    assert.equal(JSON.stringify(sent).includes("untrusted-callback"), false);
  } finally {
    chrome.tabs.sendMessage = originalSend;
    chrome.runtime.sendMessage = originalRuntimeSend;
  }
});

test("rejected private intake emits only a scoped failure and closes the session", async () => {
  const sent = [];
  const originalSend = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (tabId, message, options) => {
    sent.push({ tabId, message, options });
    return {};
  };
  const closed = [];
  const statuses = [];
  const ctx = {
    MESSAGE_ACTIONS,
    MESSAGE_SOURCES,
    RECLAIM_SESSION_STATUS,
    aborted: false,
    sessionId: "private-one",
    activeSessionId: "private-one",
    session: bound("private-one"),
    initiatingSender: initiatingSender("private-one"),
    originalTabId: 42,
    activeTabId: 99,
    generatedProofs: new Map([["request-one", { claim: { identifier: "local" } }]]),
    providerRequestsByHash: new Map(),
    providerData: { requestData: [] },
    sessionTimerManager: { clearAllTimers() {}, clearExpiryTimer() {} },
    formatProof: () => ({ claim: { identifier: "local" } }),
    submitBoundProofs: async () => {
      throw new Error("private-server-body");
    },
    updateSessionStatus: async (_session, status, code) => statuses.push([status, code]),
    closeBoundSession: async (id) => closed.push(id),
  };
  try {
    await assert.rejects(submitProofs(ctx), /private-server-body/);
    assert.deepEqual(closed, ["private-one"]);
    assert.deepEqual(statuses, [
      [RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED, "VERIFICATION_FAILED"],
    ]);
    assert.equal(ctx.activeSessionId, null);
    // The caller document gets the one terminal event; the provider tab's popup only the code.
    assert.deepEqual(
      sent.map(({ tabId, message, options }) => [
        tabId,
        message.action,
        message.data.error,
        options,
      ]),
      [
        [99, MESSAGE_ACTIONS.PROOF_GENERATION_FAILED, "VERIFICATION_FAILED", undefined],
        [
          42,
          MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED,
          "VERIFICATION_FAILED",
          { frameId: 0, documentId: "caller-document" },
        ],
      ],
    );
    assert.equal(JSON.stringify(sent).includes("private-server-body"), false);
    assert.equal(
      sent.some((item) => item.message?.action === MESSAGE_ACTIONS.PROOF_SUBMITTED),
      false,
    );
  } finally {
    chrome.tabs.sendMessage = originalSend;
  }
});

test("a backend outage or cancel during proof submission keeps its own code", async () => {
  const originalSend = chrome.tabs.sendMessage;
  try {
    for (const code of ["BACKEND_UNREACHABLE", "CANCELLED", "SESSION_EXPIRED"]) {
      const sent = [];
      chrome.tabs.sendMessage = async (_tabId, message) => sent.push(message);
      const ctx = {
        MESSAGE_ACTIONS,
        MESSAGE_SOURCES,
        RECLAIM_SESSION_STATUS,
        aborted: false,
        sessionId: "private-one",
        activeSessionId: "private-one",
        session: bound("private-one"),
        initiatingSender: initiatingSender("private-one"),
        originalTabId: 42,
        generatedProofs: new Map([["request-one", { claim: { identifier: "local" } }]]),
        providerRequestsByHash: new Map(),
        providerData: { requestData: [] },
        sessionTimerManager: { clearAllTimers() {}, clearExpiryTimer() {} },
        formatProof: () => ({ claim: { identifier: "local" } }),
        submitBoundProofs: async () => {
          throw new Error(code);
        },
        closeBoundSession: async () => {},
      };
      await assert.rejects(submitProofs(ctx), new RegExp(code));
      assert.deepEqual(
        sent.map((message) => [message.action, message.data.error]),
        [[MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED, code]],
      );
    }
  } finally {
    chrome.tabs.sendMessage = originalSend;
  }
});

test("every cancel notification carries only the CANCELLED code", async () => {
  const sent = [];
  const originalSend = chrome.tabs.sendMessage;
  const originalRuntimeSend = chrome.runtime.sendMessage;
  chrome.tabs.sendMessage = async (_tabId, message) => {
    sent.push(message);
    return {};
  };
  const broadcast = [];
  chrome.runtime.sendMessage = async (message) => {
    broadcast.push(message);
    return {};
  };
  try {
    await cancelSession(
      {
        MESSAGE_ACTIONS,
        MESSAGE_SOURCES,
        RECLAIM_SESSION_STATUS,
        activeSessionId: "private-one",
        sessionId: "private-one",
        session: bound("private-one"),
        initiatingSender: initiatingSender("private-one"),
        originalTabId: 42,
        activeTabId: 85,
        aborted: false,
        sessionTimerManager: { clearAllTimers() {}, clearExpiryTimer() {} },
        closeBoundSession: async () => {},
        updateSessionStatus: async () => {},
        managedTabs: new Set([85]),
      },
      "private-one",
    );
    const failures = sent.filter((m) => m.action === MESSAGE_ACTIONS.PROOF_GENERATION_FAILED);
    assert.equal(failures.length, 2);
    for (const message of failures) assert.equal(message.data.error, "CANCELLED");
    assert.deepEqual(broadcast, []);
  } finally {
    chrome.tabs.sendMessage = originalSend;
    chrome.runtime.sendMessage = originalRuntimeSend;
  }
});

test("failure codes come only from the closed ZktlsErrorCode enum", () => {
  for (const code of ZKTLS_ERROR_CODES) {
    assert.equal(failureCode(code), code);
    assert.equal(failureCode(new Error(code)), code);
  }
  assert.equal(failureCode("Access to bank.example was not granted"), "UNKNOWN");
  assert.equal(
    failureCode(new Error("cookie=secret"), "PROOF_GENERATION_FAILED"),
    "PROOF_GENERATION_FAILED",
  );
  assert.equal(failureCode(undefined, "not a code"), "UNKNOWN");
  // Thrown by requireLiveSession and the bound-backend transport; a caller's fallback never masks them.
  assert.equal(failureCode(new Error("SESSION_EXPIRED"), "CONFIG_REJECTED"), "SESSION_EXPIRED");
  assert.equal(
    failureCode(new Error("BACKEND_UNREACHABLE"), "PROOF_GENERATION_FAILED"),
    "BACKEND_UNREACHABLE",
  );
});

test("failSession sends only a fixed code to every page and backend path", async () => {
  const secret = "Claim creation failed: cookie=private-session account=1234";
  for (const [reason, expected] of [
    [secret, "UNKNOWN"],
    ...ZKTLS_ERROR_CODES.map((code) => [code, code]),
  ]) {
    const sent = [];
    const broadcast = [];
    const statuses = [];
    const originalSend = chrome.tabs.sendMessage;
    const originalRuntimeSend = chrome.runtime.sendMessage;
    chrome.tabs.sendMessage = async (_tabId, message) => {
      sent.push(message);
      return {};
    };
    chrome.runtime.sendMessage = async (message) => {
      broadcast.push(message);
      return {};
    };
    try {
      await failSession(
        {
          MESSAGE_ACTIONS,
          MESSAGE_SOURCES,
          RECLAIM_SESSION_STATUS,
          sessionId: "private-one",
          activeSessionId: "private-one",
          session: bound("private-one"),
          initiatingSender: initiatingSender("private-one"),
          originalTabId: 42,
          activeTabId: 85,
          sessionTimerManager: { clearAllTimers() {}, clearExpiryTimer() {} },
          closeBoundSession: async () => {},
          updateSessionStatus: async (_session, status, code) => statuses.push([status, code]),
        },
        reason,
        "0xabc",
      );
    } finally {
      chrome.tabs.sendMessage = originalSend;
      chrome.runtime.sendMessage = originalRuntimeSend;
    }
    assert.equal(sent.length, 2);
    for (const message of sent) assert.equal(message.data.error, expected);
    assert.deepEqual(broadcast, []);
    // The backend records the same code the page receives; a cancellation keeps its own status.
    assert.deepEqual(
      statuses,
      expected === "CANCELLED"
        ? [[RECLAIM_SESSION_STATUS.SESSION_CANCELLED, undefined]]
        : [[RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED, expected]],
    );
    assert.equal(JSON.stringify(sent).includes("private-session"), false);
  }
});

test("overlapping failures end the session once, with the first code", async () => {
  const sent = [];
  const statuses = [];
  const originalSend = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (_tabId, message) => sent.push(message);
  const ctx = {
    MESSAGE_ACTIONS,
    MESSAGE_SOURCES,
    RECLAIM_SESSION_STATUS,
    sessionId: "private-one",
    activeSessionId: "private-one",
    session: bound("private-one"),
    initiatingSender: initiatingSender("private-one"),
    originalTabId: 42,
    activeTabId: 85,
    sessionTimerManager: { clearAllTimers() {}, clearExpiryTimer() {} },
    closeBoundSession: async () => {},
    updateSessionStatus: async (_session, status, code) => {
      await Bun.sleep(5);
      statuses.push([status, code]);
    },
  };
  try {
    await Promise.all([
      failSession(ctx, "REQUEST_NOT_CAPTURED"),
      failSession(ctx, "PROOF_GENERATION_FAILED"),
    ]);
  } finally {
    chrome.tabs.sendMessage = originalSend;
  }
  assert.deepEqual(statuses, [
    [RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED, "REQUEST_NOT_CAPTURED"],
  ]);
  assert.deepEqual(
    sent.map((message) => message.data.error),
    ["REQUEST_NOT_CAPTURED", "REQUEST_NOT_CAPTURED"],
  );
  assert.equal(ctx.activeSessionId, null);
});

function overlapContext(statuses) {
  return {
    MESSAGE_ACTIONS,
    MESSAGE_SOURCES,
    RECLAIM_SESSION_STATUS,
    aborted: false,
    sessionId: "private-one",
    activeSessionId: "private-one",
    session: bound("private-one"),
    initiatingSender: initiatingSender("private-one"),
    originalTabId: 42,
    activeTabId: 85,
    managedTabs: new Set([85]),
    providerRequestsByHash: new Map(),
    sessionTimerManager: { clearAllTimers() {}, clearExpiryTimer() {} },
    closeBoundSession: async () => {},
    updateSessionStatus: async (_session, status, code) => {
      await Bun.sleep(5);
      statuses.push([status, code]);
    },
  };
}

test("a cancel and a failure that overlap end the session once, in either order", async () => {
  const originalSend = chrome.tabs.sendMessage;
  try {
    for (const cancelFirst of [false, true]) {
      const sent = [];
      const statuses = [];
      chrome.tabs.sendMessage = async (_tabId, message) => sent.push(message);
      const ctx = overlapContext(statuses);
      const fail = () => failSession(ctx, "REQUEST_NOT_CAPTURED");
      const cancel = () => cancelSession(ctx, "private-one");
      await Promise.allSettled(cancelFirst ? [cancel(), fail()] : [fail(), cancel()]);
      const code = cancelFirst ? "CANCELLED" : "REQUEST_NOT_CAPTURED";
      assert.deepEqual(
        statuses,
        cancelFirst
          ? [[RECLAIM_SESSION_STATUS.SESSION_CANCELLED, undefined]]
          : [[RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED, code]],
      );
      assert.deepEqual(
        sent.map((message) => message.data.error),
        [code, code],
      );
      assert.equal(ctx.activeSessionId, null);
    }
  } finally {
    chrome.tabs.sendMessage = originalSend;
  }
});

test("a failure during proof submission leaves the submission's outcome as the only terminal event", async () => {
  const sent = [];
  const statuses = [];
  const originalSend = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (_tabId, message) => sent.push(message);
  const ctx = {
    ...overlapContext(statuses),
    generatedProofs: new Map([["request-one", { claim: { identifier: "local" } }]]),
    providerData: { requestData: [] },
    formatProof: () => ({ claim: { identifier: "local" } }),
    submitBoundProofs: async () => {
      await Bun.sleep(5);
      return [{ claim: { identifier: "accepted" } }];
    },
  };
  try {
    await Promise.allSettled([submitProofs(ctx), failSession(ctx, "TAB_CLOSED")]);
  } finally {
    chrome.tabs.sendMessage = originalSend;
  }
  assert.deepEqual(statuses, []);
  // The provider tab's notice only shows the widget's success state; the page gets one terminal event.
  assert.deepEqual(
    sent.map((message) => message.action),
    [MESSAGE_ACTIONS.PROOF_SUBMITTED, MESSAGE_ACTIONS.PROVIDER_TAB_VERIFIED],
  );
  assert.equal(ctx.activeSessionId, null);
});

test("every failure call site passes a fixed code, never text", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const sources = [
    "../src/background/background.js",
    "../src/background/messageRouter.js",
    "../src/background/proofQueue.js",
    "../src/background/sessionManager.js",
    "../../../../web/extension/src/providerPermissionGate.js",
  ].map(read);
  const codes = new Set(ZKTLS_ERROR_CODES);
  const args = sources.flatMap((text) =>
    [
      ...text.matchAll(
        /(?<!function )(?:ctx\.failSession\(|sessionManager\.failSession\(ctx,|failVerification\([\w.]+,)\s*([^,)]+)/g,
      ),
    ].map((match) => match[1].trim()),
  );
  assert.ok(args.length >= 12);
  for (const arg of args) {
    const literal = /^"([A-Z_]+)"$/.exec(arg)?.[1];
    assert.ok(
      codes.has(literal) ||
        arg.startsWith("failureCode(") ||
        ["startCode", "code", "...args"].includes(arg),
      `free-text failure argument: ${arg}`,
    );
  }

  const content = read("../src/content/content.js");
  for (const leak of ["error: data?.error ||", "error: response?.error ||", "error: e?.message"]) {
    assert.equal(content.includes(leak), false, leak);
  }
});
