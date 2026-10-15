import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { manifestForProfiles } from "./profile-manifest.js";

const template = {
  manifest_version: 3,
  permissions: ["offscreen", "cookies", "scripting", "storage"],
  externally_connectable: { matches: [] },
};

const cloud = {
  profile: "cloud-devnet",
  callerOrigin: "https://hub.umia.conductor:8443",
};
const native = {
  profile: "native-devnet",
  callerOrigin: "https://hub.umia.localhost",
};

test("one build emits only approved canonical caller patterns", () => {
  const output = manifestForProfiles(template, [
    cloud,
    native,
    {
      ...cloud,
      profile: "cloud-testnet",
    },
  ]);
  assert.deepEqual(output.externally_connectable.matches, [
    "https://hub.umia.conductor:8443/*",
    "https://hub.umia.localhost:443/*",
  ]);
  assert.deepEqual(output.permissions, template.permissions);
  assert.deepEqual(template.externally_connectable.matches, []);
});

test("rejects broad source permissions and ambiguous caller URLs", () => {
  assert.throws(
    () =>
      manifestForProfiles(
        {
          ...template,
          externally_connectable: { matches: ["https://*.umia.finance/*"] },
        },
        [cloud],
      ),
    /trust union/,
  );
  assert.throws(() => manifestForProfiles(template, []), /canonical caller profiles/);
  for (const callerOrigin of [
    "http://hub.umia.conductor:8443",
    "https://hub.umia.conductor:8443/path",
    "https://hub.umia.conductor:8443?token=secret",
    "https://user@hub.umia.conductor:8443",
  ]) {
    assert.throws(
      () => manifestForProfiles(template, [{ ...cloud, callerOrigin }]),
      /canonical HTTPS/,
    );
  }
});

test("shipped manifest grants no declarativeNetRequest permission", () => {
  const shipped = JSON.parse(readFileSync(new URL("../public/manifest.json", import.meta.url)));
  assert.equal(
    shipped.permissions.some((permission) => permission.startsWith("declarativeNetRequest")),
    false,
  );
});

// A page that could frame the offscreen document would receive every GENERATE_PROOF broadcast.
test("web pages can load only the provider-page bundles, never the offscreen document", () => {
  const shipped = JSON.parse(readFileSync(new URL("../public/manifest.json", import.meta.url)));
  const exposed = shipped.web_accessible_resources.flatMap((entry) => entry.resources);
  assert.deepEqual(exposed.sort(), [
    "reclaim-browser-extension-sdk/content/components/reclaim-provider-verification-popup.css",
    "reclaim-browser-extension-sdk/content/components/reclaim-provider-verification-popup.html",
    "reclaim-browser-extension-sdk/interceptor/injection-scripts.bundle.js",
    "reclaim-browser-extension-sdk/interceptor/network-interceptor.bundle.js",
  ]);
});
