import { createHash, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STORE_KEY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../store-key.json");

/**
 * The Chrome Web Store item's public key as a manifest `key`: base64 DER SubjectPublicKeyInfo.
 * Accepts the dashboard's "View public key" text as is; its PEM header, footer and line breaks
 * are dropped.
 */
export function parseManifestKey(value) {
  const base64 = String(value)
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error("store key must be the item's base64 public key");
  }
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(base64, "base64"), format: "der", type: "spki" });
  } catch {
    throw new Error("store key is not a DER public key");
  }
  if (key.asymmetricKeyType !== "rsa") throw new Error("store key must be an RSA public key");
  return base64;
}

/** Chrome's extension ID for a key: the first 128 bits of SHA-256(DER), one a-p letter per nibble. */
export function extensionIdForKey(base64) {
  const digest = createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
  return [...digest.slice(0, 32)]
    .map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16)))
    .join("");
}

/** Pins an unpacked build to the store item's ID. */
export function applyManifestKey(manifestPath, base64) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, key: base64 }, null, 2)}\n`);
  return extensionIdForKey(base64);
}

/** The committed store item key, refused unless it still yields the committed store ID. */
export function loadStoreKey(path = STORE_KEY_PATH) {
  const { id, key } = JSON.parse(readFileSync(path, "utf8"));
  const parsed = parseManifestKey(key);
  if (extensionIdForKey(parsed) !== id) throw new Error(`store key does not yield store ID ${id}`);
  return { id, key: parsed };
}
