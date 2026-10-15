import assert from "node:assert/strict";
import { test } from "node:test";
import { OVERLAY_THEME_PATH } from "../scripts/design-theme.js";

test("provider grants keep normal site behavior and narrow shared tenant hosts", async () => {
  globalThis.__UMIA_EXTENSION_CALLERS__ = ["https://hub.umia.conductor:8443"];
  globalThis.__UMIA_EXTENSION_ENDPOINT_PROFILES__ = [
    {
      callerOrigin: "https://hub.umia.conductor:8443",
      backendUrl: "https://api.umia.conductor:8443/zktls",
    },
  ];
  globalThis.chrome = {
    runtime: { getManifest: () => ({ optional_host_permissions: ["https://*/*"] }) },
  };
  try {
    const { findOptionalPatternForUrl, isPatternWithinOptionalScope } = await import(
      "./providerPermissionGate.js"
    );
    assert.equal(
      findOptionalPatternForUrl("https://login.github.com/session"),
      "https://*.github.com/*",
    );
    assert.equal(
      findOptionalPatternForUrl("https://login.example.co.uk/session"),
      "https://*.example.co.uk/*",
    );
    assert.equal(isPatternWithinOptionalScope("https://*.co.uk/*"), false);
    assert.equal(
      findOptionalPatternForUrl("https://account.fly.dev/login"),
      "https://account.fly.dev:443/*",
    );
    assert.equal(
      findOptionalPatternForUrl("https://hub.umia.conductor:8443/sandbox"),
      "https://hub.umia.conductor:8443/*",
    );
    assert.equal(isPatternWithinOptionalScope("https://*.github.com/*"), true);
    for (const pattern of [
      "https://*.fly.dev/private/*",
      "https://*.umia.conductor:8443/private/*",
      "https://*.github.com/private/*",
      "https://*.github.com/*?scope=all",
      "https://*.github.com?scope=all/*",
    ]) {
      assert.equal(isPatternWithinOptionalScope(pattern), false);
    }
  } finally {
    delete globalThis.chrome;
    delete globalThis.__UMIA_EXTENSION_CALLERS__;
    delete globalThis.__UMIA_EXTENSION_ENDPOINT_PROFILES__;
  }
});

test("the gate registers granted sites in every frame, grants request hosts and reports the prompt", async () => {
  globalThis.__UMIA_EXTENSION_CALLERS__ = ["https://hub.umia.conductor:8443"];
  globalThis.__UMIA_EXTENSION_ENDPOINT_PROFILES__ = [
    {
      callerOrigin: "https://hub.umia.conductor:8443",
      backendUrl: "https://api.umia.conductor:8443/zktls",
    },
  ];
  const registered = [];
  const created = [];
  const windows = [];
  const closedWindows = [];
  const themeWrites = [];
  let finishThemeWrite;
  const listeners = {};
  const on = (name) => ({ addListener: (listener) => (listeners[name] = listener) });
  const originalSendMessage = () => {};
  globalThis.chrome = {
    storage: {
      local: {
        set: (value) => {
          themeWrites.push(value);
          if (value.umiaTheme === "light")
            return new Promise((resolve) => (finishThemeWrite = resolve));
          if (value.umiaTheme === "system") return Promise.reject(new Error("write failed"));
          return Promise.resolve();
        },
      },
    },
    runtime: {
      getManifest: () => ({ optional_host_permissions: ["https://*/*"] }),
      getURL: (path) => `chrome-extension://umia/${path}`,
      onConnect: on("connect"),
      onMessageExternal: on("external"),
      onStartup: on("startup"),
      onInstalled: on("installed"),
    },
    permissions: {
      getAll: async () => ({ origins: ["https://*.github.com/*"] }),
      contains: async () => false,
      onAdded: on("added"),
      onRemoved: on("removed"),
    },
    scripting: {
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async (definitions) => registered.push(...definitions),
    },
    tabs: {
      create: (properties, callback) => {
        created.push(properties);
        callback?.({ id: 7 });
      },
      sendMessage: originalSendMessage,
    },
    windows: {
      create: (options, callback) => {
        windows.push(options);
        callback({ id: 11 });
      },
      remove: async (id) => closedWindows.push(id),
    },
  };
  try {
    const { installProviderPermissionGate } = await import("./providerPermissionGate.js");
    const events = [];
    const ctx = {
      providerData: {
        requestData: [{ url: "https://api.fairscale.xyz/gate" }, { url: 42 }],
      },
      reportTelemetry: (type) => events.push(type),
    };
    installProviderPermissionGate(ctx);
    let themeResponse;
    const hubSender = {
      frameId: 0,
      tab: { id: 42 },
      url: "https://hub.umia.conductor:8443/auction/1",
      origin: "https://hub.umia.conductor:8443",
    };
    listeners.external({ type: "umia:theme", theme: "dark" }, hubSender, (response) => {
      themeResponse = response;
    });
    for (let i = 0; i < 20 && !themeResponse; i += 1) await Promise.resolve();
    assert.deepEqual(themeResponse, { ok: true });
    assert.deepEqual(themeWrites, [{ umiaTheme: "dark" }]);
    listeners.external(
      { type: "umia:theme", theme: "light" },
      { ...hubSender, origin: "https://evil.example", url: "https://evil.example" },
      () => {},
    );
    assert.deepEqual(themeWrites, [{ umiaTheme: "dark" }]);
    for (let i = 0; i < 20 && registered.length === 0; i += 1) await Promise.resolve();
    assert.deepEqual(registered, [
      {
        id: "reclaim-provider-sites",
        matches: ["https://*.github.com/*"],
        js: ["reclaim-browser-extension-sdk/content/content.bundle.js"],
        css: [OVERLAY_THEME_PATH, "popup-patches.css"],
        runAt: "document_start",
        persistAcrossSessions: true,
        allFrames: true,
      },
    ]);
    // The SDK now pins its popup to frame 0 itself.
    assert.equal(chrome.tabs.sendMessage, originalSendMessage);

    chrome.tabs.create({ url: "https://partner.example.com/login" });
    for (let i = 0; i < 20 && windows.length === 0; i += 1) await Promise.resolve();
    const params = new URL(windows[0].url).searchParams;
    assert.equal(params.has("origins"), false);
    assert.deepEqual(events, ["permission_requested"]);
    assert.deepEqual(created, []);

    const replies = [];
    const port = {
      name: "umia-provider-grant",
      onMessage: on("portMessage"),
      onDisconnect: on("portDisconnect"),
      postMessage: (message) => replies.push(message),
    };
    listeners.connect(port);
    listeners.portMessage({ type: "getPending", pendingId: params.get("pendingId") });
    assert.deepEqual(replies, [
      {
        type: "ready",
        origins: ["https://*.example.com/*", "https://*.fairscale.xyz/*"],
        site: "example.com, fairscale.xyz",
      },
    ]);
    listeners.portMessage({ type: "getPending", pendingId: "forged" });
    assert.deepEqual(replies.at(-1), { type: "expired" });
    listeners.portMessage({ type: "getPending", pendingId: params.get("pendingId") });
    listeners.portMessage({ type: "granted", pendingId: params.get("pendingId") });
    for (let i = 0; i < 50 && closedWindows.length === 0; i += 1) await Promise.resolve();
    assert.deepEqual(events, ["permission_requested", "permission_granted"]);
    assert.deepEqual(created, [{ url: "https://partner.example.com/login" }]);
    assert.deepEqual(closedWindows, [11]);

    // The app-domain enable is no verification, so its prompt and grant report nothing.
    const relayedTabs = [];
    chrome.scripting.executeScript = async ({ target }) => relayedTabs.push(target.tabId);
    let enableResponse;
    listeners.external(
      { type: "umia:enable", theme: "light" },
      {
        frameId: 0,
        tab: { id: 42 },
        url: "https://hub.umia.conductor:8443/auction/1",
        origin: "https://hub.umia.conductor:8443",
      },
      (response) => (enableResponse = response),
    );
    for (let i = 0; i < 50 && windows.length < 2; i += 1) await Promise.resolve();
    assert.deepEqual(enableResponse, { ok: true });
    assert.deepEqual(themeWrites, [{ umiaTheme: "dark" }, { umiaTheme: "light" }]);
    finishThemeWrite();
    listeners.connect({ ...port, onMessage: on("portMessage") });
    listeners.portMessage({
      type: "getPending",
      pendingId: new URL(windows[1].url).searchParams.get("pendingId"),
    });
    assert.deepEqual(replies.at(-1).origins, [
      "https://hub.umia.conductor:8443/*",
      "https://api.umia.conductor:8443/*",
    ]);
    let statusResponse;
    listeners.external(
      { type: "umia:status" },
      {
        frameId: 0,
        tab: { id: 42 },
        url: "https://hub.umia.conductor:8443/auction/1",
        origin: "https://hub.umia.conductor:8443",
      },
      (response) => (statusResponse = response),
    );
    for (let i = 0; i < 50 && !statusResponse; i += 1) await Promise.resolve();
    assert.deepEqual(statusResponse, {
      installed: true,
      enabled: false,
      backendEnabled: false,
    });
    listeners.portMessage({
      type: "granted",
      pendingId: new URL(windows[1].url).searchParams.get("pendingId"),
    });
    for (let i = 0; i < 50 && closedWindows.length < 2; i += 1) await Promise.resolve();
    assert.deepEqual(relayedTabs, [42]);
    assert.deepEqual(events, ["permission_requested", "permission_granted"]);

    const errors = [];
    const originalConsoleError = console.error;
    console.error = (...args) => errors.push(args);
    try {
      let failedThemeResponse;
      listeners.external({ type: "umia:theme", theme: "system" }, hubSender, (response) => {
        failedThemeResponse = response;
      });
      for (let i = 0; i < 20 && !failedThemeResponse; i += 1) await Promise.resolve();
      assert.deepEqual(failedThemeResponse, { ok: false });
      assert.match(errors[0][0], /Hub theme sync failed/);

      let recoveredThemeResponse;
      listeners.external({ type: "umia:theme", theme: "dark" }, hubSender, (response) => {
        recoveredThemeResponse = response;
      });
      for (let i = 0; i < 20 && !recoveredThemeResponse; i += 1) await Promise.resolve();
      assert.deepEqual(recoveredThemeResponse, { ok: true });
      assert.deepEqual(themeWrites.slice(-2), [{ umiaTheme: "system" }, { umiaTheme: "dark" }]);
    } finally {
      console.error = originalConsoleError;
    }
  } finally {
    delete globalThis.chrome;
    delete globalThis.__UMIA_EXTENSION_CALLERS__;
    delete globalThis.__UMIA_EXTENSION_ENDPOINT_PROFILES__;
  }
});
