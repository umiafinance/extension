import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles } from "./artifact-files.js";
import {
  assertPackageMatchesArtifact,
  assertPermissionBaseline,
  assertVersionParity,
  builtCallerMatches,
  readReleaseSources,
} from "./release-checks.js";
import { createZip, readZip } from "./zip.js";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// `distDir` and `outFile` are injectable so tests package synthetic builds, never the mirrored circuits.
export function packageExtension({ distDir, outFile, sources }) {
  const artifact = JSON.parse(readFileSync(join(distDir, "artifact-manifest.json"), "utf8"));
  const builtManifest = JSON.parse(readFileSync(join(distDir, "manifest.json"), "utf8"));
  assertPermissionBaseline(builtManifest, sources.baseline, {
    externallyConnectableMatches: builtCallerMatches(artifact.endpointProfiles),
  });
  assertVersionParity({ ...sources, manifest: builtManifest, artifact });
  const entries = listFiles(distDir).map((path) => ({
    path,
    bytes: readFileSync(join(distDir, path)),
  }));
  assertPackageMatchesArtifact(entries, artifact);
  const zip = createZip(entries);
  assertPackageMatchesArtifact(readZip(zip), artifact);
  writeFileSync(outFile, zip);
  return { path: outFile, files: entries.length, bytes: zip.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const sources = readReleaseSources();
    const outFile = resolve(process.argv[2] ?? join(extensionRoot, "extension-dist.zip"));
    const result = packageExtension({ distDir: join(extensionRoot, "dist"), outFile, sources });
    console.log(
      `[extension package] ${result.files} files, ${result.bytes} bytes -> ${result.path}`,
    );
  } catch (error) {
    console.error(`[extension package] ${error.message}`);
    process.exitCode = 1;
  }
}
