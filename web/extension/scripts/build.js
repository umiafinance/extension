import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBuildOptions } from "./build-options.js";
import { applyManifestKey, loadStoreKey } from "./manifest-key.js";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(extensionRoot, "../..");

function run(args, { cwd = extensionRoot, env } = {}) {
  execFileSync("bun", args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
}

try {
  rmSync(resolve(extensionRoot, "dist"), { recursive: true, force: true });
  rmSync(resolve(extensionRoot, ".staged-assets.json"), { force: true });
  const { channel } = parseBuildOptions(process.argv.slice(2));
  const env = { UMIA_EXTENSION_CHANNEL: channel };
  const storeKey = loadStoreKey();
  run(["run", "--cwd", resolve(repoRoot, "shared/zktls/extension-sdk"), "build"]);
  run(["scripts/setup.js", ...process.argv.slice(2)]);
  run([resolve(extensionRoot, "node_modules/.bin/vite"), "build"], { env });
  // Before the artifact manifest, so its file digests attest the keyed manifest.json.
  const id = applyManifestKey(resolve(extensionRoot, "dist/manifest.json"), storeKey.key);
  console.log(
    `[extension build] ${channel} build; Load unpacked dist/ runs as the store item ${id}`,
  );
  run(["scripts/artifact-manifest.js"], { env });
} catch (error) {
  console.error(`[extension build] ${error.message}`);
  process.exitCode = 1;
}
