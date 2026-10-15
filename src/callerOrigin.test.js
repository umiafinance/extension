import assert from "node:assert/strict";
import { test } from "node:test";
import {
  exactExternalCallerPattern,
  isAllowedExternalCaller,
  isBroadInfrastructurePattern,
  normalizeOrigin,
} from "./callerOrigin.js";

const allowed = "https://hub.umia.conductor:8443";
const allowedOrigins = new Set([allowed, "https://hub.umia.localhost"]);

test("direct extension control accepts only the selected top-frame origin", () => {
  assert.equal(normalizeOrigin("https://hub.umia.localhost:443"), "https://hub.umia.localhost:443");
  assert.equal(isAllowedExternalCaller({ origin: allowed, frameId: 0 }, allowedOrigins), true);
  assert.equal(
    exactExternalCallerPattern({ origin: allowed, frameId: 0 }, allowedOrigins),
    "https://hub.umia.conductor:8443/*",
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
    { origin: "https://hub.umia.conductor" },
    { origin: "https://admin.umia.conductor:8443" },
    { origin: "https://hub.umia.conductor.evil:8443" },
    { origin: allowed, frameId: 1 },
    { origin: allowed },
    { origin: allowed, frameId: null },
    { origin: allowed, frameId: "0" },
    { origin: allowed, frameId: -1 },
    { origin: allowed, frameId: 0.5 },
    { origin: allowed, url: "https://admin.umia.conductor:8443/" },
    { url: "garbage" },
  ]) {
    assert.equal(isAllowedExternalCaller(sender, allowedOrigins), false);
    assert.equal(exactExternalCallerPattern(sender, allowedOrigins), null);
  }
});

test("shared infrastructure wildcards cannot become merged provider grants", () => {
  for (const pattern of [
    "https://*.umia.conductor/*",
    "https://*.fly.dev/*",
    "https://*.conductor/*",
    "https://*.fly.dev/private/*",
    "https://*.umia.conductor:8443/private/*",
  ]) {
    assert.equal(isBroadInfrastructurePattern(pattern, allowedOrigins), true);
  }
  assert.equal(isBroadInfrastructurePattern("https://*.github.com/*", allowedOrigins), false);
  assert.equal(isBroadInfrastructurePattern("https://provider.example/*", allowedOrigins), false);
});

test("shared tenant hosts stay protected without an activated caller there", () => {
  const conductorOnly = new Set([allowed]);
  for (const pattern of ["https://*.umia.localhost/*", "https://*.fly.io/*"]) {
    assert.equal(isBroadInfrastructurePattern(pattern, conductorOnly), true);
  }
});
