// Only Stwo proof bytes enter this compression stream. HTTP request and receipt
// plaintext stay outside it, so they cannot share the compressor dictionary.
export const STWO_PROOF_COMPRESSION_MAGIC = new TextEncoder().encode("UMIA_STWO_ZLIB_V1\0");
const MIN_PROOF_BYTES = 64 * 1024;

export async function compressStwoProof(proof) {
  if (!(proof instanceof Uint8Array) || proof.length < MIN_PROOF_BYTES || !globalThis.CompressionStream) {
    return proof;
  }

  try {
    const stream = new Blob([proof]).stream().pipeThrough(new CompressionStream("deflate"));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    if (compressed.length + STWO_PROOF_COMPRESSION_MAGIC.length >= proof.length) return proof;
    const encoded = new Uint8Array(STWO_PROOF_COMPRESSION_MAGIC.length + compressed.length);
    encoded.set(STWO_PROOF_COMPRESSION_MAGIC);
    encoded.set(compressed, STWO_PROOF_COMPRESSION_MAGIC.length);
    return encoded;
  } catch {
    // A browser without a working compressor can still submit ordinary proofs.
    return proof;
  }
}
