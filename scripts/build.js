import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBuildOptions } from "./build-options.js";
import { applyManifestKey, loadStoreKey } from "./manifest-key.js";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(extensionRoot, "../..");

function run(args, cwd = extensionRoot) {
  execFileSync("bun", args, { cwd, stdio: "inherit" });
}

try {
  rmSync(resolve(extensionRoot, "dist"), { recursive: true, force: true });
  rmSync(resolve(extensionRoot, ".staged-assets.json"), { force: true });
  parseBuildOptions(process.argv.slice(2));
  const storeKey = loadStoreKey();
  run(["run", "--cwd", resolve(repoRoot, "shared/zktls/extension-sdk"), "build"]);
  run(["scripts/setup.js", ...process.argv.slice(2)]);
  run([resolve(extensionRoot, "node_modules/.bin/vite"), "build"]);
  // Before the artifact manifest, so its file digests attest the keyed manifest.json.
  const id = applyManifestKey(resolve(extensionRoot, "dist/manifest.json"), storeKey.key);
  console.log(`[extension build] Load unpacked dist/ runs as the store item ${id}`);
  run(["scripts/artifact-manifest.js"]);
} catch (error) {
  console.error(`[extension build] ${error.message}`);
  process.exitCode = 1;
}
