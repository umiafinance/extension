#!/usr/bin/env node
// Compares two builds by their artifact manifests: every packaged file must have the same
// size and SHA-256. The source commit and dirty flag are expected to differ between a rebuild
// from the public mirror and Umia's build, so they are not compared.
//   node scripts/compare-artifacts.js <rebuilt artifact-manifest.json> <release artifact-manifest.json>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function compareArtifacts(rebuilt, release) {
  const problems = [];
  const files = (artifact) => new Map(artifact.files.map((file) => [file.path, file]));
  const [ours, theirs] = [files(rebuilt), files(release)];
  for (const [path, file] of theirs) {
    const other = ours.get(path);
    if (!other) problems.push(`missing from the rebuild: ${path}`);
    else if (other.size !== file.size || other.sha256 !== file.sha256)
      problems.push(`differs: ${path}`);
  }
  for (const path of ours.keys())
    if (!theirs.has(path)) problems.push(`not in the release: ${path}`);
  for (const key of [
    "extensionVersion",
    "channel",
    "profileSetSha256",
    "canonicalAssetManifestSha256",
  ]) {
    if (rebuilt[key] !== release[key]) problems.push(`${key} differs`);
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [rebuiltPath, releasePath] = process.argv.slice(2);
  if (!rebuiltPath || !releasePath) {
    console.error(
      "usage: node scripts/compare-artifacts.js <rebuilt artifact-manifest.json> <release artifact-manifest.json>",
    );
    process.exit(2);
  }
  const read = (path) => JSON.parse(readFileSync(path, "utf8"));
  const release = read(releasePath);
  const problems = compareArtifacts(read(rebuiltPath), release);
  if (problems.length) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    process.exit(1);
  }
  console.log(`✓ all ${release.files.length} files match release ${release.extensionVersion}`);
}
