import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { loadCanonicalTrust } from "./canonical-profiles.js";

const repoRoot = resolve(import.meta.dirname, "../../..");

test("the dev channel packages every canonical Umia app with the one attestor they share", async () => {
  const trust = await loadCanonicalTrust(repoRoot, "dev");
  assert.equal(trust.channel, "dev");
  assert.ok(trust.endpointProfiles.length > 1);
  for (const profile of trust.endpointProfiles) {
    assert.equal(profile.attestorUrl, trust.attestor.url);
  }
  assert.deepEqual(trust.eligibleCallerOrigins, [
    ...new Set(trust.endpointProfiles.map((profile) => profile.callerOrigin)),
  ]);
  assert.match(trust.profileSetSha256, /^[a-f0-9]{64}$/);
});

test("the store channel packages only the production Umia app", async () => {
  const trust = await loadCanonicalTrust(repoRoot, "store");
  assert.deepEqual(
    trust.endpointProfiles.map((profile) => profile.environment),
    ["mainnet"],
  );
  assert.deepEqual(trust.eligibleCallerOrigins, ["https://app.umia.finance"]);
});
