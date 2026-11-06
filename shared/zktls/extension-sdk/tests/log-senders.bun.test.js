import assert from "node:assert/strict";
import { test } from "bun:test";
import { MESSAGE_ACTIONS, MESSAGE_SOURCES } from "../src/utils/constants/interfaces.js";

globalThis.chrome = {
  runtime: { id: "installed-extension", sendMessage: async () => ({}) },
  tabs: { sendMessage: async () => ({}) },
  storage: { local: { get: async () => ({}), set() {} }, onChanged: { addListener() {} } },
};
const { handleMessage } = await import("../src/background/messageRouter.js");

function harness() {
  const logs = [];
  const configs = [];
  const ctx = {
    MESSAGE_ACTIONS,
    MESSAGE_SOURCES,
    managedTabs: new Set([7]),
    initiatingSender: { tabId: 3 },
    loggingHub: {
      handleRemoteLog: (message) => logs.push(message),
      setConfig: (config) => configs.push(config),
    },
  };
  const send = async (action, data, sender) => {
    let reply;
    await handleMessage(
      ctx,
      { action, source: MESSAGE_SOURCES.CONTENT_SCRIPT, target: MESSAGE_SOURCES.BACKGROUND, data },
      sender,
      (response) => (reply = response),
    );
    return reply;
  };
  return { logs, configs, send };
}

const offscreen = { id: "installed-extension" };
const providerTab = { id: "installed-extension", tab: { id: 7 }, frameId: 0 };
const callerTab = { id: "installed-extension", tab: { id: 3 }, frameId: 0 };
const anyGrantedPage = { id: "installed-extension", tab: { id: 12 }, frameId: 0 };
const otherExtension = { id: "other-extension" };

test("a granted page cannot change the log level", async () => {
  const { configs, send } = harness();
  const config = { logLevel: "FINE", consoleEnabled: true };
  for (const sender of [providerTab, callerTab, anyGrantedPage, otherExtension]) {
    const reply = await send(MESSAGE_ACTIONS.UPDATE_LOG_CONFIG, { config }, sender);
    assert.equal(reply.success, false);
  }
  assert.equal(configs.length, 0);
  assert.equal(
    (await send(MESSAGE_ACTIONS.UPDATE_LOG_CONFIG, { config }, offscreen)).success,
    true,
  );
  assert.deepEqual(configs, [config]);
});

test("only extension pages and verification tabs reach the log hub", async () => {
  const { logs, send } = harness();
  for (const [name, sender] of Object.entries({
    offscreen,
    providerTab,
    callerTab,
    anyGrantedPage,
    otherExtension,
  })) {
    await send(MESSAGE_ACTIONS.LOG_MESSAGE, { message: name }, sender);
  }
  assert.deepEqual(logs, ["offscreen", "providerTab", "callerTab"]);
});
