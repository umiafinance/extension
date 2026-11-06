import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import {
  publicProviderData,
  REQUEST_CHAIN_OP,
  runBoundRequestChain,
} from "../src/background/injectionManager.js";

const origin = "https://fomo.family";
const documentId = "provider-document";
const recipe = JSON.parse(
  readFileSync(new URL("../../providers/recipes/fomo-clans/no-clan.json", import.meta.url), "utf8"),
);

function fixture() {
  const now = Math.floor(Date.now() / 1000);
  const session = {
    sessionId: "bound-one",
    umia: {
      providerVersion: "v7",
      sessionToken: "private-bearer",
      expiresAt: new Date((now + 600) * 1000).toISOString(),
      attestorAuth: {
        data: { id: "bound-one", expiresAt: now + 300, hostWhitelist: ["prod-api.fomo.family"] },
      },
    },
    route: {
      network: { environment: "devnet", chainId: 10143 },
    },
  };
  const providerData = {
    id: "approved-provider",
    version: "v7",
    versionNumber: "v7",
    providerConfigs: [{ loginUrl: `${origin}/` }],
    requestChain: structuredClone(recipe.providerRuntime.requestChain),
    requestData: structuredClone(recipe.providerConfigs[0].requestData),
    recipeDigest: `sha256:${"a".repeat(64)}`,
  };
  const ctx = {
    session,
    providerData,
    providerLoginUrl: `${origin}/`,
    providerId: "approved-provider",
    sessionId: "bound-one",
    activeSessionId: "bound-one",
    activeTabId: 91,
    managedTabs: new Set([91]),
    injectionOperations: new Map(),
    aborted: false,
  };
  const sender = {
    id: "installed-extension",
    tab: { id: 91 },
    frameId: 0,
    documentId,
    documentLifecycle: "active",
    origin,
    url: `${origin}/`,
  };
  const calls = [];
  globalThis.chrome = {
    runtime: { id: "installed-extension" },
    tabs: { get: async () => ({ url: `${origin}/` }) },
    scripting: {
      executeScript: async (injection) => {
        calls.push(injection);
        return [{ documentId, frameId: 0, result: { status: "executed" } }];
      },
    },
  };
  return { ctx, sender, calls };
}

const operation = { op: REQUEST_CHAIN_OP };

test("only the bound recipe's declarative requests reach the page, once per document", async () => {
  const { ctx, sender, calls } = fixture();
  assert.equal((await runBoundRequestChain(ctx, sender, operation)).status, "executed");
  assert.deepEqual(calls[0].target, { tabId: 91, documentIds: [documentId] });
  assert.equal(calls[0].world, "MAIN");
  assert.deepEqual(calls[0].args.slice(0, 2), [
    ctx.providerData.requestChain,
    ctx.providerData.requestData.map((request) => request.url),
  ]);
  assert.ok(calls[0].args[2] <= Date.parse(ctx.session.umia.expiresAt));
  assert.equal(JSON.stringify(calls[0]).includes(ctx.session.umia.sessionToken), false);
  assert.equal((await runBoundRequestChain(ctx, sender, operation)).status, "duplicate");
  assert.equal(calls.length, 1);
  assert.equal(publicProviderData(ctx).loginUrl, `${origin}/`);
});

test("request chains reject unsigned hosts and unresolved parameters", async () => {
  for (const change of [
    (ctx) => {
      ctx.session.umia.attestorAuth.data.hostWhitelist = [];
    },
    (ctx) => {
      ctx.providerData.requestChain.readyUrl = "https://outside.example/pin";
    },
    (ctx) => {
      ctx.providerData.requestChain.responseParameters[0].requestIndex = 1;
    },
  ]) {
    const { ctx, sender, calls } = fixture();
    change(ctx);
    assert.equal((await runBoundRequestChain(ctx, sender, operation)).success, false);
    assert.equal(calls.length, 0);
  }
});

test("a provider with no request chain runs nothing", async () => {
  const { ctx, sender, calls } = fixture();
  delete ctx.providerData.requestChain;
  assert.deepEqual(await runBoundRequestChain(ctx, sender, operation), {
    success: true,
    status: "skipped",
  });
  assert.equal(calls.length, 0);
});

test("a rejected provider pin fails before a provider tab is opened", async () => {
  globalThis.window = globalThis.window || globalThis;
  const { startVerification } = await import("../src/background/sessionManager.js");
  const { ctx } = fixture();
  let opened = 0;
  chrome.tabs.create = () => (opened += 1);
  ctx.initiatingSender = { documentId: "caller-document" };
  ctx.sessionTimerManager = { clearAllTimers() {}, clearExpiryTimer() {}, startExpiryTimer() {} };
  ctx.fetchProviderData = async () => {
    throw new Error("Pinned provider metadata rejected");
  };
  await assert.rejects(
    startVerification(ctx, {
      sessionId: "bound-one",
      providerId: "approved-provider",
      session: {
        ...ctx.session,
        route: {
          ...ctx.session.route,
          network: {},
        },
      },
    }),
    /Pinned provider metadata rejected/,
  );
  assert.equal(opened, 0);
  assert.equal(ctx.providerData, null);
  assert.equal(ctx.providerLoginUrl, null);
});

test("rejects page-supplied payloads, legacy ops, and wrong bound metadata", async () => {
  for (const supplied of [
    { op: REQUEST_CHAIN_OP, code: "evil" },
    { op: REQUEST_CHAIN_OP, providerId: "other" },
    { op: "RUN_CUSTOM_INJECTION" },
    { op: "REPLAY_PAGE_FETCH" },
  ]) {
    const { ctx, sender, calls } = fixture();
    assert.equal((await runBoundRequestChain(ctx, sender, supplied)).success, false);
    assert.equal(calls.length, 0);
  }
  for (const change of [
    (ctx) => (ctx.providerLoginUrl = "https://other.example/login"),
    (ctx) => (ctx.providerLoginUrl = null),
  ]) {
    const { ctx, sender, calls } = fixture();
    change(ctx);
    assert.equal((await runBoundRequestChain(ctx, sender, operation)).success, false);
    assert.equal(calls.length, 0);
  }
});

test("rejects unowned frames, documents, origins, expired and cancelled sessions", async () => {
  for (const change of [
    (_ctx, sender) => (sender.id = "other-extension"),
    (_ctx, sender) => (sender.tab.id = 92),
    (_ctx, sender) => (sender.frameId = 1),
    (_ctx, sender) => (sender.documentId = undefined),
    (_ctx, sender) => (sender.documentLifecycle = "prerender"),
    (_ctx, sender) => (sender.origin = "https://other.example"),
    (_ctx, sender) => (sender.url = "https://other.example/login"),
    (ctx) => ctx.managedTabs.clear(),
    (ctx) => (ctx.aborted = true),
    (ctx) => (ctx.session.umia.expiresAt = "2000-01-01T00:00:00.000Z"),
    (ctx) => (ctx.session.umia.attestorAuth.data.expiresAt = 1),
  ]) {
    const { ctx, sender, calls } = fixture();
    change(ctx, sender);
    assert.equal((await runBoundRequestChain(ctx, sender, operation)).success, false);
    assert.equal(calls.length, 0);
  }
  const { ctx, sender, calls } = fixture();
  chrome.tabs.get = async () => ({ url: "https://other.example" });
  assert.equal((await runBoundRequestChain(ctx, sender, operation)).success, false);
  assert.equal(calls.length, 0);
});

test("suppresses stale results after replacement and never reruns the old document", async () => {
  const { ctx, sender, calls } = fixture();
  let settle;
  let entered;
  const executing = new Promise((resolve) => (entered = resolve));
  chrome.scripting.executeScript = async (injection) => {
    calls.push(injection);
    entered();
    return await new Promise((resolve) => (settle = resolve));
  };
  const pending = runBoundRequestChain(ctx, sender, operation);
  await executing;
  ctx.activeSessionId = "bound-two";
  ctx.injectionOperations = new Map();
  settle([{ documentId, frameId: 0, result: { status: "executed" } }]);
  assert.deepEqual(await pending, { success: false, error: "CANCELLED" });
  assert.equal(calls.length, 1);
});

test("runs once per navigated document", async () => {
  const { ctx, sender, calls } = fixture();
  assert.equal((await runBoundRequestChain(ctx, sender, operation)).status, "executed");
  const navigated = { ...sender, documentId: "next-document" };
  chrome.scripting.executeScript = async (injection) => {
    calls.push(injection);
    return [{ documentId: "next-document", frameId: 0, result: { status: "executed" } }];
  };
  assert.equal((await runBoundRequestChain(ctx, navigated, operation)).status, "executed");
  assert.deepEqual(calls[1].target, { tabId: 91, documentIds: ["next-document"] });
});

test("a failed or uncertain execution never reruns in the same document", async () => {
  for (const outcome of [
    async () => [{ documentId, frameId: 0, result: { status: "error" } }],
    async () => [{ documentId: "other-document", frameId: 0, result: { status: "executed" } }],
    async () => [],
    async () => {
      throw new Error("Frame with ID 0 was removed");
    },
  ]) {
    const { ctx, sender, calls } = fixture();
    chrome.scripting.executeScript = async (injection) => {
      calls.push(injection);
      return outcome();
    };
    assert.deepEqual(await runBoundRequestChain(ctx, sender, operation), {
      success: false,
      error: "INJECTION_REJECTED",
    });
    assert.deepEqual(await runBoundRequestChain(ctx, sender, operation), {
      success: false,
      error: "INJECTION_REJECTED",
    });
    assert.equal(calls.length, 1);
  }
});

test("a concurrent request for a pending document is rejected without a second run", async () => {
  const { ctx, sender, calls } = fixture();
  let settle;
  chrome.scripting.executeScript = async (injection) => {
    calls.push(injection);
    return await new Promise((resolve) => (settle = resolve));
  };
  const first = runBoundRequestChain(ctx, sender, operation);
  assert.deepEqual(await runBoundRequestChain(ctx, sender, operation), {
    success: false,
    error: "INJECTION_REJECTED",
  });
  while (!settle) await new Promise((resolve) => setTimeout(resolve, 0));
  settle([{ documentId, frameId: 0, result: { status: "executed" } }]);
  assert.equal((await first).status, "executed");
  assert.equal(calls.length, 1);
});

test("no source runs provider-authored code or exposes a page API", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const background = read("../src/background/injectionManager.js");
  for (const banned of [/\beval\(/, /customInjection/, /new Function/]) {
    assert.equal(banned.test(background), false, String(banned));
  }
  const content = read("../src/content/content.js");
  assert.equal(content.match(/localStorage\.\w+/g)?.join(), "localStorage.removeItem");
  for (const banned of [
    "customInjection",
    "injection-scripts",
    "REPLAY_PAGE_FETCH",
    "RECLAIM_GET_PROVIDER_ID",
  ]) {
    assert.equal(content.includes(banned), false, banned);
  }
});
