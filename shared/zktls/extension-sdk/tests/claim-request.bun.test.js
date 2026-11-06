import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { describeRequestMatch } from "../src/utils/claim-creator/network-filter.js";
import { MESSAGE_ACTIONS, MESSAGE_SOURCES } from "../src/utils/constants/interfaces.js";
import { withRequestKeys } from "../src/utils/provider-normalization.js";

globalThis.chrome = {
  runtime: { id: "installed-extension", sendMessage: async () => ({}) },
  tabs: { sendMessage: async () => ({}) },
};
const { handleMessage } = await import("../src/background/messageRouter.js");

// ETHGlobal's shape: a credentialed GraphQL POST whose body and response the recipe pins.
const ethglobal = {
  requestHash: "0xethglobal",
  url: "https://api2.ethglobal.com/graphql",
  urlType: "TEMPLATE",
  method: "POST",
  bodySniff: { enabled: true, template: '{"query":"{ getUserSelf { uuid } }"}' },
  responseMatches: [{ value: '"uuid":"{{ethglobalhackathon}}"', type: "contains" }],
  responseRedactions: [{ regex: '"uuid":"(?<ethglobalhackathon>[A-Za-z0-9_-]+)"' }],
};
// Fairscale's shape: its POST only fires inside a fairscale.xyz frame.
const fairscale = {
  requestHash: "0xfairscale",
  url: "https://fairscale.xyz/api/embed/authorize",
  urlType: "TEMPLATE",
  method: "POST",
  responseMatches: [{ value: '"authorized":true', type: "contains" }],
  responseRedactions: [{ regex: '"authorized":true' }],
};
const injectable = {
  requestHash: "0xinjected",
  url: "https://api2.ethglobal.com/v1/me",
  urlType: "CONSTANT",
  method: "GET",
  responseMatches: [{ value: '"id":"{{ethglobalhackathon}}"', type: "contains" }],
};

function harness() {
  const processed = [];
  const ctx = {
    MESSAGE_ACTIONS,
    MESSAGE_SOURCES,
    sessionId: "bound-one",
    providerLoginUrl: "https://ethglobal.com/home",
    activeTabId: 91,
    managedTabs: new Set([91]),
    filteredRequests: new Map(),
    parameters: {},
    providerData: { requestData: [ethglobal, fairscale], allowedInjectedRequestData: [injectable] },
    session: {
      umia: {
        attestorAuth: {
          data: { hostWhitelist: ["api2.ethglobal.com", "ethglobal.com", "fairscale.xyz"] },
        },
      },
    },
    processFilteredRequest: async (request, criteria, sessionId, loginUrl) => {
      processed.push({ request, criteria, sessionId, loginUrl });
      return { success: true };
    },
  };
  const send = async (action, data, sender = topFrame) => {
    let reply;
    await handleMessage(
      ctx,
      { action, source: MESSAGE_SOURCES.CONTENT_SCRIPT, target: MESSAGE_SOURCES.BACKGROUND, data },
      sender,
      (response) => (reply = response),
    );
    return reply;
  };
  return { ctx, processed, send };
}

const topFrame = {
  id: "installed-extension",
  tab: { id: 91 },
  frameId: 0,
  documentId: "top-document",
  documentLifecycle: "active",
  origin: "https://ethglobal.com",
  url: "https://ethglobal.com/home",
};
const fairscaleFrame = {
  ...topFrame,
  frameId: 4,
  documentId: "embed-document",
  origin: "https://fairscale.xyz",
  url: "https://fairscale.xyz/embed",
};

const graphql = (extra = {}) => ({
  url: ethglobal.url,
  method: "POST",
  headers: {
    "content-type": "application/json",
    Cookie: "page=chosen",
    origin: "https://evil",
    Referer: "https://evil/",
  },
  body: '{"query":"{ getUserSelf { uuid } }"}',
  responseText: '{"uuid":"abc-123"}',
  ...extra,
});

test("a matched request is claimed with the pinned recipe entry, never the page's criteria", async () => {
  const { processed, send } = harness();
  const reply = await send(MESSAGE_ACTIONS.FILTERED_REQUEST_FOUND, {
    requestHash: ethglobal.requestHash,
    request: graphql({ cookieStr: "page=cookie", pageOrigin: "https://evil", referer: "x" }),
    criteria: { requestHash: ethglobal.requestHash, url: "https://evil.example/{{a}}" },
    loginUrl: "https://evil.example",
    sessionId: "other-session",
  });
  assert.equal(reply.success, true);
  assert.equal(processed.length, 1);
  const [{ request, criteria, sessionId, loginUrl }] = processed;
  assert.equal(criteria, ethglobal);
  assert.equal(sessionId, "bound-one");
  assert.equal(loginUrl, "https://ethglobal.com/home");
  assert.deepEqual(request.headers, { "content-type": "application/json" });
  for (const field of ["cookieStr", "pageOrigin", "referer"]) assert.equal(field in request, false);
});

test("a later matching response clears an earlier criteria miss", async () => {
  const { ctx, send } = harness();
  ctx.responseMatchFailures = new Set([ethglobal.requestHash]);
  const reply = await send(MESSAGE_ACTIONS.FILTERED_REQUEST_FOUND, {
    requestHash: ethglobal.requestHash,
    request: graphql(),
  });
  assert.equal(reply.success, true);
  assert.equal(ctx.responseMatchFailures.has(ethglobal.requestHash), false);
});

test("a request the recipe entry does not describe is refused", async () => {
  const cases = [
    { requestHash: "0xunknown", request: graphql() },
    { request: graphql() },
    {
      requestHash: ethglobal.requestHash,
      request: graphql({ url: "https://evil.example/graphql" }),
    },
    { requestHash: ethglobal.requestHash, request: graphql({ method: "GET" }) },
    { requestHash: ethglobal.requestHash, request: graphql({ body: '{"query":"mutation"}' }) },
    { requestHash: ethglobal.requestHash, request: graphql({ responseText: '{"id":1}' }) },
    // Same recipe entry, but the host is not in the signed whitelist.
    {
      requestHash: fairscale.requestHash,
      request: { ...graphql(), url: "https://fairscale.co/api/embed/authorize" },
    },
  ];
  for (const data of cases) {
    const { processed, send } = harness();
    const reply = await send(MESSAGE_ACTIONS.FILTERED_REQUEST_FOUND, data);
    assert.equal(reply.success, false, JSON.stringify(data));
    assert.equal(processed.length, 0);
  }
});

test("only the live verification tab's top frame or a signed-host subframe may claim", async () => {
  const data = { requestHash: ethglobal.requestHash, request: graphql() };
  const refused = [
    { ...topFrame, id: "other-extension" },
    { ...topFrame, tab: { id: 12 } },
    { ...topFrame, documentId: undefined },
    { ...topFrame, documentLifecycle: "prerender" },
    { ...fairscaleFrame, origin: "https://ads.example", url: "https://ads.example/frame" },
    { ...fairscaleFrame, url: "https://ads.example/frame" },
    { ...fairscaleFrame, origin: undefined },
  ];
  for (const sender of refused) {
    const { processed, send } = harness();
    assert.equal((await send(MESSAGE_ACTIONS.FILTERED_REQUEST_FOUND, data, sender)).success, false);
    assert.equal(processed.length, 0);
  }
  const { ctx, processed, send } = harness();
  ctx.managedTabs.add(12);
  assert.equal(
    (await send(MESSAGE_ACTIONS.FILTERED_REQUEST_FOUND, data, { ...topFrame, tab: { id: 12 } }))
      .success,
    false,
  );
  assert.equal(processed.length, 0);
});

test("a Fairscale-shaped request inside a signed-host frame is claimed", async () => {
  const { processed, send } = harness();
  const reply = await send(
    MESSAGE_ACTIONS.FILTERED_REQUEST_FOUND,
    {
      requestHash: fairscale.requestHash,
      request: {
        url: fairscale.url,
        method: "POST",
        body: "{}",
        responseText: '{"authorized":true}',
      },
    },
    fairscaleFrame,
  );
  assert.equal(reply.success, true);
  assert.equal(processed[0].criteria, fairscale);
});

test("an injected-request entry is never claimable, by any message", async () => {
  const { processed, send } = harness();
  const injected = { url: injectable.url, method: "GET", responseText: '{"id":"abc-123"}' };
  for (const action of ["REQUEST_CLAIM", MESSAGE_ACTIONS.FILTERED_REQUEST_FOUND]) {
    const reply = await send(action, { requestHash: injectable.requestHash, request: injected });
    assert.notEqual(reply?.success, true);
  }
  assert.equal(processed.length, 0);
});

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const shapes = read("./fixtures/reclaim-provider-shapes.json");
const providerShape = (id) => shapes[id];

// Published recipes as served, each with a request and response a real session observes.
const PUBLISHED = [
  {
    name: "ETHGlobal",
    config: providerShape("ethglobal"),
    request: {
      url: "https://api2.ethglobal.com/graphql",
      method: "POST",
      body: providerShape("ethglobal").requestData[0].bodySniff.template,
      responseText:
        '{"data":{"getUserSelf":{"uuid":"eg-user-1"},"getAttendeeSelf":[{"id":"a1","hackers":[]}]}}',
    },
  },
  {
    name: "Devfolio",
    config: providerShape("devfolio"),
    request: {
      url: "https://api.devfolio.co/v1/graphql",
      method: "POST",
      body: providerShape("devfolio").requestData[0].bodySniff.template,
      responseText: '{"data":{"me":{"uuid":"df-user-1","user_hackathons":[{"uuid":"h1"}]}}}',
    },
  },
  {
    name: "Fairscale twin",
    config: providerShape("tw-fairscale"),
    sender: fairscaleFrame,
    request: {
      url: "https://fairscale.xyz/api/embed/authorize",
      method: "POST",
      body: '{"appId":"umia-finance","wallet":"W","token":"T","privyUserId":"P"}',
      responseText: '{"authorized":false,"wallet":"SyntheticTestWa11et1111111111111111111111111"}',
    },
  },
  {
    name: "GitHub",
    config: providerShape("github"),
    request: {
      url: "https://github.com/settings/profile",
      method: "GET",
      responseText: '<span class="color-fg-muted">(octocat)</span>',
    },
  },
];

test("every published recipe shape is claimed through the key content names it by", async () => {
  for (const { name, config, request, sender = topFrame } of PUBLISHED) {
    const { ctx, processed, send } = harness();
    ctx.providerData = withRequestKeys(config);
    ctx.session.umia.attestorAuth.data.hostWhitelist = [
      new URL(request.url).hostname,
      new URL(sender.origin).hostname,
    ];
    // What content does: match against the keyed recipe it received, then name the entry.
    const entry = ctx.providerData.requestData.find(
      (criteria) => describeRequestMatch({ headers: {}, ...request }, criteria, {}).matched,
    );
    assert.ok(entry, name);
    const reply = await send(
      MESSAGE_ACTIONS.FILTERED_REQUEST_FOUND,
      { requestHash: entry.requestHash, request },
      sender,
    );
    assert.equal(reply.success, true, name);
    assert.equal(processed[0].criteria, entry, name);
  }
});

test("published recipes without committed hashes are keyed by position", () => {
  const keys = PUBLISHED.map(({ config }) => withRequestKeys(config).requestData[0].requestHash);
  assert.deepEqual(keys, Array(PUBLISHED.length).fill("requestData[0]"));
});

test("a request is refused under any key but its own entry's", async () => {
  const h = `0x${"a".repeat(64)}`;
  const entry = (path, requestHash) => ({
    url: `https://api2.ethglobal.com/${path}`,
    urlType: "CONSTANT",
    method: "GET",
    responseMatches: [{ value: '"ok":true', type: "contains" }],
    ...(requestHash ? { requestHash } : {}),
  });
  const request = (path) => ({
    url: `https://api2.ethglobal.com/${path}`,
    method: "GET",
    responseText: '{"ok":true}',
  });
  const cases = [
    ["one", "requestData[0]", true],
    ["two", h, true],
    ["three", "requestData[2]", true],
    // A positional key and a duplicate stored hash each name only their own entry.
    ["two", "requestData[0]", false],
    ["three", h, false],
    ["one", "requestData[2]", false],
  ];
  for (const [path, requestHash, accepted] of cases) {
    const { ctx, processed, send } = harness();
    ctx.providerData = withRequestKeys({
      requestData: [entry("one"), entry("two", h), entry("three", h)],
    });
    const reply = await send(MESSAGE_ACTIONS.FILTERED_REQUEST_FOUND, {
      requestHash,
      request: request(path),
    });
    assert.equal(reply.success, accepted, `${path} as ${requestHash}`);
    assert.equal(processed.length, accepted ? 1 : 0);
  }
});
