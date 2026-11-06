import assert from "node:assert/strict";
import { test } from "node:test";
import { makePooledSnarkjsOperators, makePooledStwoOperators } from "./pooled-zk-operators.js";

test("Stwo pool dispatches round robin and retries a crashed worker in a new worker", async () => {
  const workers = [];
  const inlineCalls = [];
  const proofs = [];

  class MockWorker {
    constructor(url, options) {
      assert.equal(url, "extension://stwo-worker.js");
      assert.equal(options.type, "module");
      this.messages = [];
      workers.push(this);
    }

    postMessage(message, transfers) {
      assert.equal(transfers.length, 1);
      assert.equal(transfers[0], message.witness.buffer);
      this.messages.push(structuredClone(message, { transfer: transfers }));
      assert.equal(message.witness.byteLength, 0);
    }

    terminate() {
      this.terminated = true;
    }

    resolve(index, result) {
      this.onmessage({ data: { id: this.messages[index].id, result } });
    }

  }

  const operators = makePooledStwoOperators(2, {
    WorkerCtor: MockWorker,
    workerUrl: "extension://stwo-worker.js",
    timeoutMs: 1000,
    makeOperator: (algorithm) => ({
      generateWitness: () => new Uint8Array([1]),
      groth16Verify: async () => true,
      groth16Prove: async (witness) => {
        inlineCalls.push({ algorithm, witness: [...witness] });
        return { proof: new Uint8Array([9]) };
      },
    }),
    onProve: (result) => proofs.push(result),
  });

  const first = new Uint8Array([1]);
  const second = new Uint8Array([2]);
  const third = new Uint8Array([3]);
  const jobs = [
    operators.chacha20.groth16Prove(first),
    operators["aes-128-ctr"].groth16Prove(second),
    operators.chacha20.groth16Prove(third),
  ];
  assert.equal(workers.length, 2);
  assert.equal(workers[0].messages.length, 1);
  assert.equal(workers[1].messages.length, 1);
  assert.equal(first.byteLength, 1, "the original witness survives transfer");
  workers[0].resolve(0, { proof: new Uint8Array([7]) });
  assert.equal(workers[0].messages.length, 2, "third job returns to the first worker");
  workers[1].onerror({ message: "worker crashed", preventDefault() {} });
  assert.equal(workers.length, 3, "a crashed worker is replaced");
  assert.deepEqual([...workers[2].messages[0].witness], [2]);
  workers[2].resolve(0, { proof: new Uint8Array([9]) });
  workers[0].resolve(1, { proof: new Uint8Array([8]) });
  const results = await Promise.all(jobs);
  assert.deepEqual(results.map(({ proof }) => [...proof]), [[7], [9], [8]]);
  assert.deepEqual(inlineCalls, []);
  assert.equal(workers[1].terminated, true);
  assert.equal(proofs.length, 3);
  assert.equal(proofs.filter((proof) => proof.fallback).length, 0);
  operators.close();
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[2].terminated, true);
});

test("snarkjs pool reports a proof error without blocking on an inline retry", async () => {
  let worker;
  const inlineCalls = [];
  class MockWorker {
    constructor(url, options) {
      assert.equal(url, "extension://snarkjs-worker.js");
      assert.equal(options.type, "classic");
      worker = this;
    }
    postMessage(message, transfers) {
      assert.equal(message.algorithm, "chacha20");
      assert.equal(transfers[0], message.witness.buffer);
      this.message = structuredClone(message, { transfer: transfers });
    }
    terminate() {}
  }
  const operators = makePooledSnarkjsOperators(1, {
    WorkerCtor: MockWorker,
    workerUrl: "extension://snarkjs-worker.js",
    timeoutMs: 1000,
    makeOperator: () => ({
      generateWitness: async () => new Uint8Array([1]),
      groth16Verify: async () => true,
      groth16Prove: async (witness) => {
        inlineCalls.push([...witness]);
        return { proof: "stock" };
      },
    }),
  });
  const first = operators.chacha20.groth16Prove(new Uint8Array([2]));
  worker.onmessage({ data: { id: worker.message.id, result: { proof: "worker" } } });
  assert.equal((await first).proof, "worker");
  const second = operators.chacha20.groth16Prove(new Uint8Array([3]));
  const failure = assert.rejects(second, /worker failed/);
  worker.onmessage({ data: { id: worker.message.id, error: "worker failed" } });
  await failure;
  assert.deepEqual(inlineCalls, []);
  operators.close();
});

test("closing a claim drops queued and running proofs before the next claim", async () => {
  const workers = [];
  let inlineCalls = 0;
  class MockWorker {
    constructor() {
      this.messages = [];
      workers.push(this);
    }
    postMessage(message) {
      this.messages.push(message);
    }
    terminate() {
      this.terminated = true;
    }
  }
  const options = {
    WorkerCtor: MockWorker,
    workerUrl: "extension://stwo-worker.js",
    makeOperator: () => ({
      groth16Prove: async () => {
        inlineCalls++;
        return { proof: "inline" };
      },
    }),
  };
  const oldClaim = makePooledStwoOperators(1, options);
  const running = oldClaim.chacha20.groth16Prove(new Uint8Array([1]));
  const queued = oldClaim.chacha20.groth16Prove(new Uint8Array([2]));
  const failures = [assert.rejects(running, /pool closed/), assert.rejects(queued, /pool closed/)];
  assert.equal(workers[0].messages.length, 1);
  oldClaim.close();
  await Promise.all(failures);
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[0].messages.length, 1);
  assert.equal(inlineCalls, 0);

  const nextClaim = makePooledStwoOperators(1, options);
  const next = nextClaim.chacha20.groth16Prove(new Uint8Array([3]));
  const message = workers[1].messages[0];
  workers[1].onmessage({ data: { id: message.id, result: { proof: "new" } } });
  assert.equal((await next).proof, "new");
  nextClaim.close();
  assert.equal(inlineCalls, 0);
});

test("a worker timeout ends the proof without an inline retry", async () => {
  const workers = [];
  let inlineCalls = 0;
  class MockWorker {
    constructor() {
      workers.push(this);
    }
    postMessage() {}
    terminate() {
      this.terminated = true;
    }
  }
  const operators = makePooledStwoOperators(1, {
    WorkerCtor: MockWorker,
    workerUrl: "extension://stwo-worker.js",
    timeoutMs: 5,
    makeOperator: () => ({
      groth16Prove: async () => {
        inlineCalls++;
      },
    }),
  });
  await assert.rejects(operators.chacha20.groth16Prove(new Uint8Array([1])), /timed out/);
  assert.equal(workers[0].terminated, true);
  assert.equal(inlineCalls, 0);
  operators.close();
});

test("worker construction failure uses the stock prover", async () => {
  const operators = makePooledStwoOperators(1, {
    WorkerCtor: class {
      constructor() {
        throw new Error("workers unavailable");
      }
    },
    makeOperator: () => ({ groth16Prove: async () => ({ proof: "inline" }) }),
  });
  assert.equal((await operators.chacha20.groth16Prove(new Uint8Array([1]))).proof, "inline");
  operators.close();
});

test("Stwo metrics count original and encoded proof bytes without exposing proof data", async () => {
  const events = [];
  const raw = new Uint8Array(200_000).fill(65);
  const operators = makePooledStwoOperators(0, {
    makeOperator: () => ({ groth16Prove: async () => ({ proof: raw }) }),
    onProve: (event) => events.push(event),
  });
  try {
    const encoded = await operators.chacha20.groth16Prove(new Uint8Array([1]));
    assert.equal(events.length, 1);
    assert.equal(events[0].proofBytes, raw.byteLength);
    assert.equal(events[0].encodedProofBytes, encoded.proof.byteLength);
    assert.ok(events[0].encodedProofBytes < events[0].proofBytes);
    assert.equal(Object.values(events[0]).some((value) => value instanceof Uint8Array), false);
    assert.equal("proof" in events[0], false);
    assert.equal("witness" in events[0], false);
  } finally {
    operators.close();
  }
});
