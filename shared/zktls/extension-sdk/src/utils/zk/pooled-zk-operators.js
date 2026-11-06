import { PROOF_GENERATION_TIMEOUT_MS, STWO_PROOF_COMPRESSION } from "../constants/config.js";
import { compressStwoProof } from "./stwo-proof-compression.js";

const ALGORITHMS = ["chacha20", "aes-128-ctr", "aes-256-ctr"];
const WORKER_PATHS = {
  stwo: "reclaim-browser-extension-sdk/offscreen/stwo-worker.js",
  snarkjs: "reclaim-browser-extension-sdk/offscreen/snarkjs-worker.js",
};

class ZkWorkerPool {
  constructor(size, { WorkerCtor, workerUrl, workerType, timeoutMs }) {
    this.workerUrl = workerUrl;
    this.WorkerCtor = WorkerCtor;
    this.workerType = workerType;
    this.timeoutMs = timeoutMs;
    this.slots = [];
    try {
      for (let index = 0; index < size; index++) this.slots.push(this.makeSlot(index));
    } catch (error) {
      for (const slot of this.slots) slot.worker.terminate();
      throw error;
    }
    this.queue = [];
    this.nextId = 0;
    this.nextSlot = 0;
    this.closed = false;
  }

  makeSlot(index, failures = 0) {
    const worker = new this.WorkerCtor(this.workerUrl, { type: this.workerType });
    const slot = { worker, task: null, failures };
    worker.onmessage = ({ data }) => {
      if (slot.task?.id !== data?.id) return;
      if (data.error) this.fail(slot, new Error(data.error));
      else this.finish(slot, data.result, data.workerProveMs);
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      this.fail(slot, new Error(event.message || `ZK worker ${index} failed`), true);
    };
    worker.onmessageerror = () => this.fail(slot, new Error("ZK worker message failed"), true);
    return slot;
  }

  replace(slot) {
    slot.worker.terminate();
    if (this.closed) return;
    const index = this.slots.indexOf(slot);
    if (index < 0) return;
    if (slot.failures >= 2) {
      this.slots[index] = null;
      return;
    }
    try {
      this.slots[index] = this.makeSlot(index, slot.failures + 1);
    } catch {
      // Remaining tasks fail if no worker can be constructed.
      this.slots[index] = null;
    }
  }

  finish(slot, result, workerProveMs) {
    const task = slot.task;
    clearTimeout(task.timeout);
    slot.task = null;
    slot.failures = 0;
    task.resolve({ result, workerProveMs });
    this.drain();
  }

  fail(slot, error, retry = false) {
    const task = slot.task;
    if (task) {
      clearTimeout(task.timeout);
      slot.task = null;
    }
    this.replace(slot);
    if (task) {
      if (
        retry &&
        task.retries === 0 &&
        !this.closed &&
        performance.now() < task.deadlineAt &&
        this.slots.some(Boolean)
      ) {
        task.retries++;
        this.queue.unshift(task);
      } else {
        task.reject(error);
      }
    }
    this.drain();
  }

  prove(algorithm, witness) {
    if (this.closed) return Promise.reject(new Error("ZK worker pool is closed"));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.nextId, algorithm, witness, resolve, reject, timeout: null, retries: 0, deadlineAt: null });
      this.drain();
    });
  }

  drain() {
    while (this.queue.length) {
      let index = -1;
      for (let offset = 0; offset < this.slots.length; offset++) {
        const candidate = (this.nextSlot + offset) % this.slots.length;
        if (this.slots[candidate] && !this.slots[candidate].task) {
          index = candidate;
          break;
        }
      }
      if (index < 0) break;
      const slot = this.slots[index];
      const task = this.queue.shift();
      this.nextSlot = (index + 1) % this.slots.length;
      task.deadlineAt ??= performance.now() + this.timeoutMs;
      const remainingMs = task.deadlineAt - performance.now();
      if (remainingMs <= 0) {
        task.reject(new Error("ZK worker proof timed out"));
        continue;
      }
      slot.task = task;
      // Keep the original so a crashed worker can retry once in a fresh worker.
      // The submitted clone is transferred, not cloned by postMessage.
      const transferred = task.witness.slice();
      task.timeout = setTimeout(
        () => this.fail(slot, new Error("ZK worker proof timed out")),
        remainingMs,
      );
      try {
        slot.worker.postMessage(
          { id: task.id, algorithm: task.algorithm, witness: transferred },
          [transferred.buffer],
        );
      } catch (error) {
        this.fail(slot, error, true);
      }
    }
    if (this.slots.every((slot) => !slot)) {
      for (const task of this.queue.splice(0)) {
        task.reject(new Error("ZK workers are unavailable"));
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const task of this.queue.splice(0)) task.reject(new Error("ZK worker pool closed"));
    for (const slot of this.slots) {
      if (!slot) continue;
      if (slot.task) {
        clearTimeout(slot.task.timeout);
        slot.task.reject(new Error("ZK worker pool closed"));
        slot.task = null;
      }
      slot.worker.terminate();
    }
  }
}

/** Keep the browser bundle's stock witness and verification methods. */
function makePooledOperators(engine, size, options = {}) {
  const {
    WorkerCtor = globalThis.Worker,
    workerUrl = globalThis.chrome?.runtime?.getURL?.(WORKER_PATHS[engine]),
    timeoutMs = PROOF_GENERATION_TIMEOUT_MS,
    makeOperator,
    onProve = () => {},
  } = options;
  if (typeof makeOperator !== "function") throw new Error("A browser ZK operator factory is required");
  const stockOperators = Object.fromEntries(
    ALGORITHMS.map((algorithm) => [algorithm, makeOperator(algorithm)]),
  );
  let pool;
  try {
    pool =
      size > 0
        ? new ZkWorkerPool(size, {
            WorkerCtor,
            workerUrl,
            workerType: engine === "stwo" ? "module" : "classic",
            timeoutMs,
          })
        : null;
  } catch {
    pool = null;
  }
  const poolSize = pool ? size : 0;
  const operators = Object.fromEntries(
    ALGORITHMS.map((algorithm) => {
      const stock = stockOperators[algorithm];
      return [
        algorithm,
        {
          ...stock,
          async groth16Prove(witness, logger) {
            const startedAt = performance.now();
            const fallback = size > 0 && !pool;
            let workerProveMs;
            let proofBytes;
            let encodedProofBytes;
            try {
              let result;
              if (pool) {
                const workerResult = await pool.prove(algorithm, witness);
                workerProveMs = workerResult.workerProveMs;
                result = workerResult.result;
              } else {
                result = await stock.groth16Prove(witness, logger);
              }
              if (result.proof instanceof Uint8Array) proofBytes = result.proof.byteLength;
              const encoded = engine === "stwo" && STWO_PROOF_COMPRESSION
                ? { ...result, proof: await compressStwoProof(result.proof) }
                : result;
              if (encoded.proof instanceof Uint8Array) encodedProofBytes = encoded.proof.byteLength;
              return encoded;
            } finally {
              const endedAt = performance.now();
              onProve({
                engine,
                algorithm,
                poolSize,
                proveMs: endedAt - startedAt,
                workerProveMs,
                startedAt,
                endedAt,
                fallback,
                proofBytes,
                encodedProofBytes,
              });
            }
          },
        },
      ];
    }),
  );
  Object.defineProperty(operators, "close", { value: () => pool?.close() });
  Object.defineProperty(operators, "poolSize", { value: poolSize });
  return operators;
}

export function makePooledStwoOperators(size, options) {
  return makePooledOperators("stwo", size, options);
}

export function makePooledSnarkjsOperators(size, options) {
  return makePooledOperators("snarkjs", size, options);
}
