import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fileRecord(path, file) {
  const bytes = readFileSync(file);
  return { path, size: bytes.length, sha256: sha256(bytes) };
}

export function isSafeRelativePath(path) {
  return (
    typeof path === "string" &&
    path.split("/").every((part) => /^[a-zA-Z0-9._-]+$/.test(part) && part !== "." && part !== "..")
  );
}

export function listFiles(root, skip = () => false) {
  const walk = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = join(directory, entry.name);
      const path = relative(root, file).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) throw new Error(`symlink is forbidden: ${path}`);
      if (skip(path)) return [];
      return entry.isDirectory() ? walk(file) : [path];
    });
  return walk(root);
}
