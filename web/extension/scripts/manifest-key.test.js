import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyManifestKey,
  extensionIdForKey,
  loadStoreKey,
  parseManifestKey,
} from "./manifest-key.js";

// Vector from openssl: `openssl rsa -pubout -outform DER | sha256sum | head -c32 | tr 0-9a-f a-p`.
const KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5KSwHv3fUEXmoaMuT9q8666KZqRXjWMdKQd2pM4MXz9bzTEZhpTZcDYf9Phdxgb+7EvUEiuhrrWhLIHbiZfJCVnfzO5yeR3FQnEW891GZY7KlW8KCRjg/xg+I7HFeEYD8EGH8OxY+IVomyE3R7Yr/OS4bzy/MYlrv5Y6C6xX6l/KBaX3Cg9chgNJP4jsMEzioW7sC5QKtL/FFnE9b9QI6forAgt253PiHY2bfXSYSZNhfPGvOR3qmB4cAgz480KrdFfR0fJnCJPcg4mRPIjervkikKmd5poKDsPx4zxn2hg9C/AnFWMRLYheFmU8XF7bisNQMi9RdKSjUlx6ZnzArQIDAQAB";
const ID = "nebapbkomkjmgdekjnjfbglfgooidenc";

const pem = () =>
  `-----BEGIN PUBLIC KEY-----\n${KEY.match(/.{1,64}/g).join("\n")}\n-----END PUBLIC KEY-----\n`;

test("derives Chrome's extension ID from the public key", () => {
  assert.equal(extensionIdForKey(parseManifestKey(KEY)), ID);
});

test("accepts the dashboard's PEM text, dropping header, footer and line breaks", () => {
  assert.equal(parseManifestKey(pem()), KEY);
});

test("refuses anything but an RSA DER public key", () => {
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
    .publicKey.export({ format: "der", type: "spki" })
    .toString("base64");
  assert.throws(() => parseManifestKey(ec), /RSA public key/);
  assert.throws(() => parseManifestKey("not base64!"), /base64 public key/);
  assert.throws(
    () => parseManifestKey(Buffer.from("garbage").toString("base64")),
    /DER public key/,
  );
});

test("writes the key into the built manifest and reports the pinned ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "umia-manifest-key-"));
  try {
    const path = join(dir, "manifest.json");
    writeFileSync(path, JSON.stringify({ manifest_version: 3, version: "1.0.0" }));
    assert.equal(applyManifestKey(path, KEY), ID);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      manifest_version: 3,
      version: "1.0.0",
      key: KEY,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the committed store key yields the Umia store item's ID", () => {
  assert.equal(loadStoreKey().id, "ejcaahfcaaiblipldkfijdcbannidbdd");
});

test("a store key file whose key no longer yields its ID is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "umia-store-key-"));
  try {
    const path = join(dir, "store-key.json");
    writeFileSync(path, JSON.stringify({ id: "ejcaahfcaaiblipldkfijdcbannidbdd", key: KEY }));
    assert.throws(() => loadStoreKey(path), /does not yield store ID/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
