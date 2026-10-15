import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeBoundSessionBackground } from "./sdkBoundSession.js";

test("missing or unsupported SDK route ABI cannot initialize capture", () => {
  const calls = [];
  const sdk = { initializeBackground: (options) => calls.push(options) };
  const resolver = async () => null;
  for (const version of [undefined, null, 0, 2, "1"]) {
    assert.throws(
      () => initializeBoundSessionBackground(sdk, version, resolver),
      /bound-session route contract is unavailable/,
    );
  }
  assert.equal(calls.length, 0);
  initializeBoundSessionBackground(sdk, 1, resolver);
  assert.deepEqual(calls, [{ resolveSessionRoute: resolver }]);
});
