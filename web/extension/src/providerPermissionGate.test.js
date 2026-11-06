import assert from "node:assert/strict";
import { test } from "node:test";

test("provider grants are exact hosts and the Umia app cannot fold in a wildcard", async () => {
  globalThis.__UMIA_EXTENSION_CALLERS__ = ["https://hub.umia.example:8443"];
  globalThis.__UMIA_EXTENSION_ENDPOINT_PROFILES__ = [
    {
      callerOrigin: "https://hub.umia.example:8443",
      backendUrl: "https://api.umia.example:8443/zktls",
    },
  ];
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: "0.4.1", optional_host_permissions: ["https://*/*"] }),
    },
  };
  try {
    const { findOptionalPatternForUrl, foldableProviderPattern } = await import(
      "./providerPermissionGate.js"
    );
    for (const [url, pattern] of [
      ["https://github.com/pulls/search?q=x", "https://github.com:443/*"],
      ["https://developers.google.com/people", "https://developers.google.com:443/*"],
      ["https://login.example.co.uk/session", "https://login.example.co.uk:443/*"],
      ["https://account.example.dev/login", "https://account.example.dev:443/*"],
      ["https://hub.umia.example:8443/sandbox", "https://hub.umia.example:8443/*"],
    ]) {
      assert.equal(findOptionalPatternForUrl(url), pattern);
    }
    assert.equal(findOptionalPatternForUrl("ftp://github.com/"), null);
    for (const [pattern, folded] of [
      ["https://github.com/*", "https://github.com:443/*"],
      ["https://developers.google.com:443/*", "https://developers.google.com:443/*"],
      ["https://hub.umia.example:8443/*", "https://hub.umia.example:8443/*"],
    ]) {
      assert.equal(foldableProviderPattern(pattern), folded);
    }
    for (const pattern of [
      "https://*/*",
      "https://*.github.com/*",
      "https://*.google.com/*",
      "https://*.co.uk/*",
      "https://*.example.dev/*",
      "https://*.umia.example:8443/*",
      "https://github.com/private/*",
      "https://github.com/*?scope=all",
      "https://github.com?scope=all/*",
    ]) {
      assert.equal(foldableProviderPattern(pattern), null, pattern);
    }
  } finally {
    delete globalThis.chrome;
    delete globalThis.__UMIA_EXTENSION_CALLERS__;
    delete globalThis.__UMIA_EXTENSION_ENDPOINT_PROFILES__;
  }
});

test("the gate registers granted sites in every frame, grants request hosts and reports the prompt", async () => {
  globalThis.__UMIA_EXTENSION_CALLERS__ = ["https://hub.umia.example:8443"];
  globalThis.__UMIA_EXTENSION_ENDPOINT_PROFILES__ = [
    {
      callerOrigin: "https://hub.umia.example:8443",
      backendUrl: "https://api.umia.example:8443/zktls",
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
      getManifest: () => ({ version: "0.4.1", optional_host_permissions: ["https://*/*"] }),
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
      getLastFocused: async () => ({ left: 100, top: 50, width: 1240, height: 840 }),
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
      url: "https://hub.umia.example:8443/auction/1",
      origin: "https://hub.umia.example:8443",
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
        css: [],
        runAt: "document_start",
        persistAcrossSessions: true,
        allFrames: true,
      },
    ]);
    // The SDK pins its popup to frame 0 itself.
    assert.equal(chrome.tabs.sendMessage, originalSendMessage);

    chrome.tabs.create({ url: "https://partner.example.com/login" });
    for (let i = 0; i < 20 && windows.length === 0; i += 1) await Promise.resolve();
    const params = new URL(windows[0].url).searchParams;
    // Centred on the browser window the user is in, not Chrome's top-left default.
    assert.deepEqual(
      [windows[0].left, windows[0].top, windows[0].width, windows[0].height],
      [500, 150, 440, 640],
    );
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
        origins: ["https://partner.example.com:443/*", "https://api.fairscale.xyz:443/*"],
        site: "partner.example.com, api.fairscale.xyz",
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
        url: "https://hub.umia.example:8443/auction/1",
        origin: "https://hub.umia.example:8443",
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
      "https://hub.umia.example:8443/*",
      "https://api.umia.example:8443/*",
    ]);
    assert.equal(replies.at(-1).site, "");
    let statusResponse;
    listeners.external(
      { type: "umia:status" },
      {
        frameId: 0,
        tab: { id: 42 },
        url: "https://hub.umia.example:8443/auction/1",
        origin: "https://hub.umia.example:8443",
      },
      (response) => (statusResponse = response),
    );
    for (let i = 0; i < 50 && !statusResponse; i += 1) await Promise.resolve();
    assert.deepEqual(statusResponse, {
      installed: true,
      enabled: false,
      backendEnabled: false,
      version: "0.4.1",
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

test("provider access ends with the verification, and an update clears grants from older versions", async () => {
  globalThis.__UMIA_EXTENSION_CALLERS__ = ["https://hub.umia.example:8443"];
  globalThis.__UMIA_EXTENSION_ENDPOINT_PROFILES__ = [
    {
      callerOrigin: "https://hub.umia.example:8443",
      backendUrl: "https://api.umia.example:8443/zktls",
    },
  ];
  const listeners = {};
  const on = (name) => ({ addListener: (listener) => (listeners[name] = listener) });
  const removed = [];
  const granted = [
    "https://hub.umia.example:8443/*",
    "https://api.umia.example:8443/*",
    "https://*.github.com/*",
    "https://api.fairscale.xyz:443/*",
  ];
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: "0.4.1", optional_host_permissions: ["https://*/*"] }),
      getURL: (path) => `chrome-extension://umia/${path}`,
      onConnect: on("connect"),
      onMessageExternal: on("external"),
      onStartup: on("startup"),
      onInstalled: on("installed"),
    },
    permissions: {
      getAll: async () => ({ origins: granted }),
      remove: async ({ origins }) => removed.push(origins),
      onAdded: on("added"),
      onRemoved: on("removed"),
    },
    scripting: {
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => {},
    },
    tabs: { create: () => {} },
  };
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  try {
    const { installProviderPermissionGate } = await import("./providerPermissionGate.js");
    const ctx = { activeSessionId: "live" };
    installProviderPermissionGate(ctx);
    await settle();
    assert.deepEqual(removed, []);

    ctx.onSessionEnd();
    await settle();
    assert.deepEqual(removed, []);

    ctx.activeSessionId = null;
    ctx.onSessionEnd();
    await settle();
    assert.deepEqual(removed, [["https://*.github.com/*", "https://api.fairscale.xyz:443/*"]]);

    listeners.installed({ reason: "update" });
    listeners.startup();
    await settle();
    assert.equal(removed.length, 3);
  } finally {
    delete globalThis.chrome;
    delete globalThis.__UMIA_EXTENSION_CALLERS__;
    delete globalThis.__UMIA_EXTENSION_ENDPOINT_PROFILES__;
  }
});

test("cleanup never removes access a new verification or a pending grant depends on", async () => {
  globalThis.__UMIA_EXTENSION_CALLERS__ = ["https://hub.umia.example:8443"];
  globalThis.__UMIA_EXTENSION_ENDPOINT_PROFILES__ = [
    {
      callerOrigin: "https://hub.umia.example:8443",
      backendUrl: "https://api.umia.example:8443/zktls",
    },
  ];
  const listeners = {};
  const on = (name) => ({ addListener: (listener) => (listeners[name] = listener) });
  const removed = [];
  const windows = [];
  let onRead = () => {};
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: "0.4.1", optional_host_permissions: ["https://*/*"] }),
      getURL: (path) => `chrome-extension://umia/${path}`,
      onConnect: on("connect"),
      onMessageExternal: on("external"),
      onStartup: on("startup"),
      onInstalled: on("installed"),
    },
    permissions: {
      getAll: async () => {
        onRead();
        return { origins: ["https://hub.umia.example:8443/*", "https://github.com:443/*"] };
      },
      contains: async () => false,
      remove: async ({ origins }) => removed.push(origins),
      onAdded: on("added"),
      onRemoved: on("removed"),
    },
    scripting: {
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => {},
    },
    tabs: { create: () => {} },
    windows: {
      getLastFocused: async () => ({}),
      create: (options, callback) => {
        windows.push(options);
        callback({ id: 21 });
      },
      remove: async () => {},
    },
  };
  const settle = async () => {
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
  };
  try {
    const { installProviderPermissionGate } = await import("./providerPermissionGate.js");
    const ctx = { activeSessionId: null };
    installProviderPermissionGate(ctx);

    // A verification starts while cleanup is reading the granted origins.
    onRead = () => {
      ctx.activeSessionId = "next";
    };
    ctx.onSessionEnd();
    await settle();
    assert.deepEqual(removed, []);
    onRead = () => {};

    // A provider grant is pending when the session ends; cleanup runs once it settles.
    chrome.tabs.create({ url: "https://github.com/login" });
    await settle();
    assert.equal(windows.length, 1);
    ctx.activeSessionId = null;
    ctx.onSessionEnd();
    await settle();
    assert.deepEqual(removed, []);

    const port = {
      name: "umia-provider-grant",
      onMessage: on("portMessage"),
      onDisconnect: on("portDisconnect"),
      postMessage: () => {},
    };
    listeners.connect(port);
    const pendingId = new URL(windows[0].url).searchParams.get("pendingId");
    listeners.portMessage({ type: "getPending", pendingId });
    listeners.portMessage({ type: "denied", pendingId });
    await settle();
    assert.deepEqual(removed, [["https://github.com:443/*"]]);
  } finally {
    delete globalThis.chrome;
    delete globalThis.__UMIA_EXTENSION_CALLERS__;
    delete globalThis.__UMIA_EXTENSION_ENDPOINT_PROFILES__;
  }
});

test("a lease keeps fresh grants through a worker restart and drops abandoned ones", async () => {
  globalThis.__UMIA_EXTENSION_CALLERS__ = ["https://hub.umia.example:8443"];
  globalThis.__UMIA_EXTENSION_ENDPOINT_PROFILES__ = [
    {
      callerOrigin: "https://hub.umia.example:8443",
      backendUrl: "https://api.umia.example:8443/zktls",
    },
  ];
  const listeners = {};
  const on = (name) => ({ addListener: (listener) => (listeners[name] = listener) });
  const removed = [];
  let session = {};
  const granted = [
    "https://hub.umia.example:8443/*",
    "https://github.com:443/*",
    "https://echo.example:443/*",
    "https://stale.example:443/*",
  ];
  globalThis.chrome = {
    storage: {
      session: {
        get: async (key) => ({ [key]: session[key] }),
        set: async (value) => {
          session = { ...session, ...value };
        },
      },
    },
    runtime: {
      getManifest: () => ({ version: "0.5.0", optional_host_permissions: ["https://*/*"] }),
      getURL: (path) => `chrome-extension://umia/${path}`,
      onConnect: on("connect"),
      onMessageExternal: on("external"),
      onStartup: on("startup"),
      onInstalled: on("installed"),
    },
    permissions: {
      getAll: async () => ({ origins: granted.filter((o) => !removed.flat().includes(o)) }),
      remove: async ({ origins }) => removed.push(origins),
      onAdded: on("added"),
      onRemoved: on("removed"),
    },
    scripting: {
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => {},
      updateContentScripts: async () => {},
    },
    tabs: { create: () => {}, query: async () => [] },
  };
  const settle = async () => {
    for (let i = 0; i < 60; i += 1) await Promise.resolve();
  };
  const realNow = Date.now;
  try {
    const { installProviderPermissionGate } = await import("./providerPermissionGate.js");
    // Leases as an earlier worker left them: GitHub fresh, the stale site from 20 minutes ago,
    // and the Echo grant with none (granted before the browser restarted).
    session = {
      umiaProviderGrants: {
        "https://github.com:443/*": realNow() - 60_000,
        "https://stale.example:443/*": realNow() - 20 * 60_000,
      },
    };
    const ctx = { activeSessionId: null };
    installProviderPermissionGate(ctx);
    await settle();
    assert.deepEqual(removed, [["https://echo.example:443/*", "https://stale.example:443/*"]]);

    // A session that ended keeps a grant made after it, such as one the app's enable step folded in.
    const endedAt = realNow();
    Date.now = () => endedAt;
    ctx.onSessionEnd();
    Date.now = () => endedAt + 5;
    listeners.added({ origins: ["https://late.example:443/*"] });
    granted.push("https://late.example:443/*");
    await settle();
    assert.deepEqual(removed.at(-1), ["https://github.com:443/*"]);
    assert.equal(removed.flat().includes("https://late.example:443/*"), false);
    assert.equal(typeof session.umiaProviderGrants["https://late.example:443/*"], "number");

    listeners.removed({ origins: ["https://github.com:443/*"] });
    await settle();
    assert.equal("https://github.com:443/*" in session.umiaProviderGrants, false);
  } finally {
    Date.now = realNow;
    delete globalThis.chrome;
    delete globalThis.__UMIA_EXTENSION_CALLERS__;
    delete globalThis.__UMIA_EXTENSION_ENDPOINT_PROFILES__;
  }
});

test("approving the app's enable step after another session ended keeps the folded-in provider", async () => {
  globalThis.__UMIA_EXTENSION_CALLERS__ = ["https://hub.umia.example:8443"];
  globalThis.__UMIA_EXTENSION_ENDPOINT_PROFILES__ = [
    {
      callerOrigin: "https://hub.umia.example:8443",
      backendUrl: "https://api.umia.example:8443/zktls",
    },
  ];
  const listeners = {};
  const on = (name) => ({ addListener: (listener) => (listeners[name] = listener) });
  const removed = [];
  const windows = [];
  let session = {};
  const granted = ["https://old.example:443/*"];
  globalThis.chrome = {
    storage: {
      session: {
        get: async (key) => ({ [key]: session[key] }),
        set: async (value) => {
          session = { ...session, ...value };
        },
      },
      local: { set: async () => {} },
    },
    runtime: {
      getManifest: () => ({ version: "0.5.0", optional_host_permissions: ["https://*/*"] }),
      getURL: (path) => `chrome-extension://umia/${path}`,
      onConnect: on("connect"),
      onMessageExternal: on("external"),
      onStartup: on("startup"),
      onInstalled: on("installed"),
    },
    permissions: {
      getAll: async () => ({ origins: granted.filter((o) => !removed.flat().includes(o)) }),
      contains: async () => false,
      remove: async ({ origins }) => removed.push(origins),
      onAdded: on("added"),
      onRemoved: on("removed"),
    },
    scripting: {
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => {},
      updateContentScripts: async () => {},
      executeScript: async () => {},
    },
    tabs: { create: () => {}, query: async () => [] },
    windows: {
      getLastFocused: async () => ({}),
      create: (options, callback) => {
        windows.push(options);
        callback({ id: 31 });
      },
      remove: async () => {},
    },
  };
  const settle = async () => {
    for (let i = 0; i < 80; i += 1) await Promise.resolve();
  };
  try {
    const { installProviderPermissionGate } = await import("./providerPermissionGate.js");
    session = { umiaProviderGrants: { "https://old.example:443/*": Date.now() - 60_000 } };
    const ctx = { activeSessionId: null };
    installProviderPermissionGate(ctx);
    await settle();

    listeners.external(
      { type: "umia:enable", extraOrigins: ["https://github.com/*"] },
      { frameId: 0, tab: { id: 42 }, origin: "https://hub.umia.example:8443" },
      () => {},
    );
    await settle();
    assert.equal(windows.length, 1);

    // Another tab's session ends while the enable window is open: its cleanup waits.
    ctx.onSessionEnd();
    await settle();
    assert.deepEqual(removed, []);

    const port = {
      name: "umia-provider-grant",
      onMessage: on("portMessage"),
      onDisconnect: on("portDisconnect"),
      postMessage: () => {},
    };
    listeners.connect(port);
    const pendingId = new URL(windows[0].url).searchParams.get("pendingId");
    listeners.portMessage({ type: "getPending", pendingId });
    granted.push("https://github.com:443/*");
    listeners.portMessage({ type: "granted", pendingId });
    await settle();
    assert.deepEqual(removed, [["https://old.example:443/*"]]);
  } finally {
    delete globalThis.chrome;
    delete globalThis.__UMIA_EXTENSION_CALLERS__;
    delete globalThis.__UMIA_EXTENSION_ENDPOINT_PROFILES__;
  }
});
