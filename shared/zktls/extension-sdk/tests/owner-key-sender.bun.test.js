import assert from "node:assert/strict";
import { test } from "bun:test";
import { MESSAGE_ACTIONS, MESSAGE_SOURCES } from "../src/utils/constants/interfaces.js";

const listeners = new Set();
const deliver = (message, sender) => {
  for (const listener of [...listeners]) listener(message, sender);
};
const keyReply = (privateKey) => ({
  action: MESSAGE_ACTIONS.GET_PRIVATE_KEY_RESPONSE,
  source: MESSAGE_SOURCES.OFFSCREEN,
  target: MESSAGE_SOURCES.BACKGROUND,
  success: true,
  privateKey,
});

globalThis.chrome = {
  runtime: {
    id: "installed-extension",
    lastError: undefined,
    onMessage: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
      hasListener: (listener) => listeners.has(listener),
    },
    sendMessage(message) {
      if (message.action !== MESSAGE_ACTIONS.GET_PRIVATE_KEY) return;
      queueMicrotask(() => {
        // A content script and another extension answer first; neither may set the key.
        deliver(keyReply(`0x${"1".repeat(64)}`), { id: "installed-extension", tab: { id: 7 } });
        deliver(keyReply(`0x${"2".repeat(64)}`), { id: "other-extension" });
        deliver(keyReply(`0x${"3".repeat(64)}`), { id: "installed-extension" });
      });
    },
  },
};

// A module mock would leak into every later test file, so mark the real offscreen document ready.
const { installOffscreenReadyListener } = await import("../src/utils/offscreen-manager.js");
installOffscreenReadyListener();
deliver(
  {
    action: MESSAGE_ACTIONS.OFFSCREEN_DOCUMENT_READY,
    source: MESSAGE_SOURCES.OFFSCREEN,
    target: MESSAGE_SOURCES.BACKGROUND,
  },
  { id: "installed-extension" },
);
const readyListeners = listeners.size;
const { createClaimObject } = await import("../src/utils/claim-creator/claim-creator.js");
const quiet = { info() {}, error() {}, debug() {}, warn() {} };

test("the claim's owner key comes only from this extension's offscreen document", async () => {
  const claim = await createClaimObject(
    { url: "https://api.provider.example/me", method: "GET", headers: {} },
    { url: "https://api.provider.example/me", urlType: "CONSTANT", geoLocation: "" },
    "session",
    "provider",
    "https://provider.example/login",
    quiet,
    null,
    { route: { attestorUrl: "wss://attestor.example/ws" } },
  );
  assert.equal(claim.ownerPrivateKey, `0x${"3".repeat(64)}`);
  assert.equal(listeners.size, readyListeners);
});
