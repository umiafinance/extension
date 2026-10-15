import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadActivationBuildInput } from "./activation-build-input.js";
import { fileRecord, isSafeRelativePath, listFiles } from "./artifact-files.js";
import { parseBuildOptions } from "./build-options.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(projectRoot, "../..");
const canonicalManifest = join(repoRoot, "infra/aws/src/asset-mirror/manifest.json");
const sdkBuild = join(repoRoot, "shared/zktls/extension-sdk/build");
const publicDir = join(projectRoot, "public");
const require = createRequire(import.meta.url);
const SDK_FILES = [
  "ReclaimExtensionSDK.bundle.js",
  "content/content.bundle.js",
  "content/components/reclaim-provider-verification-popup.css",
  "content/components/reclaim-provider-verification-popup.html",
  "interceptor/network-interceptor.bundle.js",
  "interceptor/injection-scripts.bundle.js",
  "offscreen/offscreen.bundle.js",
  "offscreen/offscreen.html",
  "offscreen/load-s2circuits.js",
  "offscreen/stwo-worker.js",
  "offscreen/snarkjs-worker.js",
  "browser-rpc/resources/snarkjs/snarkjs.min.js",
];

function isUnpackagedSdkPath(path) {
  return (
    path === "scripts" || path === "background" || path.endsWith(".map") || path.includes("-mv2.")
  );
}

function fail(message) {
  throw new Error(`[extension assets] ${message}`);
}

function safePath(value) {
  if (!isSafeRelativePath(value)) fail(`unsafe path: ${value}`);
  return value;
}

function sourceFile(root, path) {
  const absolute = resolve(root, safePath(path));
  const rootReal = realpathSync(root);
  const fileReal = realpathSync(absolute);
  if (!fileReal.startsWith(`${rootReal}${sep}`) || !statSync(fileReal).isFile()) {
    fail(`source escapes its asset root: ${path}`);
  }
  return fileReal;
}

function nonEmptyRecord(path, file) {
  const record = fileRecord(path, file);
  if (record.size === 0) fail(`empty file: ${path}`);
  return record;
}

function checkedObjects(manifest) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.objects)) {
    fail("canonical asset manifest schema is missing or unsupported");
  }
  const resources = manifest.objects.filter(
    (entry) => entry.upstream === "zk-symmetric-crypto" && entry.path?.startsWith("resources/"),
  );
  if (
    manifest.objects.length !== 9 ||
    resources.length !== 8 ||
    manifest.objects.filter((entry) => entry.path === "LICENSE" && entry.upstream === "license")
      .length !== 1
  ) {
    fail("canonical asset manifest must contain eight resources and one license");
  }
  const commit = manifest.upstreams?.["zk-symmetric-crypto"]?.commit;
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) fail("invalid resource source commit");
  if (!/^[a-f0-9]{40}$/.test(manifest.upstreams?.license?.commit ?? "")) {
    fail("invalid separate license source commit");
  }
  for (const upstream of ["zk-symmetric-crypto", "license"]) {
    const repository = manifest.upstreams?.[upstream]?.repository;
    if (typeof repository !== "string") fail(`invalid ${upstream} source repository`);
    try {
      const url = new URL(repository);
      if (
        url.protocol !== "https:" ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        fail(`invalid ${upstream} source repository`);
      }
    } catch {
      fail(`invalid ${upstream} source repository`);
    }
  }
  const seen = new Set();
  for (const object of manifest.objects) {
    const path = safePath(object.path);
    const key = safePath(object.key);
    if ((path !== "LICENSE" && !path.startsWith("resources/")) || seen.has(path)) {
      fail(`unexpected or repeated object: ${path}`);
    }
    seen.add(path);
    if (key !== `zk-symmetric-crypto/${commit}/${path}`) fail(`object key mismatch: ${path}`);
    if (object.upstream !== (path === "LICENSE" ? "license" : "zk-symmetric-crypto")) {
      fail(`object upstream mismatch: ${path}`);
    }
    if (
      !Number.isSafeInteger(object.size) ||
      object.size <= 0 ||
      !/^[a-f0-9]{64}$/.test(object.sha256)
    ) {
      fail(`invalid size or digest: ${path}`);
    }
  }
  return manifest.objects;
}

export function assertPatchedStwoAsset(manifest) {
  const entry = require.resolve("@reclaimprotocol/zk-symmetric-crypto");
  const packageRoot = resolve(dirname(entry), "..");
  const installed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const declared = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"))
    .devDependencies?.["@reclaimprotocol/zk-symmetric-crypto"];
  if (declared !== "5.1.7" || installed.version !== declared) {
    fail("patched Stwo prover package is not pinned to 5.1.7");
  }
  const wasm = fileRecord(
    "resources/stwo/s2circuits_bg.wasm",
    join(packageRoot, "lib/stwo/s2circuits_bg.wasm"),
  );
  const mirrored = checkedObjects(manifest).find(
    (object) => object.path === "resources/stwo/s2circuits_bg.wasm",
  );
  if (!mirrored || mirrored.size !== wasm.size || mirrored.sha256 !== wasm.sha256) {
    fail("mirrored Stwo WASM differs from the patched installed prover");
  }
}

export function expectedMirrorOutputs(manifest) {
  return checkedObjects(manifest)
    .map((object) => ({
      path:
        object.path === "LICENSE"
          ? "licenses/zk-symmetric-crypto.LICENSE"
          : `browser-rpc/${object.path}`,
      size: object.size,
      sha256: object.sha256,
      upstream: object.upstream,
      key: object.key,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function provenanceNotice(manifest) {
  checkedObjects(manifest);
  return `${JSON.stringify(
    {
      resourceSource: {
        repository: manifest.upstreams["zk-symmetric-crypto"].repository,
        commit: manifest.upstreams["zk-symmetric-crypto"].commit,
      },
      licenseSource: {
        repository: manifest.upstreams.license.repository,
        commit: manifest.upstreams.license.commit,
      },
      licenseObjectKey: manifest.objects.find((object) => object.path === "LICENSE").key,
    },
    null,
    2,
  )}\n`;
}

function verifyPopupPatch(sdkRoot, patchFile) {
  const patch = readFileSync(patchFile, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const targets = [
    ["content/content.bundle.js", "reclaim-protocol-popup"],
    ["content/components/reclaim-provider-verification-popup.html", "reclaim-circular-loader"],
    ["content/components/reclaim-provider-verification-popup.html", "reclaim-popup-content"],
    ["content/components/reclaim-provider-verification-popup.html", "reclaim-popup-brand"],
    ["content/components/reclaim-provider-verification-popup.css", "calc(90vh - 80px)"],
  ];
  for (const [path, anchor] of targets) {
    if (
      !patch.includes(anchor) ||
      !readFileSync(sourceFile(sdkRoot, path), "utf8").includes(anchor)
    ) {
      fail(`popup patch anchor missing: ${anchor}`);
    }
  }
}

// The SDK build is the only source of SDK bundle inventory; attestation reuses this list.
export function expectedSdkOutputs(sdkRoot) {
  if (!existsSync(sdkRoot)) fail("private SDK build is missing");
  const files = listFiles(sdkRoot, isUnpackagedSdkPath);
  for (const path of SDK_FILES) {
    if (!files.includes(path)) fail(`private SDK output missing: ${path}`);
  }
  return files.map((sdkPath) => {
    if (
      sdkPath.startsWith("browser-rpc/") &&
      sdkPath !== "browser-rpc/resources/snarkjs/snarkjs.min.js"
    ) {
      fail(`unexpected SDK resource: ${sdkPath}`);
    }
    const path =
      sdkPath.startsWith("browser-rpc/") ||
      (!sdkPath.includes("/") && sdkPath !== "ReclaimExtensionSDK.bundle.js")
        ? sdkPath
        : `reclaim-browser-extension-sdk/${sdkPath}`;
    return { ...nonEmptyRecord(path, sourceFile(sdkRoot, sdkPath)), source: "sdk", sdkPath };
  });
}

export function stageExtensionAssets({ manifest, assetDir, sdkRoot, targetDir, patchFile }) {
  const objects = checkedObjects(manifest);
  if (!assetDir || !existsSync(assetDir)) fail("local mirror asset directory is required");
  const sources = objects.map((object) => {
    const file = sourceFile(assetDir, object.key);
    const record = nonEmptyRecord(object.path, file);
    if (record.size !== object.size || record.sha256 !== object.sha256) {
      fail(`size or SHA-256 mismatch: ${object.path}`);
    }
    return { object, file };
  });
  const sdkOutputs = expectedSdkOutputs(sdkRoot);
  verifyPopupPatch(sdkRoot, patchFile);

  const staging = mkdtempSync(join(tmpdir(), "umia-extension-assets-"));
  const records = [];
  try {
    for (const { object, file } of sources) {
      const path =
        object.path === "LICENSE"
          ? "licenses/zk-symmetric-crypto.LICENSE"
          : `browser-rpc/${object.path}`;
      const dest = join(staging, path);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(file, dest);
      const staged = nonEmptyRecord(path, dest);
      if (staged.size !== object.size || staged.sha256 !== object.sha256) {
        fail(`staged asset changed during copy: ${object.path}`);
      }
      records.push({ ...staged, upstream: object.upstream, key: object.key });
    }
    const provenancePath = "licenses/zk-symmetric-crypto.PROVENANCE.json";
    const provenanceFile = join(staging, provenancePath);
    writeFileSync(provenanceFile, provenanceNotice(manifest));
    records.push({ ...nonEmptyRecord(provenancePath, provenanceFile), source: "notice" });
    for (const { sdkPath, ...expected } of sdkOutputs) {
      const dest = join(staging, expected.path);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(sourceFile(sdkRoot, sdkPath), dest);
      const staged = nonEmptyRecord(expected.path, dest);
      if (staged.size !== expected.size || staged.sha256 !== expected.sha256) {
        fail(`staged SDK output changed during copy: ${sdkPath}`);
      }
      records.push({ ...staged, source: "sdk" });
    }
    mkdirSync(targetDir, { recursive: true });
    for (const directory of ["browser-rpc", "licenses", "reclaim-browser-extension-sdk"]) {
      rmSync(join(targetDir, directory), { recursive: true, force: true });
      renameSync(join(staging, directory), join(targetDir, directory));
    }
    // Root bundles are generated and ignored; rebuild this set from verified SDK output.
    for (const name of readdirSync(targetDir)) {
      if (name.endsWith(".bundle.js")) rmSync(join(targetDir, name));
    }
    for (const entry of readdirSync(staging)) {
      const from = join(staging, entry);
      if (!lstatSync(from).isFile()) fail(`unexpected SDK root entry: ${entry}`);
      cpSync(from, join(targetDir, entry));
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

async function main() {
  const { assetDir, activationFile, networkConfigFiles } = parseBuildOptions(process.argv.slice(2));
  const activation = await loadActivationBuildInput(repoRoot, {
    activationFile,
    networkConfigFiles,
  });
  if (!existsSync(canonicalManifest))
    fail("canonical infra asset manifest is absent from the foundation dependency");
  const manifest = JSON.parse(readFileSync(canonicalManifest, "utf8"));
  assertPatchedStwoAsset(manifest);
  const records = stageExtensionAssets({
    manifest,
    assetDir,
    sdkRoot: sdkBuild,
    targetDir: publicDir,
    patchFile: join(publicDir, "popup-patches.css"),
  });
  writeFileSync(
    join(projectRoot, ".staged-assets.json"),
    `${JSON.stringify(
      {
        profile: "approved-canonical-set",
        ...activation,
        resources: records,
        manifestSha256: nonEmptyRecord("manifest", canonicalManifest).sha256,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
