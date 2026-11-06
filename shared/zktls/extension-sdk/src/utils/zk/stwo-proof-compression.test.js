import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { compressStwoProof, STWO_PROOF_COMPRESSION_MAGIC } from "./stwo-proof-compression.js";

test("compresses only large, compressible Stwo proof bytes", async () => {
  const proof = new Uint8Array(200_000).fill(0x41);
  const encoded = await compressStwoProof(proof);
  assert.deepEqual(encoded.subarray(0, STWO_PROOF_COMPRESSION_MAGIC.length), STWO_PROOF_COMPRESSION_MAGIC);
  assert.ok(encoded.length < proof.length / 10);
  assert.equal(Buffer.compare(inflateSync(encoded.subarray(STWO_PROOF_COMPRESSION_MAGIC.length)), proof), 0);
  const small = new Uint8Array(32);
  assert.equal(await compressStwoProof(small), small);
});
