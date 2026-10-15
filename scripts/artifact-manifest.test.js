import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { assertWorkspaceDependencies, createArtifactManifest } from "./artifact-manifest.js";

const temporary = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const distDir = mkdtempSync(join(tmpdir(), "umia-extension-artifact-"));
  temporary.push(distDir);
  const put = (path, bytes) => {
    const file = join(distDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  };
  put("manifest.json", JSON.stringify({ version: "0.4.0" }));
  put("extensionBackground.js", "background");
  put("browser-rpc/resources/stwo/s2circuits.js", "circuit");
  put("reclaim-browser-extension-sdk/content/content.bundle.js", "sdk");
  const staged = {
    profile: "approved-canonical-set",
    endpointProfiles: [
      {
        profile: "cloud-devnet",
        environment: "devnet",
        callerOrigin: "https://hub.umia.conductor:8443",
      },
    ],
    profileSetSha256: "9".repeat(64),
    activationCatalogueSha256: "8".repeat(64),
    activationCatalogueSize: 8,
    networkConfigInputs: [
      { size: 7, sha256: "7".repeat(64) },
      { size: 6, sha256: "6".repeat(64) },
    ],
    manifestSha256: "a".repeat(64),
    resources: [
      {
        path: "browser-rpc/resources/stwo/s2circuits.js",
        size: 7,
        sha256: createHash("sha256").update("circuit").digest("hex"),
      },
      {
        path: "reclaim-browser-extension-sdk/content/content.bundle.js",
        size: 3,
        sha256: createHash("sha256").update("sdk").digest("hex"),
        source: "sdk",
      },
    ],
  };
  const options = {
    distDir,
    staged,
    sourceSha: "b".repeat(40),
    sourceDirty: false,
    sdkSourceSha256: "c".repeat(64),
    version: "0.4.0",
    sdkVersion: "0.5.2",
    attestorVersion: "5.1.5",
  };
  return { put, options };
}

test("binds source, selected profile, versions and every packaged file", () => {
  const { options } = fixture();
  const artifact = createArtifactManifest(options);
  assert.equal(artifact.sourceSha, "b".repeat(40));
  assert.equal(artifact.profile, "approved-canonical-set");
  assert.equal(artifact.sdkVersion, "0.5.2");
  assert.equal(artifact.attestorVersion, "5.1.5");
  assert.deepEqual(artifact.networkConfigInputs, options.staged.networkConfigInputs);
  assert.equal(artifact.files.length, 4);
  assert.match(artifact.sdkBuildOutputsSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    artifact.files.map((file) => file.path),
    [
      "browser-rpc/resources/stwo/s2circuits.js",
      "extensionBackground.js",
      "manifest.json",
      "reclaim-browser-extension-sdk/content/content.bundle.js",
    ],
  );
});

test("rejects version drift and altered or missing staged resources", () => {
  const { put, options } = fixture();
  assert.throws(() => createArtifactManifest({ ...options, version: "0.3.7" }), /versions differ/);
  assert.throws(
    () => createArtifactManifest({ ...options, attestorVersion: "^5.1.5" }),
    /exact attestor-core/,
  );
  put("browser-rpc/resources/stwo/s2circuits.js", "changed");
  assert.throws(() => createArtifactManifest(options), /missing or altered/);
  rmSync(join(options.distDir, "browser-rpc/resources/stwo/s2circuits.js"));
  assert.throws(() => createArtifactManifest(options), /missing or altered/);
});

test("requires the private workspace packages the extension imports", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const packages = ["@umia/reclaim-browser-extension-sdk", "@umia/zktls"];
  assertWorkspaceDependencies(packageJson, packages);
  for (const version of [undefined, "0.0.1"]) {
    const dependencies = { ...packageJson.dependencies, "@umia/zktls": version };
    assert.throws(() => assertWorkspaceDependencies({ dependencies }, packages), /@umia\/zktls/);
  }
});
