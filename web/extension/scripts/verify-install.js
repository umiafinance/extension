#!/usr/bin/env node
// Checks an installed Umia extension against a published release. Dependency-free so anyone can
// run it from the public mirror:
//   node scripts/verify-install.js <installed extension dir> <unzipped release dir>
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Chrome adds or drops these on install; every other manifest field must match the release.
const INSTALL_MANIFEST_FIELDS = ["key", "update_url"];
// Chrome writes this into an installed copy (its own content hashes); it is not part of a release.
const INSTALL_ONLY = /^_metadata\//;

// The Chrome Web Store re-encodes the manifest icons, so they must exist but are not compared.
function storeReencoded(releaseDir) {
  const { icons = {} } = JSON.parse(readFileSync(join(releaseDir, "manifest.json"), "utf8"));
  return new Set(Object.values(icons));
}

function listFiles(root, dir = root) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? listFiles(root, path)
      : [relative(root, path).split(sep).join("/")];
  });
}

// Chrome rewrites the manifest on install, so object key order is not significant; array order is.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function comparableManifest(bytes) {
  const manifest = JSON.parse(bytes);
  for (const field of INSTALL_MANIFEST_FIELDS) delete manifest[field];
  return JSON.stringify(canonical(manifest));
}

export function verifyInstall(installedDir, releaseDir) {
  const problems = [];
  const installed = new Set(listFiles(installedDir).filter((path) => !INSTALL_ONLY.test(path)));
  const reencoded = storeReencoded(releaseDir);
  for (const path of listFiles(releaseDir)) {
    if (!installed.delete(path)) {
      problems.push(`missing: ${path}`);
      continue;
    }
    if (reencoded.has(path)) continue;
    const released = readFileSync(join(releaseDir, path));
    const actual = readFileSync(join(installedDir, path));
    const same =
      path === "manifest.json"
        ? comparableManifest(released) === comparableManifest(actual)
        : released.equals(actual);
    if (!same) problems.push(`differs: ${path}`);
  }
  for (const path of installed) problems.push(`not in the release: ${path}`);
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [installedDir, releaseDir] = process.argv.slice(2);
  if (!installedDir || !releaseDir) {
    console.error(
      "usage: node scripts/verify-install.js <installed extension dir> <unzipped release dir>",
    );
    process.exit(2);
  }
  const problems = verifyInstall(installedDir, releaseDir);
  if (problems.length) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    process.exit(1);
  }
  const artifact = JSON.parse(readFileSync(join(releaseDir, "artifact-manifest.json"), "utf8"));
  console.log(
    `✓ installed extension matches release ${artifact.extensionVersion}, built from ${artifact.sourceSha}`,
  );
}
