import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("snarkjs worker loads local assets and proves on one thread", async () => {
  const messages = [];
  const fetches = [];
  const calls = [];
  const self = {
    location: { href: "chrome-extension://test/reclaim-browser-extension-sdk/offscreen/snarkjs-worker.js" },
    postMessage: (message) => messages.push(message),
  };
  const script = readFileSync(new URL("./snarkjs-worker.js", import.meta.url), "utf8");
  runInNewContext(script, {
    self,
    URL,
    performance,
    importScripts: (url) => {
      assert.equal(
        url,
        "chrome-extension://test/browser-rpc/resources/snarkjs/snarkjs.min.js",
      );
      self.snarkjs = {
        groth16: {
          prove: async (key, witness, logger, options) => {
            calls.push({ key: [...key], witness: [...witness], logger, options });
            return { proof: { pi_a: ["1"] } };
          },
        },
      };
    },
    fetch: async (url) => {
      fetches.push(String(url));
      return { ok: true, arrayBuffer: async () => new Uint8Array([7, 8]).buffer };
    },
  });

  await self.onmessage({ data: { id: 1, algorithm: "chacha20", witness: new Uint8Array([2]) } });
  await self.onmessage({ data: { id: 2, algorithm: "chacha20", witness: new Uint8Array([3]) } });
  assert.deepEqual(fetches, [
    "chrome-extension://test/browser-rpc/resources/snarkjs/chacha20/circuit_final.zkey",
  ]);
  assert.deepEqual(calls.map(({ key, witness, options }) => ({ key, witness, singleThread: options.singleThread })), [
    { key: [7, 8], witness: [2], singleThread: true },
    { key: [7, 8], witness: [3], singleThread: true },
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].result.proof, '{"pi_a":["1"]}');
});
