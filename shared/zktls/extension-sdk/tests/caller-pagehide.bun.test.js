import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  MESSAGE_ACTIONS,
  MESSAGE_SOURCES,
  RECLAIM_SDK_ACTIONS,
} from "../src/utils/constants/interfaces.js";

const listeners = new Map();
const sent = [];
const page = {
  location: { protocol: "https:", href: "https://hub.umia.localhost/auction/1" },
  addEventListener(type, listener) {
    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  },
  removeEventListener(type, listener) {
    listeners.set(
      type,
      (listeners.get(type) ?? []).filter((entry) => entry !== listener),
    );
  },
  postMessage() {},
  URL,
  WebSocket: class {},
};
globalThis.window = page;
globalThis.location = page.location;
globalThis.document = {
  readyState: "loading",
  addEventListener() {},
  createElement: () => ({ setAttribute() {}, remove() {} }),
  documentElement: { appendChild() {} },
};
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.chrome = {
  runtime: {
    id: "test-extension",
    getURL: (path) => `chrome-extension://test-extension/${path}`,
    sendMessage(message, callback) {
      sent.push(message);
      callback?.({ success: true });
      return Promise.resolve();
    },
    onMessage: { addListener() {} },
  },
  storage: { local: { get: (_key, callback) => callback?.({}) }, onChanged: { addListener() {} } },
};

await import("../src/content/content.js");

function start(sessionId) {
  for (const listener of listeners.get("message") ?? []) {
    listener({
      source: page,
      data: {
        action: RECLAIM_SDK_ACTIONS.START_VERIFICATION,
        messageId: sessionId,
        extensionID: "test-extension",
        data: { sessionId, providerId: "provider-one" },
      },
    });
  }
}

function pagehide() {
  for (const listener of listeners.get("pagehide") ?? []) listener({ persisted: false });
}

const cancels = () =>
  sent.filter((message) => message.action === MESSAGE_ACTIONS.CANCEL_VERIFICATION);

test("tearing down the starting document cancels only its latest session", () => {
  assert.equal(cancels().length, 0);
  start("session-one");
  start("session-two");
  pagehide();
  assert.deepEqual(cancels(), [
    {
      action: MESSAGE_ACTIONS.CANCEL_VERIFICATION,
      source: MESSAGE_SOURCES.CONTENT_SCRIPT,
      target: MESSAGE_SOURCES.BACKGROUND,
      data: { sessionId: "session-two" },
    },
  ]);
});
