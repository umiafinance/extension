import assert from "node:assert/strict";
import { test } from "node:test";
import { startGrantPage } from "./grant/grantPage.js";

function harness({ search = "?pendingId=pending-1&origins=https%3A%2F%2F*%2F*", answer } = {}) {
  const sent = [];
  const requested = [];
  const views = [];
  const listeners = {};
  const port = {
    onMessage: { addListener: (listener) => (listeners.message = listener) },
    onDisconnect: { addListener: (listener) => (listeners.disconnect = listener) },
    postMessage: (message) => sent.push(message),
  };
  const page = startGrantPage({
    chrome: {
      runtime: { connect: () => port },
      permissions: {
        request: ({ origins }) => {
          requested.push([...origins]);
          return answer ?? Promise.resolve(true);
        },
      },
    },
    search,
    render: (view) => views.push(view),
    setInterval: () => 1,
    clearInterval() {},
  });
  return { page, sent, requested, views, listeners, last: () => views.at(-1) };
}

test("grant page ignores forged query origins and requests only background-approved origins", async () => {
  const { page, sent, requested, listeners, last } = harness();
  assert.equal(last().phase, "loading");
  assert.deepEqual(sent, [{ type: "getPending", pendingId: "pending-1" }]);
  await page.grant();
  assert.deepEqual(requested, []);

  listeners.message({
    type: "ready",
    origins: ["https://*.example.co.uk/*"],
    site: "example.co.uk",
  });
  assert.deepEqual(last(), { phase: "ready", site: "example.co.uk", locked: false });
  await page.grant();
  assert.deepEqual(requested, [["https://*.example.co.uk/*"]]);
  assert.equal(last().phase, "granted");
  assert.deepEqual(sent.at(-1), { type: "granted", pendingId: "pending-1" });
});

test("a second click while Chrome's prompt is open requests nothing more", async () => {
  let answer;
  const { page, requested, listeners, last } = harness({
    answer: new Promise((resolve) => (answer = resolve)),
  });
  listeners.message({ type: "ready", origins: ["https://*.github.com/*"], site: "github.com" });
  const first = page.grant();
  assert.equal(last().locked, true);
  await page.grant();
  page.deny();
  answer(false);
  await first;
  assert.equal(requested.length, 1);
  assert.equal(last().phase, "ready");
});

test("cancel reports a denial once the site is known", () => {
  const { page, sent, listeners } = harness();
  page.deny();
  assert.equal(sent.length, 1);
  listeners.message({ type: "ready", origins: ["https://*.github.com/*"], site: "github.com" });
  page.deny();
  assert.deepEqual(sent.at(-1), { type: "denied", pendingId: "pending-1" });
});

test("a missing pending id, empty origins or a lost worker shows the expired state", () => {
  assert.equal(harness({ search: "" }).last().phase, "expired");

  const empty = harness();
  empty.listeners.message({ type: "ready", origins: [], site: "github.com" });
  assert.equal(empty.last().phase, "expired");

  const lost = harness();
  lost.listeners.disconnect();
  assert.equal(lost.last().phase, "expired");
  lost.listeners.message({
    type: "ready",
    origins: ["https://*.github.com/*"],
    site: "github.com",
  });
  assert.equal(lost.last().phase, "expired");
});
