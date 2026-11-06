import assert from "node:assert/strict";
import { test } from "node:test";
import { approveProfiles, approvedBackendUrl, validateCaller } from "./session-config.js";

// Its own file: approveProfiles narrows module state for the rest of the process.
test("a build that serves only mainnet refuses every other app and API", () => {
  assert.throws(() => approveProfiles([]), /Unknown endpoint profile/);
  assert.throws(() => approveProfiles(["mainnet", "invented"]), /Unknown endpoint profile/);
  assert.equal(
    validateCaller({ url: "https://app.devnet.umia.finance/a" }, "hosted-devnet").profile,
    "hosted-devnet",
  );

  approveProfiles(["mainnet"]);
  assert.equal(validateCaller({ url: "https://app.umia.finance/a" }, "mainnet").profile, "mainnet");
  for (const [origin, profile] of [
    ["https://app.devnet.umia.finance", "hosted-devnet"],
    ["https://app.testnet.umia.finance", "hosted-testnet"],
    ["https://hub.umia.localhost", "native-devnet"],
  ]) {
    assert.throws(() => validateCaller({ url: `${origin}/a` }, profile), /not configured/);
  }
  assert.throws(
    () => approvedBackendUrl("https://api.devnet.umia.finance/zktls"),
    /Unapproved backend/,
  );
});
