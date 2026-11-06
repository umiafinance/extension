import assert from "node:assert/strict";
import { test } from "node:test";
import { followTheme } from "./theme.js";

function fakes({ osDark = false } = {}) {
  let finishRead;
  const listeners = { storage: null, media: null };
  const storage = {
    local: { get: () => new Promise((resolve) => (finishRead = resolve)) },
    onChanged: {
      addListener: (listener) => (listeners.storage = listener),
      removeListener: (listener) => listener === listeners.storage && (listeners.storage = null),
    },
  };
  const media = {
    matches: osDark,
    addEventListener: (_type, listener) => (listeners.media = listener),
    removeEventListener: () => (listeners.media = null),
  };
  return { storage, media, listeners, finishRead: (value) => finishRead(value) };
}

test("the widget follows the saved app choice, and a late initial read never undoes a change", async () => {
  const element = { dataset: {} };
  const { storage, media, listeners, finishRead } = fakes();
  const theme = followTheme(element, { storage, media });
  assert.equal(element.dataset.umiaTheme, "light");
  listeners.storage({ umiaTheme: { newValue: "dark" } }, "local");
  assert.equal(element.dataset.umiaTheme, "dark");
  finishRead({ umiaTheme: "light" });
  await theme.ready;
  assert.equal(element.dataset.umiaTheme, "dark");
  listeners.storage({ umiaTheme: { newValue: "light" } }, "sync");
  assert.equal(element.dataset.umiaTheme, "dark", "only extension-local storage counts");
});

test("no saved choice, or system, follows the OS and its later changes", async () => {
  const element = { dataset: {} };
  const { storage, media, listeners, finishRead } = fakes({ osDark: true });
  const theme = followTheme(element, { storage, media });
  finishRead({ umiaTheme: "system" });
  await theme.ready;
  assert.equal(element.dataset.umiaTheme, "dark");
  media.matches = false;
  listeners.media();
  assert.equal(element.dataset.umiaTheme, "light");
  theme.dispose();
  assert.equal(listeners.storage, null);
  assert.equal(listeners.media, null);
});

test("an unreadable store still settles on the OS theme", async () => {
  const element = { dataset: {} };
  const storage = { local: { get: () => Promise.reject(new Error("gone")) } };
  await followTheme(element, { storage, media: { matches: true } }).ready;
  assert.equal(element.dataset.umiaTheme, "dark");
});
