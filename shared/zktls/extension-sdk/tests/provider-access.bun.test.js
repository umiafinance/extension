import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  PROVIDER_CONTENT_SCRIPT_PATH,
  providerContentScript,
  providerRequestUrls,
} from "../src/background/providerAccess.js";
import { MESSAGE_ACTIONS, MESSAGE_SOURCES } from "../src/utils/constants/interfaces.js";

// Any property is a no-op function returning another stub, so the popup's DOM wiring runs.
const stub = new Proxy(() => stub, { get: (_target, key) => (key === "then" ? undefined : stub) });

const sent = [];
globalThis.window = globalThis.window || globalThis;
globalThis.chrome = {
  runtime: {
    id: "test-extension",
    getURL: (path) => `chrome-extension://test-extension/${path}`,
    sendMessage: async () => ({}),
  },
  tabs: {
    sendMessage: async (tabId, message, options) => {
      sent.push({ tabId, message, options });
      return {};
    },
  },
  storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
};
const { handleMessage } = await import("../src/background/messageRouter.js");
const { reportTelemetry } = await import("../src/background/telemetry.js");
const { createProviderVerificationPopup } =
  await import("../src/content/components/reclaim-provider-verification-popup.js");

test("the provider's request hosts are offered for the grant, deduplicated", () => {
  assert.deepEqual(
    providerRequestUrls({
      requestData: [
        { url: "https://partner.example/login" },
        { url: "https://api.fairscale.xyz/gate" },
        { url: "https://api.fairscale.xyz/gate" },
        { url: 42 },
        {},
        null,
      ],
    }),
    ["https://partner.example/login", "https://api.fairscale.xyz/gate"],
  );
  assert.deepEqual(providerRequestUrls(null), []);
  assert.deepEqual(providerRequestUrls({ requestData: "not-a-list" }), []);
});

test("granted provider sites get the SDK content script in every frame at document start", () => {
  assert.deepEqual(
    providerContentScript({
      id: "provider-sites",
      matches: ["https://*.example.com/*"],
      css: ["consumer.css"],
    }),
    {
      id: "provider-sites",
      matches: ["https://*.example.com/*"],
      js: [PROVIDER_CONTENT_SCRIPT_PATH],
      css: ["consumer.css"],
      runAt: "document_start",
      persistAcrossSessions: true,
      allFrames: true,
    },
  );
  assert.equal(
    PROVIDER_CONTENT_SCRIPT_PATH,
    "reclaim-browser-extension-sdk/content/content.bundle.js",
  );
});

test("the verification popup is created only in the provider tab's top frame", async () => {
  const popupMessage = { action: MESSAGE_ACTIONS.SHOW_PROVIDER_VERIFICATION_POPUP, data: {} };
  const dataMessage = { action: MESSAGE_ACTIONS.PROVIDER_DATA_READY, data: {} };
  const ctx = {
    MESSAGE_ACTIONS,
    MESSAGE_SOURCES,
    managedTabs: new Set([85]),
    initPopupMessage: new Map([[85, { message: popupMessage }]]),
    providerDataMessage: new Map([[85, { message: dataMessage }]]),
  };
  await handleMessage(
    ctx,
    {
      action: MESSAGE_ACTIONS.CONTENT_SCRIPT_LOADED,
      source: MESSAGE_SOURCES.CONTENT_SCRIPT,
      target: MESSAGE_SOURCES.BACKGROUND,
      data: {},
    },
    { tab: { id: 85 }, frameId: 3 },
    () => {},
  );
  const popupSends = sent.filter(({ message }) => message === popupMessage);
  assert.deepEqual(popupSends, [{ tabId: 85, message: popupMessage, options: { frameId: 0 } }]);
});

test("the popup stacks above host-page modals from the moment it exists", () => {
  const properties = [];
  const popup = new Proxy(
    {
      id: "",
      className: "",
      style: { setProperty: (...args) => properties.push(args) },
      classList: stub,
    },
    { get: (target, key) => (key in target ? target[key] : stub) },
  );
  globalThis.document = new Proxy(
    { createElement: () => popup, getElementById: () => ({}) },
    { get: (target, key) => (key in target ? target[key] : stub) },
  );
  globalThis.fetch = async () => ({ text: async () => "<div></div>" });
  createProviderVerificationPopup("Provider", "", "", "session-one");
  assert.equal(popup.id, "reclaim-protocol-popup");
  assert.deepEqual(properties, [["z-index", "2147483647", "important"]]);
});

test("permission requests and grants report the fixed permission stage", () => {
  const posts = [];
  const session = { sessionId: "bound-one" };
  const ctx = {
    session,
    aborted: false,
    telemetryWindow: null,
    postTelemetry: async (_session, events) => posts.push(...events),
  };
  reportTelemetry(ctx, "permission_requested");
  reportTelemetry(ctx, "permission_granted");
  assert.deepEqual(posts, [
    { type: "permission_requested", data: { stage: "permission", clientEnv: "extension" } },
    { type: "permission_granted", data: { stage: "permission", clientEnv: "extension" } },
  ]);
});
