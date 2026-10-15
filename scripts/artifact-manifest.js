import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSameActivationInput, loadActivationBuildInput } from "./activation-build-input.js";
import { fileRecord, listFiles, sha256 } from "./artifact-files.js";
import { expectedMirrorOutputs, expectedSdkOutputs, provenanceNotice } from "./setup.js";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(extensionRoot, "../..");
const dist = join(extensionRoot, "dist");

function digestRecords(records) {
  return sha256(
    records
      .map(({ path, size, sha256: digest }) => `${path}\0${size}\0${digest}\n`)
      .sort()
      .join(""),
  );
}

export function assertWorkspaceDependencies(packageJson, names) {
  for (const name of names) {
    if (packageJson.dependencies?.[name] !== "workspace:*") {
      throw new Error(`extension does not depend on workspace package ${name}`);
    }
  }
}

export function createArtifactManifest({
  distDir,
  staged,
  sourceSha,
  sourceDirty,
  sdkSourceSha256,
  version,
  sdkVersion,
  attestorVersion,
}) {
  const manifest = JSON.parse(readFileSync(join(distDir, "manifest.json"), "utf8"));
  if (manifest.version !== version)
    throw new Error("extension package and manifest versions differ");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(attestorVersion ?? "")) {
    throw new Error("private SDK must pin one exact attestor-core version");
  }
  const files = listFiles(distDir)
    .filter((path) => path !== "artifact-manifest.json")
    .sort()
    .map((path) => {
      const record = fileRecord(path, join(distDir, path));
      if (record.size === 0) throw new Error(`empty artifact file: ${path}`);
      return record;
    });
  const byPath = new Map(files.map((file) => [file.path, file]));
  if (new Set(staged.resources.map((resource) => resource.path)).size !== staged.resources.length) {
    throw new Error("duplicate staged resource path");
  }
  for (const resource of staged.resources) {
    const output = byPath.get(resource.path);
    if (!output || output.size !== resource.size || output.sha256 !== resource.sha256) {
      throw new Error(`staged resource missing or altered: ${resource.path}`);
    }
  }
  const sdkOutputs = staged.resources.filter((resource) => resource.source === "sdk");
  if (sdkOutputs.length === 0) throw new Error("private SDK build outputs were not staged");
  return {
    schemaVersion: 1,
    sourceSha,
    sourceDirty,
    extensionVersion: version,
    sdkVersion,
    attestorVersion,
    sdkSourceSha256,
    sdkBuildOutputsSha256: digestRecords(sdkOutputs),
    profile: staged.profile,
    endpointProfiles: staged.endpointProfiles,
    profileSetSha256: staged.profileSetSha256,
    activationCatalogueSha256: staged.activationCatalogueSha256,
    activationCatalogueSize: staged.activationCatalogueSize,
    networkConfigInputs: staged.networkConfigInputs,
    canonicalAssetManifestSha256: staged.manifestSha256,
    files,
  };
}

export function assertStagedAssetInventory(staged, canonicalManifest, sdkRoot) {
  const noticeBytes = Buffer.from(provenanceNotice(canonicalManifest));
  const expected = [
    ...expectedMirrorOutputs(canonicalManifest),
    {
      path: "licenses/zk-symmetric-crypto.PROVENANCE.json",
      size: noticeBytes.length,
      sha256: sha256(noticeBytes),
      source: "notice",
    },
    ...expectedSdkOutputs(sdkRoot).map(({ sdkPath: _sdkPath, ...record }) => record),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const actual = [...staged.resources].sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("staged asset inventory differs from canonical sources");
  }
}

async function main() {
  const staged = JSON.parse(readFileSync(join(extensionRoot, ".staged-assets.json"), "utf8"));
  assertSameActivationInput(
    staged,
    await loadActivationBuildInput(repoRoot, staged.activationSources),
  );
  const assetManifestBytes = readFileSync(
    join(repoRoot, "infra/aws/src/asset-mirror/manifest.json"),
  );
  if (sha256(assetManifestBytes) !== staged.manifestSha256) {
    throw new Error("staged asset manifest differs from canonical infra manifest");
  }
  assertStagedAssetInventory(
    staged,
    JSON.parse(assetManifestBytes),
    join(repoRoot, "shared/zktls/extension-sdk/build"),
  );
  const packageJson = JSON.parse(readFileSync(join(extensionRoot, "package.json"), "utf8"));
  const sdkPackage = JSON.parse(
    readFileSync(join(repoRoot, "shared/zktls/extension-sdk/package.json"), "utf8"),
  );
  assertWorkspaceDependencies(packageJson, [sdkPackage.name, "@umia/zktls"]);
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const sourceDirty =
    execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim().length > 0;
  const sdkFiles = execFileSync("git", ["ls-files", "-z", "--", "shared/zktls/extension-sdk"], {
    cwd: repoRoot,
  })
    .toString()
    .split("\0")
    .filter(Boolean);
  const sdkSourceSha256 = digestRecords(
    sdkFiles.map((path) => fileRecord(path, join(repoRoot, path))),
  );
  const manifest = createArtifactManifest({
    distDir: dist,
    staged,
    sourceSha,
    sourceDirty,
    sdkSourceSha256,
    version: packageJson.version,
    sdkVersion: sdkPackage.version,
    attestorVersion: sdkPackage.dependencies?.["@reclaimprotocol/attestor-core"],
  });
  writeFileSync(join(dist, "artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`[extension artifact] ${error.message}`);
    process.exitCode = 1;
  }
}
