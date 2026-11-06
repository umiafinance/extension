import * as s2circuits from "/browser-rpc/resources/stwo/s2circuits.js";

// Each module worker owns a separate, single-threaded WASM instance.
const ready = s2circuits.default();

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

self.onmessage = async ({ data: { id, algorithm, witness } }) => {
  try {
    await ready;
    const input = JSON.parse(new TextDecoder().decode(witness));
    const key = fromBase64(input.key);
    const nonce = fromBase64(input.nonce);
    const plaintext = fromBase64(input.plaintext);
    const ciphertext = fromBase64(input.ciphertext);
    const proveStartedAt = performance.now();
    let resultJson;
    switch (algorithm) {
      case "chacha20":
        resultJson = s2circuits.generate_chacha20_proof(
          key,
          nonce,
          input.counter,
          plaintext,
          ciphertext,
        );
        break;
      case "aes-128-ctr":
        resultJson = s2circuits.generate_aes128_ctr_proof(
          key,
          nonce,
          input.counter,
          plaintext,
          ciphertext,
        );
        break;
      case "aes-256-ctr":
        resultJson = s2circuits.generate_aes256_ctr_proof(
          key,
          nonce,
          input.counter,
          plaintext,
          ciphertext,
        );
        break;
      default:
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }
    const result = JSON.parse(resultJson);
    const workerProveMs = performance.now() - proveStartedAt;
    if (result.error) throw new Error(`Stwo proof generation failed: ${result.error}`);
    if (!result.proof) throw new Error("Stwo proof generation failed: no proof returned");
    const proof = fromBase64(result.proof);
    self.postMessage({ id, result: { proof }, workerProveMs }, [proof.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
};
