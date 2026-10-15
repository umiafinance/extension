import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertPermissionBaseline,
  assertPrivacyDisclosure,
  assertStoreListingPermissions,
  assertVersionParity,
  checkReleaseSources,
  readReleaseSources,
} from "./release-checks.js";

const clone = (value) => structuredClone(value);

test("the repository's manifest, versions, store listing and privacy notice agree", () => {
  assert.doesNotThrow(() => checkReleaseSources(readReleaseSources()));
});

test("any added or removed permission or host scope fails the permission diff", () => {
  const { manifest, baseline } = readReleaseSources();
  const changes = [
    (m) => m.permissions.push("declarativeNetRequestWithHostAccess"),
    (m) => m.permissions.push("tabs"),
    (m) => m.permissions.splice(m.permissions.indexOf("cookies"), 1),
    (m) => (m.optional_permissions = ["history"]),
    (m) => (m.host_permissions = ["https://*.umia.finance/*"]),
    (m) => m.optional_host_permissions.push("<all_urls>"),
    (m) => m.optional_host_permissions.pop(),
    (m) => (m.content_scripts = [{ matches: ["https://*/*"], js: ["content.js"] }]),
    (m) => m.web_accessible_resources[0].matches.push("<all_urls>"),
    (m) => (m.content_security_policy.extension_pages += " 'unsafe-eval'"),
    (m) => (m.content_security_policy.sandbox = "sandbox allow-scripts"),
    (m) => (m.externally_connectable.matches = ["https://*/*"]),
    (m) => (m.externally_connectable.ids = ["*"]),
    (m) => m.web_accessible_resources[0].resources.push("extensionBackground.js"),
    (m) => m.web_accessible_resources.push({ resources: ["grant.html"], matches: ["https://*/*"] }),
    (m) => m.web_accessible_resources[0].resources.pop(),
    (m) => (m.web_accessible_resources[0].use_dynamic_url = true),
    (m) => (m.content_scripts = [{ matches: [], js: ["content.js"], world: "MAIN" }]),
    (m) => (m.content_scripts = [{ matches: [], js: ["content.js"], all_frames: true }]),
  ];
  for (const change of changes) {
    const changed = clone(manifest);
    change(changed);
    assert.throws(
      () => assertPermissionBaseline(changed, baseline),
      /differ from release-baseline\.json/,
    );
  }
  const reordered = clone(manifest);
  reordered.permissions.reverse();
  assert.doesNotThrow(() => assertPermissionBaseline(reordered, baseline));
});

test("each version mismatch fails parity", () => {
  const sources = readReleaseSources();
  const artifact = {
    extensionVersion: sources.manifest.version,
    sdkVersion: sources.baseline.sdk.version,
    attestorVersion: sources.baseline.sdk.attestorVersion,
  };
  assert.doesNotThrow(() => assertVersionParity({ ...sources, artifact }));
  const changes = [
    (s) => (s.manifest.version = "9.9.9"),
    (s) => (s.packageJson.version = "9.9.9"),
    (s) => (s.packageJson.dependencies[s.baseline.sdk.name] = "0.5.1"),
    (s) => (s.sdkPackage.version = "0.5.1"),
    (s) => (s.sdkPackage.dependencies["@reclaimprotocol/attestor-core"] = "^5.1.3"),
    (s) => (s.baseline.sdk.version = "0.5.1"),
    (s) => (s.artifact.extensionVersion = "9.9.9"),
    (s) => (s.artifact.sdkVersion = "0.5.0"),
    (s) => (s.artifact.attestorVersion = "5.1.1"),
  ];
  for (const change of changes) {
    const changed = clone({ ...sources, forbidden: undefined, artifact });
    change(changed);
    assert.throws(() => assertVersionParity(changed), /release versions differ/);
  }
});

test("store listing must justify exactly the requested permissions and host scopes", () => {
  const { storeListing, manifest } = readReleaseSources();
  const added = clone(manifest);
  added.permissions.push("alarms");
  assert.throws(() => assertStoreListingPermissions(storeListing, added), /justifies/);
  const removed = clone(manifest);
  removed.permissions = removed.permissions.filter((permission) => permission !== "storage");
  assert.throws(() => assertStoreListingPermissions(storeListing, removed), /justifies/);
  const host = clone(manifest);
  host.optional_host_permissions.push("http://127.0.0.1/*");
  assert.throws(() => assertStoreListingPermissions(storeListing, host), /optional host/);
  assert.throws(
    () =>
      assertStoreListingPermissions(
        storeListing.replace("- **`cookies`:**", "- cookies:"),
        manifest,
      ),
    /justifies/,
  );
  assert.throws(() => assertStoreListingPermissions("# empty", manifest), /no permission/);
});

test("privacy notice rejects hosted or non-Umia endpoints and requires the disclosures", () => {
  const { privacy, forbidden } = readReleaseSources();
  for (const endpoint of [
    "https://logs.reclaimprotocol.org/api",
    "https://api.country.is",
    "https://ipwho.is/",
    "https://ipapi.co/json/",
    "https://analytics.example.com/collect",
    "https://umia.finance.evil.example/",
  ]) {
    assert.throws(
      () => assertPrivacyDisclosure(`${privacy}\n${endpoint}\n`, forbidden),
      /endpoint/,
    );
  }
  assert.doesNotThrow(() =>
    assertPrivacyDisclosure(`${privacy}\nhttps://api.devnet.umia.finance/zktls\n`, forbidden),
  );
  for (const word of ["telemetry", "attestor"]) {
    const stripped = privacy.replace(new RegExp(word, "gi"), "x");
    assert.throws(() => assertPrivacyDisclosure(stripped, forbidden), new RegExp(word));
  }
});
