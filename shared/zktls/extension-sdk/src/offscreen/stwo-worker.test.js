import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("Stwo worker dispatches algorithms from the message, not the witness", async () => {
  const source = readFileSync(new URL("./stwo-worker.js", import.meta.url), "utf8");
  const workerSource = source.replace(
    /^import \* as s2circuits from "\/browser-rpc\/resources\/stwo\/s2circuits\.js";\n/,
    "",
  );
  assert.notEqual(workerSource, source, "the worker module import must be replaced by the test stub");

  const calls = [];
  const messages = [];
  const prove = (algorithm) => (...args) => {
    calls.push({ algorithm, args });
    return JSON.stringify({ proof: Buffer.from([7]).toString("base64") });
  };
  const worker = { postMessage: (message) => messages.push(message) };
  runInNewContext(workerSource, {
    self: worker,
    s2circuits: {
      default: async () => {},
      generate_chacha20_proof: prove("chacha20"),
      generate_aes128_ctr_proof: prove("aes-128-ctr"),
      generate_aes256_ctr_proof: prove("aes-256-ctr"),
    },
    TextDecoder,
    Uint8Array,
    atob,
    performance,
  });

  // The generated witness has circuit inputs, but no algorithm discriminator.
  const witness = new TextEncoder().encode(
    JSON.stringify({
      key: Buffer.from([1]).toString("base64"),
      nonce: Buffer.from([2]).toString("base64"),
      counter: 3,
      plaintext: Buffer.from([4]).toString("base64"),
      ciphertext: Buffer.from([5]).toString("base64"),
    }),
  );
  for (const [index, algorithm] of ["chacha20", "aes-128-ctr", "aes-256-ctr"].entries()) {
    await worker.onmessage({ data: { id: index + 1, algorithm, witness } });
    assert.equal(calls[index].algorithm, algorithm);
    assert.equal(calls[index].args[2], 3);
    assert.equal(messages[index].id, index + 1);
    assert.deepEqual([...messages[index].result.proof], [7]);
  }
});
