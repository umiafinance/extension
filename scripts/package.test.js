import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileRecord, sha256 } from "./artifact-files.js";
import { createArtifactManifest } from "./artifact-manifest.js";
import { packageExtension } from "./package.js";
import { assertPackageMatchesArtifact, readReleaseSources } from "./release-checks.js";
import { createZip, readZip } from "./zip.js";

const temporary = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A synthetic build: the real manifest plus a few small files standing in for the
// mirrored circuits and SDK bundles, attested by the real createArtifactManifest.
function syntheticBuild() {
  const root = mkdtempSync(join(tmpdir(), "umia-extension-package-"));
  temporary.push(root);
  const distDir = join(root, "dist");
  const sources = readReleaseSources();
  const put = (path, bytes) => {
    const file = join(distDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  };
  put("manifest.json", `${JSON.stringify(sources.manifest, null, 2)}\n`);
  put("extensionBackground.js", "background");
  put("browser-rpc/resources/stwo/s2circuits_bg.wasm", Buffer.from([0, 97, 115, 109, 1]));
  put("reclaim-browser-extension-sdk/content/content.bundle.js", "sdk-content");
  const staged = ["browser-rpc/resources/stwo/s2circuits_bg.wasm"].map((path) =>
    fileRecord(path, join(distDir, path)),
  );
  const sdk = fileRecord(
    "reclaim-browser-extension-sdk/content/content.bundle.js",
    join(distDir, "reclaim-browser-extension-sdk/content/content.bundle.js"),
  );
  const artifact = createArtifactManifest({
    distDir,
    staged: {
      profile: "approved-canonical-set",
      endpointProfiles: [],
      profileSetSha256: "9".repeat(64),
      activationCatalogueSha256: "8".repeat(64),
      activationCatalogueSize: 8,
      networkConfigInputs: [],
      manifestSha256: "a".repeat(64),
      resources: [...staged, { ...sdk, source: "sdk" }],
    },
    sourceSha: "b".repeat(40),
    sourceDirty: false,
    sdkSourceSha256: "c".repeat(64),
    version: sources.packageJson.version,
    sdkVersion: sources.sdkPackage.version,
    attestorVersion: sources.sdkPackage.dependencies["@reclaimprotocol/attestor-core"],
  });
  put("artifact-manifest.json", `${JSON.stringify(artifact, null, 2)}\n`);
  return { root, distDir, sources, artifact, put, outFile: join(root, "umia.zip") };
}

test("the ZIP holds exactly the attested files, byte for byte, and is reproducible", () => {
  const build = syntheticBuild();
  const result = packageExtension(build);
  assert.equal(result.files, 5);
  const zip = readFileSync(build.outFile);
  const entries = readZip(zip);
  assert.deepEqual(
    entries.map((entry) => entry.path),
    [...build.artifact.files.map((file) => file.path), "artifact-manifest.json"].sort(),
  );
  for (const file of build.artifact.files) {
    const entry = entries.find(({ path }) => path === file.path);
    assert.equal(sha256(entry.bytes), file.sha256);
  }
  assert.equal(build.artifact.sourceSha, "b".repeat(40));
  assert.match(build.artifact.sdkBuildOutputsSha256, /^[a-f0-9]{64}$/);

  const again = join(build.root, "again.zip");
  packageExtension({ ...build, outFile: again });
  assert.equal(sha256(readFileSync(again)), sha256(zip));
});

test("a build that drifted from its attestation is never packaged", () => {
  for (const change of [
    (b) => b.put("extensionBackground.js", "tampered"),
    (b) => b.put("unattested.js", "extra"),
    (b) => rmSync(join(b.distDir, "reclaim-browser-extension-sdk/content/content.bundle.js")),
    (b) =>
      b.put(
        "artifact-manifest.json",
        JSON.stringify({
          ...b.artifact,
          files: b.artifact.files.map((file) => ({ ...file, sha256: "0".repeat(64) })),
        }),
      ),
  ]) {
    const build = syntheticBuild();
    change(build);
    assert.throws(() => packageExtension(build), /package|artifact/);
    assert.throws(() => readFileSync(build.outFile), /ENOENT/);
  }
});

test("a built manifest with drifted permissions or versions is never packaged", () => {
  for (const change of [
    (m) => m.permissions.push("tabs"),
    (m) => (m.version = "9.9.9"),
    (m) => (m.externally_connectable = { matches: ["https://*/*"] }),
    (m) => m.web_accessible_resources[0].resources.push("extensionBackground.js"),
  ]) {
    const build = syntheticBuild();
    const manifest = JSON.parse(readFileSync(join(build.distDir, "manifest.json"), "utf8"));
    change(manifest);
    build.put("manifest.json", JSON.stringify(manifest));
    assert.throws(() => packageExtension(build), /release-baseline|versions differ/);
  }
});

test("a ZIP with missing, extra, altered or duplicated entries fails the artifact check", () => {
  const { artifact, distDir } = syntheticBuild();
  const entries = [...artifact.files.map((file) => file.path), "artifact-manifest.json"].map(
    (path) => ({ path, bytes: readFileSync(join(distDir, path)) }),
  );
  assert.doesNotThrow(() => assertPackageMatchesArtifact(readZip(createZip(entries)), artifact));
  const variants = [
    entries.slice(1),
    [...entries, { path: "extra.js", bytes: Buffer.from("x") }],
    entries.map((entry, index) => (index === 0 ? { ...entry, bytes: Buffer.from("y") } : entry)),
    [...entries, entries[0]],
    entries.filter((entry) => entry.path !== "artifact-manifest.json"),
  ];
  for (const variant of variants) {
    assert.throws(() => assertPackageMatchesArtifact(readZip(createZip(variant)), artifact));
  }
  const corrupt = createZip(entries);
  // First entry's compressed data starts after its 30-byte header and name.
  corrupt[30 + "artifact-manifest.json".length + 4] ^= 0xff;
  assert.throws(() => readZip(corrupt), /corrupt|ZIP/);
});

test("built caller origins must equal the attested endpoint profiles", () => {
  const build = syntheticBuild();
  const profiles = [{ profile: "cloud-devnet", callerOrigin: "https://hub.umia.conductor:8443" }];
  const manifest = JSON.parse(readFileSync(join(build.distDir, "manifest.json"), "utf8"));
  manifest.externally_connectable = { matches: ["https://hub.umia.conductor:8443/*"] };
  build.put("manifest.json", JSON.stringify(manifest));
  const resign = (endpointProfiles) => {
    const files = build.artifact.files.map((file) =>
      file.path === "manifest.json" ? fileRecord(file.path, join(build.distDir, file.path)) : file,
    );
    build.put(
      "artifact-manifest.json",
      JSON.stringify({ ...build.artifact, endpointProfiles, files }),
    );
  };
  resign(profiles);
  assert.doesNotThrow(() => packageExtension(build));
  resign([]);
  assert.throws(() => packageExtension(build), /externallyConnectableMatches added/);
  resign([...profiles, { profile: "native-devnet", callerOrigin: "https://hub.umia.localhost" }]);
  assert.throws(() => packageExtension(build), /externallyConnectableMatches removed/);
});
