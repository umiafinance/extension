import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { assertStagedAssetInventory } from "./artifact-manifest.js";
import { assertPatchedStwoAsset, stageExtensionAssets } from "./setup.js";

const temporary = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const paths = [
  "resources/snarkjs/aes-128-ctr/circuit.wasm",
  "resources/snarkjs/aes-128-ctr/circuit_final.zkey",
  "resources/snarkjs/aes-256-ctr/circuit.wasm",
  "resources/snarkjs/aes-256-ctr/circuit_final.zkey",
  "resources/snarkjs/chacha20/circuit.wasm",
  "resources/snarkjs/chacha20/circuit_final.zkey",
  "resources/stwo/s2circuits.js",
  "resources/stwo/s2circuits_bg.wasm",
  "LICENSE",
];
const sdkPaths = [
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
const commit = "11ab427ab8382227f1b18b2a9caa876253c38784";
const licenseCommit = "49cd1902963723716901d80212502842ea0107eb";
test("mirrored Stwo WASM is the patched installed prover release", () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../infra/aws/src/asset-mirror/manifest.json")),
  );
  assert.doesNotThrow(() => assertPatchedStwoAsset(manifest));
  const stale = structuredClone(manifest);
  stale.objects.find((item) => item.path === "resources/stwo/s2circuits_bg.wasm").sha256 =
    "0".repeat(64);
  assert.throws(() => assertPatchedStwoAsset(stale), /mirrored Stwo WASM differs/);
});

function put(root, path, bytes) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "umia-extension-test-"));
  temporary.push(root);
  const assetDir = join(root, "mirror");
  const sdkRoot = join(root, "sdk");
  const targetDir = join(root, "public");
  const patchFile = put(
    targetDir,
    "popup-patches.css",
    "#reclaim-protocol-popup #reclaim-circular-loader .reclaim-popup-content .reclaim-popup-brand { max-height: calc(90vh - 80px); }",
  );
  for (const path of sdkPaths) {
    const bytes =
      path === "content/content.bundle.js"
        ? "const popupId = 'reclaim-protocol-popup';"
        : path.endsWith(".html") && path.includes("reclaim-provider-verification-popup")
          ? '<span class="reclaim-popup-brand"></span><div class="reclaim-popup-content"><div id="reclaim-circular-loader"></div></div>'
          : path.endsWith(".css")
            ? ".reclaim-popup-content { max-height: calc(90vh - 80px); }"
            : `sdk:${path}`;
    put(sdkRoot, path, bytes);
  }
  const objects = paths.map((path) => {
    const key = `zk-symmetric-crypto/${commit}/${path}`;
    const bytes = Buffer.from(`fixture:${path}`);
    put(assetDir, key, bytes);
    return {
      path,
      key,
      upstream: path === "LICENSE" ? "license" : "zk-symmetric-crypto",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const manifest = {
    schemaVersion: 1,
    upstreams: {
      "zk-symmetric-crypto": {
        repository: "https://github.com/reclaimprotocol/zk-symmetric-crypto",
        commit,
      },
      license: { repository: "https://github.com/reclaimprotocol/.github", commit: licenseCommit },
    },
    objects,
  };
  return { root, assetDir, sdkRoot, targetDir, patchFile, manifest };
}

test("stages every verified circuit, license, and private SDK output", () => {
  const input = fixture();
  const records = stageExtensionAssets(input);
  assert.doesNotThrow(() =>
    assertStagedAssetInventory({ resources: records }, input.manifest, input.sdkRoot),
  );
  assert.equal(records.length, 22);
  assert.deepEqual(
    JSON.parse(readFileSync(join(input.targetDir, "licenses/zk-symmetric-crypto.PROVENANCE.json"))),
    {
      resourceSource: input.manifest.upstreams["zk-symmetric-crypto"],
      licenseSource: input.manifest.upstreams.license,
      licenseObjectKey: input.manifest.objects.find((object) => object.path === "LICENSE").key,
    },
  );
  assert.equal(
    readFileSync(
      join(input.targetDir, "browser-rpc/resources/snarkjs/aes-128-ctr/circuit.wasm"),
      "utf8",
    ),
    "fixture:resources/snarkjs/aes-128-ctr/circuit.wasm",
  );
  assert.equal(
    readFileSync(join(input.targetDir, "browser-rpc/resources/snarkjs/snarkjs.min.js"), "utf8"),
    "sdk:browser-rpc/resources/snarkjs/snarkjs.min.js",
  );
});

test("rebuilds root bundles from the current SDK while preserving static public files", () => {
  const input = fixture();
  put(input.sdkRoot, "343.bundle.js", "current-sdk-chunk");
  put(input.targetDir, "343.bundle.js", "old-sdk-chunk");
  put(input.targetDir, "stale.bundle.js", "unverified-stale-chunk");
  put(input.targetDir, "grant.js", "tracked-static-grant");

  const records = stageExtensionAssets(input);
  assert.doesNotThrow(() =>
    assertStagedAssetInventory({ resources: records }, input.manifest, input.sdkRoot),
  );
  assert.deepEqual(
    readdirSync(input.targetDir).filter((name) => name.endsWith(".bundle.js")),
    ["343.bundle.js"],
  );
  assert.equal(readFileSync(join(input.targetDir, "343.bundle.js"), "utf8"), "current-sdk-chunk");
  assert.equal(readFileSync(join(input.targetDir, "grant.js"), "utf8"), "tracked-static-grant");
});

test("artifact attestation rejects omitted, altered, or extra staged files", () => {
  const input = fixture();
  const resources = stageExtensionAssets(input);
  assert.doesNotThrow(() =>
    assertStagedAssetInventory({ resources }, input.manifest, input.sdkRoot),
  );
  assert.throws(
    () =>
      assertStagedAssetInventory(
        { resources: resources.filter((item) => !item.upstream) },
        input.manifest,
        input.sdkRoot,
      ),
    /inventory differs/,
  );
  const changed = resources.map((item) =>
    item.upstream === "license" ? { ...item, sha256: "f".repeat(64) } : item,
  );
  assert.throws(
    () => assertStagedAssetInventory({ resources: changed }, input.manifest, input.sdkRoot),
    /inventory differs/,
  );
  assert.throws(
    () =>
      assertStagedAssetInventory(
        { resources: resources.filter((item) => item.source !== "notice") },
        input.manifest,
        input.sdkRoot,
      ),
    /inventory differs/,
  );
  assert.throws(
    () =>
      assertStagedAssetInventory(
        {
          resources: resources.filter(
            (item) => item.path !== "reclaim-browser-extension-sdk/offscreen/offscreen.bundle.js",
          ),
        },
        input.manifest,
        input.sdkRoot,
      ),
    /inventory differs/,
  );
  assert.throws(
    () =>
      assertStagedAssetInventory(
        { resources: [...resources, { path: "unexpected.js", source: "other" }] },
        input.manifest,
        input.sdkRoot,
      ),
    /inventory differs/,
  );
});

test("rejects a partial or changed circuit before touching the output", () => {
  const input = fixture();
  put(input.targetDir, "browser-rpc/old.txt", "preserve");
  rmSync(join(input.assetDir, input.manifest.objects[0].key));
  assert.throws(() => stageExtensionAssets(input));
  assert.equal(readFileSync(join(input.targetDir, "browser-rpc/old.txt"), "utf8"), "preserve");

  put(input.assetDir, input.manifest.objects[0].key, "wrong bytes");
  assert.throws(() => stageExtensionAssets(input), /size or SHA-256 mismatch/);
  assert.equal(readFileSync(join(input.targetDir, "browser-rpc/old.txt"), "utf8"), "preserve");
});

test("rejects manifest traversal, duplicate entries, and symlink escape", () => {
  const input = fixture();
  input.manifest.objects[0].key = "../escape";
  assert.throws(() => stageExtensionAssets(input), /unsafe path/);
  input.manifest.objects[0].key = input.manifest.objects[1].key;
  assert.throws(() => stageExtensionAssets(input), /key mismatch/);
  input.manifest.objects[0].key = `zk-symmetric-crypto/${commit}/${input.manifest.objects[0].path}`;
  const escaped = put(input.root, "outside", "outside");
  rmSync(join(input.assetDir, input.manifest.objects[0].key));
  symlinkSync(escaped, join(input.assetDir, input.manifest.objects[0].key));
  assert.throws(() => stageExtensionAssets(input), /source escapes/);
});

test("rejects missing separate license provenance", () => {
  const input = fixture();
  delete input.manifest.upstreams.license;
  assert.throws(() => stageExtensionAssets(input), /invalid separate license source commit/);
  input.manifest.upstreams.license = { commit: licenseCommit, repository: "http://example.test" };
  assert.throws(() => stageExtensionAssets(input), /invalid license source repository/);
});

test("rejects missing private SDK output and moved popup anchors", () => {
  const input = fixture();
  rmSync(join(input.sdkRoot, "offscreen/stwo-worker.js"));
  assert.throws(() => stageExtensionAssets(input), /private SDK output missing/);
  put(input.sdkRoot, "offscreen/stwo-worker.js", "restored");
  put(input.sdkRoot, "content/components/reclaim-provider-verification-popup.css", "changed");
  assert.throws(() => stageExtensionAssets(input), /popup patch anchor missing/);
  put(input.sdkRoot, "content/content.bundle.js", "calc(90vh - 80px)");
  assert.throws(() => stageExtensionAssets(input), /popup patch anchor missing/);
});

test("rejects an SDK popup template without the header the patches style", () => {
  const input = fixture();
  put(
    input.sdkRoot,
    "content/components/reclaim-provider-verification-popup.html",
    '<div class="reclaim-popup-content"><div id="reclaim-circular-loader"></div></div>',
  );
  assert.throws(
    () => stageExtensionAssets(input),
    /popup patch anchor missing: reclaim-popup-brand/,
  );
});

test("popup patch anchors in comments do not count as active rules", () => {
  const input = fixture();
  put(
    input.targetDir,
    "popup-patches.css",
    "/* #reclaim-protocol-popup #reclaim-circular-loader .reclaim-popup-content calc(90vh - 80px) */",
  );
  assert.throws(() => stageExtensionAssets(input), /popup patch anchor missing/);
});
