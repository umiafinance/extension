import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const grantScript = readFileSync(new URL("../public/grant.js", import.meta.url), "utf8");
const themeScript = readFileSync(new URL("../public/grant-theme.js", import.meta.url), "utf8");

test("grant window follows the saved Hub choice and later theme changes", async () => {
  const root = { dataset: {} };
  let onChanged;
  let finishRead;
  runInNewContext(themeScript, {
    document: { documentElement: root },
    chrome: {
      storage: {
        local: { get: () => new Promise((resolve) => (finishRead = resolve)) },
        onChanged: { addListener: (listener) => (onChanged = listener) },
      },
    },
  });
  onChanged({ umiaTheme: { newValue: "dark" } }, "local");
  assert.equal(root.dataset.umiaTheme, "dark");
  assert.equal(root.dataset.umiaThemeReady, "true");
  finishRead({ umiaTheme: "light" });
  await Promise.resolve();
  assert.equal(root.dataset.umiaTheme, "dark", "a late initial read must not undo a change");
  onChanged({ umiaTheme: { newValue: "system" } }, "local");
  assert.equal(root.dataset.umiaTheme, undefined);
});

test("grant page ignores forged query origins and requests only background-approved origins", async () => {
  const elements = Object.fromEntries(
    ["status", "progress", "grant", "deny"].map((id) => [
      id,
      {
        hidden: true,
        disabled: false,
        events: {},
        addEventListener(type, handler) {
          this.events[type] = handler;
        },
      },
    ]),
  );
  const site = { textContent: "this site" };
  const sent = [];
  const requested = [];
  let onMessage;
  const port = {
    onMessage: {
      addListener: (listener) => {
        onMessage = listener;
      },
    },
    onDisconnect: { addListener() {} },
    postMessage: (message) => sent.push(message),
  };
  runInNewContext(grantScript, {
    URLSearchParams,
    location: { search: "?pendingId=pending-1&origins=https%3A%2F%2F*%2F*" },
    document: {
      getElementById: (id) => elements[id],
      querySelectorAll: () => [site],
    },
    chrome: {
      runtime: { connect: () => port },
      permissions: {
        request: async ({ origins }) => {
          requested.push([...origins]);
          return true;
        },
      },
    },
    setInterval: () => 1,
    clearInterval() {},
  });
  assert.equal(elements.grant.disabled, true);
  assert.equal(
    JSON.stringify(sent),
    JSON.stringify([{ type: "getPending", pendingId: "pending-1" }]),
  );
  await elements.grant.events.click();
  assert.deepEqual(requested, []);
  onMessage({ type: "ready", origins: ["https://*.example.co.uk/*"], site: "example.co.uk" });
  assert.equal(site.textContent, "example.co.uk");
  assert.equal(elements.grant.disabled, false);
  await elements.grant.events.click();
  assert.deepEqual(requested, [["https://*.example.co.uk/*"]]);
});
