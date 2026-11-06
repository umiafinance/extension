#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

function safePath(path) {
  return (
    typeof path === "string" &&
    /^[A-Za-z0-9._/-]+$/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || !manifest.upstreams || !Array.isArray(manifest.objects)) {
    throw new Error("Unsupported asset manifest");
  }
  if (manifest.objects.length === 0) throw new Error("Asset manifest has no objects");

  const upstreams = Object.entries(manifest.upstreams);
  if (upstreams.length === 0) throw new Error("Asset manifest has no upstreams");
  for (const [name, upstream] of upstreams) {
    if (!safePath(name) || !/^[0-9a-f]{40}$/.test(upstream?.commit)) {
      throw new Error(`Invalid upstream ${name}`);
    }
    const base = new URL(upstream.rawBaseUrl);
    if (!base.href.endsWith("/") || !["https:", "http:"].includes(base.protocol)) {
      throw new Error(`Invalid raw base URL for ${name}`);
    }
  }

  const keys = new Set();
  for (const object of manifest.objects) {
    if (!manifest.upstreams[object?.upstream] || !safePath(object.path) || !safePath(object.key)) {
      throw new Error("Invalid asset source or key");
    }
    if (keys.has(object.key)) throw new Error(`Duplicate asset key: ${object.key}`);
    keys.add(object.key);
    if (!Number.isSafeInteger(object.size) || object.size < 1) {
      throw new Error(`Invalid asset size: ${object.key}`);
    }
    if (!/^[0-9a-f]{64}$/.test(object.sha256)) {
      throw new Error(`Invalid asset digest: ${object.key}`);
    }
    if (
      typeof object.contentType !== "string" ||
      !/^[a-z]+\/[a-z0-9.+-]+$/.test(object.contentType)
    ) {
      throw new Error(`Invalid asset content type: ${object.key}`);
    }
  }
  return manifest;
}

export async function readManifest(path) {
  return validateManifest(JSON.parse(await readFile(path, "utf8")));
}

function checkDigest(object, size, digest) {
  if (size !== object.size || digest !== object.sha256) {
    throw new Error(
      `Integrity mismatch for ${object.key}: expected ${object.size} bytes / ${object.sha256}, got ${size} bytes / ${digest}`,
    );
  }
}

async function hashStream(stream, object, destination) {
  const hash = createHash("sha256");
  let size = 0;
  const verifier = new Transform({
    transform(chunk, _, callback) {
      size += chunk.length;
      if (size > object.size) {
        callback(new Error(`Oversized asset: ${object.key}`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const sink = destination
    ? createWriteStream(destination, { flags: "wx" })
    : new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
  await pipeline(stream, verifier, sink);
  checkDigest(object, size, hash.digest("hex"));
}

async function fetchAsset(url, object, destination) {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok || !response.body) {
    throw new Error(`Asset request failed for ${object.key}: HTTP ${response.status}`);
  }
  await hashStream(response.body, object, destination);
}

export async function stageAssets(manifest, outputDirectory) {
  validateManifest(manifest);
  const output = resolve(outputDirectory);
  if (existsSync(output)) throw new Error(`Output already exists: ${output}`);
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(`${output}.partial-`);
  try {
    for (const object of manifest.objects) {
      const destination = join(staging, ...object.key.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      const base = manifest.upstreams[object.upstream].rawBaseUrl;
      await fetchAsset(new URL(object.path, base), object, destination);
    }
    await rename(staging, output);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyLocal(manifest, directory) {
  validateManifest(manifest);
  const root = resolve(directory);
  for (const object of manifest.objects) {
    const path = join(root, ...object.key.split("/"));
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Invalid asset file: ${object.key}`);
    await hashStream(createReadStream(path), object);
  }
}

export async function verifyRemote(manifest, baseUrl) {
  validateManifest(manifest);
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && base.hostname === "127.0.0.1")) {
    throw new Error("Remote verification requires HTTPS");
  }
  for (const object of manifest.objects) {
    await fetchAsset(new URL(object.key, base), object);
  }
}

async function main() {
  const [command, manifestPath, target] = process.argv.slice(2);
  if (!target || !["stage", "verify-local", "verify-remote"].includes(command)) {
    throw new Error(
      "Usage: node assets.mjs <stage|verify-local|verify-remote> <manifest.json> <directory|base-url>",
    );
  }
  const manifest = await readManifest(manifestPath);
  if (command === "stage") await stageAssets(manifest, target);
  if (command === "verify-local") await verifyLocal(manifest, target);
  if (command === "verify-remote") await verifyRemote(manifest, target);
  process.stdout.write(`${command} verified ${manifest.objects.length} objects\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
