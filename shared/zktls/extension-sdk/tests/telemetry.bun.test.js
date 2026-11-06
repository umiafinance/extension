import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { processNextQueueItem } from "../src/background/proofQueue.js";
import { reportTelemetry } from "../src/background/telemetry.js";

const posts = [];

function ctx() {
  return {
    session: { sessionId: "bound-one" },
    aborted: false,
    telemetryWindow: null,
    postTelemetry: async (session, events) => {
      posts.push({ session, events });
    },
  };
}

test("sends only fixed stage tokens for accepted client observations", () => {
  posts.length = 0;
  const state = ctx();
  for (const type of ["page_ready", "request_captured"]) {
    reportTelemetry(state, type);
  }
  assert.deepEqual(
    posts.map(({ events }) => events),
    [
      [{ type: "page_ready", data: { stage: "page", clientEnv: "extension" } }],
      [{ type: "request_captured", data: { stage: "capture", clientEnv: "extension" } }],
    ],
  );
  assert.equal(posts[0].session, state.session);
});

test("drops server-owned, unknown, unbound and cancelled reports", () => {
  posts.length = 0;
  const state = ctx();
  for (const type of [
    "cancelled",
    "failed",
    "status_update",
    "proof_generated",
    "proof_started",
    "constructor",
    "x",
  ]) {
    reportTelemetry(state, type);
  }
  reportTelemetry({ ...ctx(), session: null }, "page_ready");
  reportTelemetry({ ...ctx(), aborted: true }, "page_ready");
  assert.equal(posts.length, 0);
});

test("caps each session at 20 reports per 5 seconds", () => {
  posts.length = 0;
  const state = ctx();
  for (let i = 0; i < 25; i++) reportTelemetry(state, "page_ready");
  assert.equal(posts.length, 20);
  state.telemetryWindow.start -= 5_000;
  reportTelemetry(state, "page_ready");
  assert.equal(posts.length, 21);
  state.session = { sessionId: "bound-two" };
  reportTelemetry(state, "page_ready");
  assert.equal(posts.length, 22);
});

test("one queued proof records exactly one proof_started", async () => {
  // Offscreen generateProof sends this status once; the API maps it to proof_started.
  const offscreen = readFileSync(new URL("../src/offscreen/offscreen.js", import.meta.url), "utf8");
  assert.equal(
    offscreen.match(
      /updateSessionStatus\(session, RECLAIM_SESSION_STATUS\.PROOF_GENERATION_STARTED\)/g,
    )?.length,
    1,
  );

  posts.length = 0;
  const statusUpdates = [];
  const session = { sessionId: "bound-one" };
  const state = {
    ...ctx(),
    session,
    activeSessionId: "bound-one",
    activeTabId: 91,
    isProcessingQueue: false,
    proofGenerationQueue: [{ claimData: { session }, requestHash: "0xabc" }],
    generatedProofs: new Map(),
    providerData: { requestData: [{ requestHash: "0xabc" }] },
    submitProofs: async () => {},
    MESSAGE_ACTIONS: {},
    MESSAGE_SOURCES: {},
    EVENT_TYPES: {},
    loggingHub: { info() {}, error() {} },
    sessionTimerManager: { clearAllTimers() {}, resetSessionTimer() {}, resumeSessionTimer() {} },
    generateProof: async () => {
      statusUpdates.push("PROOF_GENERATION_STARTED");
      return { success: true, proof: { claim: {} } };
    },
  };
  state.reportTelemetry = (type) => reportTelemetry(state, type);
  globalThis.chrome = { tabs: { sendMessage() {} } };

  await processNextQueueItem(state);

  const fromTelemetry = posts
    .flatMap(({ events }) => events)
    .filter((e) => e.type === "proof_started");
  const fromStatus = statusUpdates.filter((status) => status === "PROOF_GENERATION_STARTED");
  assert.equal(state.generatedProofs.size, 1);
  assert.equal(fromTelemetry.length + fromStatus.length, 1);
});
