# Offscreen document

The offscreen document generates proofs. attestor-core needs WASM, real WebSockets and
`crypto.getRandomValues`, none of which an MV3 service worker can use directly. The background
creates it on demand (`ensureOffscreenDocument()` in `../utils/offscreen-manager.js`) and talks
to it only through `chrome.runtime` messages. It is **not** web-accessible: a page that could
frame it would receive every proof request.

## Files

```
src/offscreen/
├── offscreen.html           # loads snarkjs.min.js and load-s2circuits.js, then the bundle
├── load-s2circuits.js       # puts the Stwo WASM module on window before offscreen.bundle.js
├── offscreen.js             # OffscreenProofGenerator: message handling and createClaimOnAttestor
├── session-attestor.js      # BoundAttestorSessions: one attestor client per bound session
├── stwo-worker.js           # module worker: one Stwo WASM instance per worker
└── snarkjs-worker.js        # classic worker: snarkjs groth16 with the pinned proving keys
```

Circuits load from the extension's own `browser-rpc/resources/` (staged by `web/extension`'s
build from the pinned asset mirror). The SDK build copies the HTML, loader and both workers
into `build/offscreen/`.

## Messages

All in `../utils/constants/interfaces.js`. `GENERATE_PROOF`, `CLOSE_BOUND_SESSION` and
`GET_PRIVATE_KEY` are accepted only from this extension's background (no tab sender).

| From background       | Reply                                                          |
| --------------------- | -------------------------------------------------------------- |
| `PING_OFFSCREEN`      | `OFFSCREEN_DOCUMENT_READY` (also sent once at load)            |
| `GENERATE_PROOF`      | `GENERATE_PROOF_RESPONSE` with the proof or a finite `code`    |
| `CLOSE_BOUND_SESSION` | closes that session's attestor client                          |
| `GET_PRIVATE_KEY`     | `GET_PRIVATE_KEY_RESPONSE` with a fresh 32-byte hex key        |

## Proof generation

- **One client per session.** `BoundAttestorSessions` opens a fresh client and socket per
  session/auth identity with the exact signed `authRequest`, and closes it on replacement,
  cancellation, completion, `pagehide` and at the session deadline. Results that arrive after a
  close are dropped.
- **Budget.** `createClaimOnAttestor` races `PROOF_GENERATION_TIMEOUT_MS` (120 s, in
  `../utils/constants/config.js`). A timeout or a socket that never opened reports
  `ATTESTOR_UNREACHABLE`; attestor rejections map to finite codes.
- **Workers.** Each claim gets its own pool of up to `ZK_WORKER_POOL_SIZE` workers (default
  `min(hardwareConcurrency, 4)`) from `../utils/zk/pooled-zk-operators.js`, for the claim's
  engine (`stwo` by default, `snarkjs` when the claim selects it). The pool closes when the claim
  finishes or is cancelled, or the document unloads. A crashed worker retries its chunk once in a
  new worker; a timeout fails the claim. Build with `ZK_WORKER_POOL_SIZE=0` to prove on the offscreen thread.
- **Stwo compression.** `../utils/zk/stwo-proof-compression.js` deflates each Stwo proof of
  64 KiB or more behind a `UMIA_STWO_ZLIB_V1` header when that is smaller. The attestor must
  accept this format. Build with `STWO_PROOF_COMPRESSION=0` for uncompressed proofs.

## Debugging

Logs go through `createRemoteLogger("offscreen")` to the service worker's console and are off by
default. Each claim logs chunk and pool timings and a proof-size summary: original, encoded and
maximum proof bytes, the compressed chunk count, and whether a proof exceeds 4 MiB or the total
exceeds 32 MiB. Those flags are diagnostic only; they do not change admission limits. Logs never
contain proof or witness contents, and attestor errors log only known error-code names and
allowlisted rejection reasons.
