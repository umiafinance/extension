import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { verifyInstall } from "./verify-install.js";

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "umia-verify-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

test("an install matches its release apart from the fields Chrome sets", () => {
  const release = tree({
    "manifest.json": JSON.stringify({ name: "Umia", version: "0.4.1", key: "abc" }),
    "artifact-manifest.json": "{}",
    "extensionBackground.js": "background",
  });
  const installed = tree({
    "manifest.json": JSON.stringify({ name: "Umia", version: "0.4.1", update_url: "https://u" }),
    "artifact-manifest.json": "{}",
    "extensionBackground.js": "background",
    "_metadata/verified_contents.json": "{}",
  });
  try {
    assert.deepEqual(verifyInstall(installed, release), []);
    writeFileSync(join(installed, "extensionBackground.js"), "tampered");
    writeFileSync(join(installed, "extra.js"), "added");
    writeFileSync(
      join(installed, "manifest.json"),
      JSON.stringify({ name: "Umia", version: "0.4.1", permissions: ["tabs"] }),
    );
    rmSync(join(installed, "artifact-manifest.json"));
    assert.deepEqual(verifyInstall(installed, release).sort(), [
      "differs: extensionBackground.js",
      "differs: manifest.json",
      "missing: artifact-manifest.json",
      "not in the release: extra.js",
    ]);
  } finally {
    rmSync(release, { recursive: true, force: true });
    rmSync(installed, { recursive: true, force: true });
  }
});

test("a manifest Chrome rewrote with keys in another order still matches", () => {
  const released = {
    name: "Umia",
    version: "0.5.0",
    background: { type: "module", service_worker: "a.js" },
  };
  const release = tree({ "manifest.json": JSON.stringify({ ...released, key: "abc" }) });
  const installed = tree({
    "manifest.json": JSON.stringify({
      update_url: "https://u",
      background: { service_worker: "a.js", type: "module" },
      version: "0.5.0",
      name: "Umia",
    }),
  });
  try {
    assert.deepEqual(verifyInstall(installed, release), []);
    writeFileSync(
      join(installed, "manifest.json"),
      JSON.stringify({ ...released, permissions: ["cookies", "storage"] }),
    );
    writeFileSync(
      join(release, "manifest.json"),
      JSON.stringify({ ...released, permissions: ["storage", "cookies"] }),
    );
    assert.deepEqual(verifyInstall(installed, release), ["differs: manifest.json"]);
  } finally {
    rmSync(release, { recursive: true, force: true });
    rmSync(installed, { recursive: true, force: true });
  }
});
