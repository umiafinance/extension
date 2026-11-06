// A classic worker can load the same pinned snarkjs bundle as the offscreen page.
// Force its curve implementation to stay on this worker: ffjavascript's default
// blob workers are blocked by the extension CSP.
const resourceRoot = new URL("/browser-rpc/resources/snarkjs/", self.location.href);
importScripts(new URL("snarkjs.min.js", resourceRoot).href);

const algorithms = new Set(["chacha20", "aes-128-ctr", "aes-256-ctr"]);
const provingKeys = new Map();

function provingKey(algorithm) {
  let key = provingKeys.get(algorithm);
  if (!key) {
    key = fetch(new URL(`${algorithm}/circuit_final.zkey`, resourceRoot))
      .then((response) => {
        if (!response.ok) throw new Error(`snarkjs proving key unavailable: ${response.status}`);
        return response.arrayBuffer();
      })
      .then((buffer) => new Uint8Array(buffer));
    provingKeys.set(algorithm, key);
    key.catch(() => provingKeys.delete(algorithm));
  }
  return key;
}

self.onmessage = async ({ data: { id, algorithm, witness } }) => {
  try {
    if (!algorithms.has(algorithm)) throw new Error("Unsupported ZK algorithm");
    const key = await provingKey(algorithm);
    const startedAt = performance.now();
    const { proof } = await self.snarkjs.groth16.prove(key, witness, undefined, {
      singleThread: true,
    });
    self.postMessage({
      id,
      result: { proof: JSON.stringify(proof) },
      workerProveMs: performance.now() - startedAt,
    });
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
};
