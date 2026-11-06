import { afterEach, expect, test } from "bun:test";
import { submitBoundProofs, updateSessionStatus } from "../src/utils/fetch-calls.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function session() {
  const now = Math.floor(Date.now() / 1000);
  return {
    sessionId: "synthetic-session",
    umia: {
      providerVersion: "v1",
      sessionToken: "a".repeat(64),
      expiresAt: new Date((now + 600) * 1000).toISOString(),
      attestorAuth: {
        data: { id: "synthetic-session", createdAt: now, expiresAt: now + 300 },
      },
    },
    route: {
      backendUrl: "https://api.umia.conductor:8443/zktls",
      network: { environment: "devnet", chainId: 10143 },
    },
  };
}

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("sends the whole synthetic array only to fixed bearer intake and returns accepted polling proofs", async () => {
  const calls = [];
  const proofs = [{ synthetic: "one" }, { synthetic: "two" }];
  const accepted = [{ synthetic: "accepted-one" }, { synthetic: "accepted-two" }];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1
      ? jsonResponse({ status: "success" })
      : jsonResponse({
          session: { statusV2: "PROOF_SUBMITTED", providerVersionString: "v1", proofs: accepted },
        });
  };

  expect(await submitBoundProofs(proofs, session())).toEqual(accepted);
  expect(calls).toHaveLength(2);
  expect(calls[0].url).toBe(
    "https://api.umia.conductor:8443/zktls/session/synthetic-session/proof",
  );
  expect(calls[0].options).toMatchObject({
    method: "POST",
    redirect: "error",
    body: encodeURIComponent(JSON.stringify(proofs)),
  });
  expect(calls[0].options.headers.Authorization).toBe(`Bearer ${"a".repeat(64)}`);
  expect(calls[0].options.headers["Content-Type"]).toBe("text/plain");
  expect(calls[1].url).toBe(
    "https://api.umia.conductor:8443/zktls/api/sdk/session/synthetic-session",
  );
  expect(calls[1].options.redirect).toBe("error");
  expect(calls[1].options.headers.Authorization).toBe(`Bearer ${"a".repeat(64)}`);
});

test("rejects an unaccepted intake response before polling", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return jsonResponse({ status: "pending" });
  };
  await expect(submitBoundProofs([{ synthetic: true }], session())).rejects.toThrow(
    "VERIFICATION_FAILED",
  );
  expect(calls).toHaveLength(1);
});

test("reports an unreachable intake or poll as BACKEND_UNREACHABLE", async () => {
  for (const failAt of [1, 2]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === failAt) throw new TypeError("Failed to fetch");
      return jsonResponse({ status: "success" });
    };
    await expect(submitBoundProofs([{ synthetic: true }], session())).rejects.toThrow(
      "BACKEND_UNREACHABLE",
    );
  }
});

test("rejects an unaccepted or mismatched poll without returning private payloads", async () => {
  const privatePayload = "synthetic-private-proof";
  for (const status of ["USER_STARTED_VERIFICATION", "PROOF_SUBMITTED"]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ status: "success" })
        : jsonResponse({
            session: {
              statusV2: status,
              providerVersionString: status === "PROOF_SUBMITTED" ? "wrong" : "v1",
              proofs: [{ synthetic: privatePayload }],
            },
          });
    };
    await expect(submitBoundProofs([{ synthetic: true }], session())).rejects.toThrow(
      "VERIFICATION_FAILED",
    );
    expect(calls).toBe(2);
  }
});

test("rejects invalid arrays before any request", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("unexpected fetch");
  };
  await expect(submitBoundProofs([], session())).rejects.toThrow("CONFIG_REJECTED");
  await expect(submitBoundProofs(Array(65).fill({ synthetic: true }), session())).rejects.toThrow(
    "CONFIG_REJECTED",
  );
  expect(calls).toBe(0);
});

test("accepts only the canonical bearer status success response", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ status: calls.length === 1 ? "pending" : "success" });
  };
  await expect(updateSessionStatus(session(), "PROOF_GENERATION_STARTED")).rejects.toThrow(
    "Failed to update session status",
  );
  expect(await updateSessionStatus(session(), "PROOF_GENERATION_STARTED")).toEqual({
    status: "success",
  });
  expect(calls[1].url).toBe("https://api.umia.conductor:8443/zktls/api/sdk/update/session/");
  expect(calls[1].options).toMatchObject({ method: "POST", redirect: "error" });
  expect(JSON.parse(calls[1].options.body)).toEqual({
    sessionId: "synthetic-session",
    status: "PROOF_GENERATION_STARTED",
  });
  expect(calls[1].options.headers.Authorization).toBe(`Bearer ${"a".repeat(64)}`);
});
