import assert from "node:assert/strict";
import { test } from "bun:test";
import { MESSAGE_ACTIONS, MESSAGE_SOURCES } from "../src/utils/constants/interfaces.js";

const listeners = new Set();
const requests = [];
globalThis.window = globalThis.window || globalThis;
globalThis.chrome = {
  runtime: {
    id: "test-extension",
    lastError: undefined,
    onMessage: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
      hasListener: (listener) => listeners.has(listener),
    },
    sendMessage: (message, callback) => {
      requests.push(message);
      callback?.();
    },
  },
};
const { installOffscreenReadyListener } = await import("../src/utils/offscreen-manager.js");
const { generateProof } = await import("../src/utils/proof-generator/proof-generator.js");

const logger = { info() {}, debug() {}, error() {}, warn() {} };
const background = { id: "test-extension" };

function deliver(response, sender = background) {
  for (const listener of [...listeners]) listener(response, sender);
}

function track(promise) {
  const state = { settled: false, result: undefined };
  state.done = promise.then((result) => {
    state.settled = true;
    state.result = result;
    return result;
  });
  return state;
}

async function nextRequest(count) {
  while (requests.length < count) await Bun.sleep(1);
  return requests[count - 1];
}

function reply(request, overrides) {
  return {
    action: MESSAGE_ACTIONS.GENERATE_PROOF_RESPONSE,
    source: MESSAGE_SOURCES.OFFSCREEN,
    target: MESSAGE_SOURCES.BACKGROUND,
    success: true,
    transportRequestId: request.transportRequestId,
    sessionId: request.data.session.sessionId,
    ...overrides,
  };
}

installOffscreenReadyListener();
deliver({
  action: MESSAGE_ACTIONS.OFFSCREEN_DOCUMENT_READY,
  source: MESSAGE_SOURCES.OFFSCREEN,
  target: MESSAGE_SOURCES.BACKGROUND,
});

test("only the reply for this request, session and sender settles a proof", async () => {
  requests.length = 0;
  const pending = track(generateProof({ session: { sessionId: "session-one" } }, logger));
  const request = await nextRequest(1);

  deliver(reply(request, { transportRequestId: "stale-request", proof: { stale: "request" } }));
  deliver(reply(request, { sessionId: "session-other", proof: { stale: "session" } }));
  deliver(reply(request, { proof: { forged: "tab" } }), { id: "test-extension", tab: { id: 7 } });
  deliver(reply(request, { proof: { forged: "extension" } }), { id: "other-extension" });
  await Bun.sleep(5);
  assert.equal(pending.settled, false);

  deliver(reply(request, { proof: { accepted: true } }));
  assert.deepEqual((await pending.done).proof, { accepted: true });
});

test("a reply for a replaced session never settles its replacement", async () => {
  requests.length = 0;
  const replaced = track(generateProof({ session: { sessionId: "session-one" } }, logger));
  const first = await nextRequest(1);
  const replacement = track(generateProof({ session: { sessionId: "session-two" } }, logger));
  const second = await nextRequest(2);

  // The replaced session's own, otherwise valid reply arrives late.
  deliver(reply(first, { proof: { from: "session-one" } }));
  await Bun.sleep(5);
  assert.equal(replacement.settled, false);
  assert.deepEqual((await replaced.done).proof, { from: "session-one" });

  // A duplicate of that reply after it settled still reaches no one.
  deliver(reply(first, { proof: { duplicate: true } }));
  await Bun.sleep(5);
  assert.equal(replacement.settled, false);

  deliver(reply(second, { proof: { from: "session-two" } }));
  assert.deepEqual((await replacement.done).proof, { from: "session-two" });
  deliver(reply(second, { proof: { late: true } }));
  await Bun.sleep(5);
  assert.deepEqual(replacement.result.proof, { from: "session-two" });
  assert.equal(listeners.size, 1, "only the offscreen-ready listener remains");
});
