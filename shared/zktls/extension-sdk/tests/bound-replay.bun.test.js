import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import {
  MAX_REPLAYS_PER_SESSION,
  REQUEST_CHAIN_OP,
  runBoundReplay,
  runBoundRequestChain,
} from "../src/background/injectionManager.js";
import { MESSAGE_ACTIONS, MESSAGE_SOURCES } from "../src/utils/constants/interfaces.js";

globalThis.chrome = {
  runtime: { id: "installed-extension", sendMessage: async () => ({}) },
  storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
};
const { handleMessage } = await import("../src/background/messageRouter.js");

const origin = "https://provider.example";
const documentUrl = `${origin}/settings/profile`;
const documentId = "provider-document";
const replay = { op: "REPLAY_BOUND_DOCUMENT" };

// Runs the injected page function against a fake page, recording each XHR it sends.
function page(href, { interceptor = true } = {}) {
  const sent = [];
  class FakeXHR {
    constructor() {
      this.headers = {};
      sent.push(this);
    }
    open(method, url, async) {
      Object.assign(this, { method, url, async });
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    send(body) {
      this.sentBody = body;
      this.sentCount = (this.sentCount ?? 0) + 1;
    }
  }
  return {
    sent,
    run(injection) {
      const previous = { window: globalThis.window, XMLHttpRequest: globalThis.XMLHttpRequest };
      globalThis.window = {
        location: { href },
        ...(interceptor ? { reclaimInterceptor: {} } : {}),
      };
      globalThis.XMLHttpRequest = FakeXHR;
      try {
        return injection.func(...injection.args);
      } finally {
        Object.assign(globalThis, previous);
      }
    },
  };
}

function fixture({ url = documentUrl, href = url, requestData, interceptor } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const session = {
    sessionId: "bound-one",
    umia: {
      providerVersion: "v7",
      sessionToken: "private-bearer",
      expiresAt: new Date((now + 600) * 1000).toISOString(),
      attestorAuth: {
        data: { id: "bound-one", expiresAt: now + 300, hostWhitelist: ["provider.example"] },
      },
    },
    route: { network: { environment: "devnet", chainId: 10143 } },
  };
  const providerData = {
    id: "approved-provider",
    version: "v7",
    requestData: requestData ?? [
      {
        url: documentUrl,
        urlType: "TEMPLATE",
        method: "GET",
        bodySniff: { enabled: false, template: "" },
      },
    ],
  };
  const ctx = {
    session,
    providerData,
    providerLoginUrl: `${origin}/login`,
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
    url,
  };
  const fakePage = page(href, { interceptor });
  const calls = [];
  const tab = { url };
  globalThis.chrome = {
    runtime: { id: "installed-extension" },
    tabs: { get: async () => tab },
    scripting: {
      executeScript: async (injection) => {
        calls.push(injection);
        const [target] = injection.target.documentIds;
        return [{ documentId: target, frameId: 0, result: fakePage.run(injection) }];
      },
    },
  };
  return { ctx, sender, calls, tab, sent: fakePage.sent };
}

test("replays the bound tab's declared document once, as one credentialed GET with fixed headers", async () => {
  const { ctx, sender, calls, sent } = fixture();
  assert.deepEqual(await runBoundReplay(ctx, sender, replay), {
    success: true,
    status: "executed",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].target, { tabId: 91, documentIds: [documentId] });
  assert.equal(calls[0].world, "MAIN");
  assert.deepEqual(calls[0].args, [documentUrl, []]);
  assert.equal(sent.length, 1);
  assert.deepEqual(
    { method: sent[0].method, url: sent[0].url, async: sent[0].async },
    { method: "GET", url: documentUrl, async: true },
  );
  assert.equal(sent[0].withCredentials, true);
  assert.equal(sent[0].sentBody, null);
  assert.deepEqual(Object.keys(sent[0].headers).sort(), [
    "accept",
    "accept-language",
    "cache-control",
  ]);

  assert.deepEqual(await runBoundReplay(ctx, sender, replay), {
    success: true,
    status: "duplicate",
  });
  assert.equal(calls.length, 1);
});

test("an absent or false disableRequestReplay replays; true never does", async () => {
  for (const [value, status] of [
    [undefined, "executed"],
    [false, "executed"],
    [true, "disabled"],
  ]) {
    const { ctx, sender, calls } = fixture();
    if (value !== undefined) ctx.providerData.disableRequestReplay = value;
    const result = await runBoundReplay(ctx, sender, replay);
    assert.equal(result.status, status, String(value));
    assert.equal(calls.length, status === "executed" ? 1 : 0, String(value));
  }
});

test("refuses every request outside the bound session, tab, document and declared URL", async () => {
  const cases = {
    "wrong op": [(f) => (f.data = { op: "REPLAY_PAGE_FETCH" })],
    "extra field": [(f) => (f.data = { ...replay, url: `${origin}/logout` })],
    "unmanaged tab": [(f) => f.ctx.managedTabs.clear()],
    "other active tab": [(f) => (f.ctx.activeTabId = 92)],
    "stale session": [(f) => (f.ctx.activeSessionId = "bound-two")],
    "aborted session": [(f) => (f.ctx.aborted = true)],
    "expired session": [
      (f) => (f.ctx.session.umia.expiresAt = new Date(Date.now() - 1000).toISOString()),
    ],
    "foreign extension": [(f) => (f.sender.id = "other-extension")],
    "sub-frame": [(f) => (f.sender.frameId = 3)],
    "inactive document": [(f) => (f.sender.documentLifecycle = "prerender")],
    "no document": [(f) => delete f.sender.documentId],
    "sender off the login origin": [(f) => (f.sender.origin = "https://other.example")],
    "tab URL differs from the sender's": [
      (f) => {
        f.tab.url = `${origin}/settings/admin`;
        f.ctx.providerData.requestData.push({ url: f.tab.url, method: "GET" });
      },
    ],
    "host outside the signed whitelist": [
      (f) => (f.ctx.session.umia.attestorAuth.data.hostWhitelist = ["other.example"]),
    ],
    "no signed whitelist": [(f) => delete f.ctx.session.umia.attestorAuth.data.hostWhitelist],
    "undeclared URL": [(f) => (f.ctx.providerData.requestData[0].url = `${origin}/api/me`)],
    "declared only as POST": [(f) => (f.ctx.providerData.requestData[0].method = "POST")],
    "GET with a sniffed body": [
      (f) => (f.ctx.providerData.requestData[0].bodySniff = { enabled: true, template: "x" }),
    ],
    "no request data": [(f) => delete f.ctx.providerData.requestData],
  };
  for (const [name, [change]] of Object.entries(cases)) {
    const f = { ...fixture(), data: replay };
    change(f);
    const result = await runBoundReplay(f.ctx, f.sender, f.data);
    assert.equal(result.success, false, name);
    assert.equal(f.calls.length, 0, name);
  }
});

test("matches the whole URL, with a path variable inside one segment", async () => {
  const template = `${origin}/u/{{handle}}/profile`;
  const requestData = (url, urlType) => [{ url, urlType, method: "get" }];
  for (const [url, rule, replays] of [
    [`${origin}/u/alice/profile`, requestData(template, "TEMPLATE"), true],
    [`${origin}/u/alice/bob/profile`, requestData(template, "TEMPLATE"), false],
    [`${origin}/u/alice/profile/delete`, requestData(template, "TEMPLATE"), false],
    [`${origin}/u/alice/profile?next=1`, requestData(template, "TEMPLATE"), false],
    [`${origin}/settings/profile`, requestData(`${origin}/settings/profile`, "CONSTANT"), true],
    [`${origin}/settings/profile2`, requestData(`${origin}/settings/profile`, "CONSTANT"), false],
    [`${origin}/a/1`, requestData("https://provider\\.example/a/[0-9]+", "REGEX"), true],
    [`${origin}/a/1/x`, requestData("https://provider\\.example/a/[0-9]+", "REGEX"), false],
    [`${origin}/a/1`, requestData("https://provider.example/a/(", "REGEX"), false],
  ]) {
    const { ctx, sender, calls } = fixture({ url, requestData: rule });
    await runBoundReplay(ctx, sender, replay);
    assert.equal(calls.length, replays ? 1 : 0, url);
  }
});

test("a query variable holds one value and the query must match exactly", async () => {
  const template = `${origin}/api/user?login={{user}}&tab=profile`;
  const requestData = [{ url: template, urlType: "TEMPLATE", method: "GET" }];
  for (const [query, replays] of [
    ["?login=alice&tab=profile", true],
    // A value that smuggles another parameter in, or adds one at the end.
    ["?login=alice&action=delete&tab=profile", false],
    ["?login=alice&tab=profile&action=delete", false],
    ["?login=alice=x&tab=profile", false],
    // Each caught only by its own exclusion: a bare "&" flag, and a fragment inside the value.
    ["?login=alice&admin&tab=profile", false],
    ["?login=alice#x&tab=profile", false],
    ["?login=alice&tab=profile#top", false],
    ["?tab=profile&login=alice", false],
    ["?login=&tab=profile", false],
  ]) {
    const url = `${origin}/api/user${query}`;
    const { ctx, sender, calls } = fixture({ url, requestData });
    await runBoundReplay(ctx, sender, replay);
    assert.equal(calls.length, replays ? 1 : 0, query);
  }
  // A path variable never reaches into the query.
  const path = [{ url: `${origin}/u/{{handle}}`, urlType: "TEMPLATE", method: "GET" }];
  for (const [url, replays] of [
    [`${origin}/u/alice`, true],
    [`${origin}/u/alice?action=delete`, false],
    [`${origin}/u/alice#top`, false],
  ]) {
    const { ctx, sender, calls } = fixture({ url, requestData: path });
    await runBoundReplay(ctx, sender, replay);
    assert.equal(calls.length, replays ? 1 : 0, url);
  }
});

test("shares the request matcher's variable grammar, so anything else is literal", async () => {
  const requestData = [{ url: `${origin}/p/{{a-b}}`, urlType: "TEMPLATE", method: "GET" }];
  const { ctx, sender, calls } = fixture({ url: `${origin}/p/anything`, requestData });
  await runBoundReplay(ctx, sender, replay);
  assert.equal(calls.length, 0);
});

test("rechecks the bound session after reading the tab", async () => {
  for (const change of [
    (ctx) => (ctx.aborted = true),
    (ctx) => (ctx.activeTabId = 92),
    (ctx) => (ctx.activeSessionId = "bound-two"),
  ]) {
    const { ctx, sender, calls, tab } = fixture();
    chrome.tabs.get = async () => {
      change(ctx);
      return tab;
    };
    assert.equal((await runBoundReplay(ctx, sender, replay)).success, false);
    assert.equal(calls.length, 0);
  }
});

test("accepts a result only from the bound document's top frame, and never retries it", async () => {
  for (const reply of [
    { documentId: "other-document", frameId: 0 },
    { documentId, frameId: 3 },
  ]) {
    const { ctx, sender, calls } = fixture();
    chrome.scripting.executeScript = async (injection) => {
      calls.push(injection);
      return [{ ...reply, result: { status: "sent" } }];
    };
    assert.deepEqual(await runBoundReplay(ctx, sender, replay), {
      success: false,
      error: "REPLAY_REJECTED",
    });
    assert.equal((await runBoundReplay(ctx, sender, replay)).success, false);
    assert.equal(calls.length, 1);
  }
});

test("caps replays per session across documents and URLs", async () => {
  const { ctx, sender, calls } = fixture();
  for (let i = 0; i < MAX_REPLAYS_PER_SESSION; i += 1) {
    sender.documentId = `document-${i}`;
    assert.equal((await runBoundReplay(ctx, sender, replay)).status, "executed", String(i));
  }
  sender.documentId = "one-too-many";
  assert.equal((await runBoundReplay(ctx, sender, replay)).success, false);
  assert.equal(calls.length, MAX_REPLAYS_PER_SESSION);
});

const activityUrl = `${origin}/pulls/search?q=is%3Apr%20author%3A%40me`;
const declared = (url, changes = {}) => ({
  url,
  urlType: "TEMPLATE",
  method: "GET",
  bodySniff: { enabled: false, template: "" },
  ...changes,
});
const connected = (options = {}) =>
  fixture({ requestData: [declared(documentUrl), declared(activityUrl)], ...options });

test("replays the recipe's other fixed same-origin GETs with the signed-in document, once each", async () => {
  const { ctx, sender, calls, sent } = connected();
  assert.deepEqual(await runBoundReplay(ctx, sender, replay), {
    success: true,
    status: "executed",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [documentUrl, [activityUrl]]);
  assert.deepEqual(
    sent.map((xhr) => [xhr.method, xhr.url, xhr.async, xhr.withCredentials, xhr.sentBody]),
    [
      ["GET", documentUrl, true, true, null],
      ["GET", activityUrl, true, true, null],
    ],
  );
  assert.deepEqual(sent[1].headers, sent[0].headers);

  assert.deepEqual(await runBoundReplay(ctx, sender, replay), {
    success: true,
    status: "duplicate",
  });
  assert.equal(calls.length, 1);
});

test("a companion is only a fixed-URL plain GET of the recipe on the document's own origin", async () => {
  const fixed = `${origin}/fixed`;
  const { ctx, sender, calls } = fixture({
    requestData: [
      declared(documentUrl),
      declared(activityUrl),
      declared(fixed, { urlType: "CONSTANT" }),
      declared(activityUrl),
      declared(`${origin}/u/{{handle}}`),
      declared(`${origin}/p/{{id_SECRET}}/x`, { urlType: "CONSTANT" }),
      declared("https://provider\\.example/a/[0-9]+", { urlType: "REGEX" }),
      declared(`${origin}/looks-fixed`, { urlType: "REGEX" }),
      declared(`${origin}/api/me`, { method: "POST" }),
      declared(`${origin}/graphql`, { bodySniff: { enabled: true, template: "x" } }),
      declared("https://other.example/activity"),
      declared("https://provider.example:8443/activity"),
      declared("http://provider.example/activity"),
      declared("https://user:pass@provider.example/activity"),
    ],
  });
  ctx.providerData.allowedInjectedRequestData = [declared(`${origin}/injected`)];
  // Signed but cross-origin: still not a companion.
  ctx.session.umia.attestorAuth.data.hostWhitelist.push("other.example");
  await runBoundReplay(ctx, sender, replay);
  assert.deepEqual(calls[0].args, [documentUrl, [activityUrl, fixed]]);
});

test("replays companions only from a page the recipe declares, never from sign-in", async () => {
  const { ctx, sender, calls } = connected({ url: `${origin}/login?return_to=%2Fsettings` });
  assert.equal((await runBoundReplay(ctx, sender, replay)).success, false);
  assert.equal(calls.length, 0);

  const fromActivity = connected({ url: activityUrl });
  await runBoundReplay(fromActivity.ctx, fromActivity.sender, replay);
  assert.deepEqual(fromActivity.calls[0].args, [activityUrl, [documentUrl]]);
});

test("a document never re-requests a companion when it later moves to that URL", async () => {
  const { ctx, sender, calls, tab } = connected();
  await runBoundReplay(ctx, sender, replay);
  sender.url = activityUrl;
  tab.url = activityUrl;
  assert.deepEqual(await runBoundReplay(ctx, sender, replay), {
    success: true,
    status: "duplicate",
  });
  assert.equal(calls.length, 1);
});

test("caps a connected recipe at three replays of each declared GET per session", async () => {
  const { ctx, sender, sent } = connected();
  for (let i = 0; i < MAX_REPLAYS_PER_SESSION; i += 1) {
    sender.documentId = `document-${i}`;
    assert.equal((await runBoundReplay(ctx, sender, replay)).status, "executed", String(i));
  }
  sender.documentId = "one-too-many";
  assert.equal((await runBoundReplay(ctx, sender, replay)).success, false);
  assert.equal(sent.length, 2 * MAX_REPLAYS_PER_SESSION);
});

test("a round that sent nothing releases every URL; an uncertain one rejects them all", async () => {
  const waiting = connected({ interceptor: false });
  assert.deepEqual(await runBoundReplay(waiting.ctx, waiting.sender, replay), {
    success: false,
    status: "not-ready",
  });
  assert.equal(waiting.ctx.injectionOperations.size, 0);
  assert.equal(waiting.sent.length, 0);

  const { ctx, sender } = connected();
  chrome.scripting.executeScript = async () => {
    throw new Error("frame removed");
  };
  assert.equal((await runBoundReplay(ctx, sender, replay)).success, false);
  assert.deepEqual([...ctx.injectionOperations.values()], ["rejected", "rejected"]);
  assert.equal((await runBoundReplay(ctx, sender, replay)).success, false);
});

test("sends nothing when the page moved or the interceptor is not ready, and may retry", async () => {
  for (const options of [{ href: `${origin}/settings/admin` }, { interceptor: false }]) {
    const { ctx, sender, calls, sent } = fixture(options);
    const first = await runBoundReplay(ctx, sender, replay);
    assert.equal(first.success, false);
    assert.equal(sent.length, 0);
    assert.equal(ctx.injectionOperations.size, 0);
    await runBoundReplay(ctx, sender, replay);
    assert.equal(calls.length, 2);
  }
});

test("an uncertain injection outcome is never retried", async () => {
  const { ctx, sender, calls } = fixture();
  chrome.scripting.executeScript = async (injection) => {
    calls.push(injection);
    throw new Error("frame removed");
  };
  assert.equal((await runBoundReplay(ctx, sender, replay)).success, false);
  assert.equal((await runBoundReplay(ctx, sender, replay)).success, false);
  assert.equal(calls.length, 1);
});

test("replay and request chain never accept each other's operation", async () => {
  const { ctx, sender, calls } = fixture();
  assert.equal((await runBoundRequestChain(ctx, sender, replay)).success, false);
  assert.equal((await runBoundReplay(ctx, sender, { op: REQUEST_CHAIN_OP })).success, false);
  assert.equal(calls.length, 0);
});

test("the router sends the replay op to the bound replay and nothing else to it", async () => {
  for (const [data, executed] of [
    [replay, 1],
    [{ op: REQUEST_CHAIN_OP }, 0],
  ]) {
    const { ctx, sender, calls } = fixture();
    let response;
    await handleMessage(
      Object.assign(ctx, { MESSAGE_ACTIONS, MESSAGE_SOURCES }),
      {
        action: MESSAGE_ACTIONS.INJECT_VIA_SCRIPTING,
        source: MESSAGE_SOURCES.CONTENT_SCRIPT,
        target: MESSAGE_SOURCES.BACKGROUND,
        data,
      },
      sender,
      (value) => (response = value),
    );
    assert.equal(calls.length, executed, data.op);
    assert.equal(response.status, executed ? "executed" : "skipped", data.op);
  }
});

test("content asks only for the bound replay op and never names a URL", () => {
  const content = readFileSync(new URL("../src/content/content.js", import.meta.url), "utf8");
  assert.equal(content.includes("REPLAY_PAGE_FETCH"), false);
  const requests = content.match(/op: "REPLAY_[A-Z_]+"[^}]*}/g) ?? [];
  assert.deepEqual(requests, ['op: "REPLAY_BOUND_DOCUMENT" }']);
});
