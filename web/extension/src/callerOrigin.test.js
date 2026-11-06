import assert from "node:assert/strict";
import { test } from "node:test";
import {
  exactExternalCallerPattern,
  isAllowedExternalCaller,
  normalizeOrigin,
} from "./callerOrigin.js";

const allowed = "https://hub.umia.example:8443";
const allowedOrigins = new Set([allowed, "https://hub.umia.localhost"]);

test("direct extension control accepts only the selected top-frame origin", () => {
  assert.equal(normalizeOrigin("https://hub.umia.localhost:443"), "https://hub.umia.localhost:443");
  assert.equal(isAllowedExternalCaller({ origin: allowed, frameId: 0 }, allowedOrigins), true);
  assert.equal(
    exactExternalCallerPattern({ origin: allowed, frameId: 0 }, allowedOrigins),
    "https://hub.umia.example:8443/*",
  );
  assert.equal(
    exactExternalCallerPattern(
      { origin: "https://hub.umia.localhost", frameId: 0 },
      allowedOrigins,
    ),
    "https://hub.umia.localhost:443/*",
  );
  assert.equal(
    isAllowedExternalCaller({ url: `${allowed}/sandbox/zktls-verify`, frameId: 0 }, allowedOrigins),
    true,
  );
  for (const sender of [
    { origin: "https://hub.umia.example" },
    { origin: "https://admin.umia.example:8443" },
    { origin: "https://hub.umia.example.evil:8443" },
    { origin: allowed, frameId: 1 },
    { origin: allowed },
    { origin: allowed, frameId: null },
    { origin: allowed, frameId: "0" },
    { origin: allowed, frameId: -1 },
    { origin: allowed, frameId: 0.5 },
    { origin: allowed, url: "https://admin.umia.example:8443/" },
    { url: "garbage" },
  ]) {
    assert.equal(isAllowedExternalCaller(sender, allowedOrigins), false);
    assert.equal(exactExternalCallerPattern(sender, allowedOrigins), null);
  }
});
