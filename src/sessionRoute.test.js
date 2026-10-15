import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionRouteResolver } from "./sessionRoute.js";

const callerOrigin = "https://hub.umia.conductor:8443";
const candidate = {
  backendUrl: "https://api.umia.conductor:8443/zktls",
  attestorUrl: "wss://attestor.zktls.umia.finance/ws",
  witness: `0x${"1".repeat(40)}`,
  network: { environment: "devnet", chainId: 10143 },
};

test("passes only the browser sender origin and candidate to the shared resolver", async () => {
  const calls = [];
  const catalogue = { records: [] };
  const authority = { witnesses: [candidate.witness], chainId: 10143 };
  const resolveSessionRoute = createSessionRouteResolver({
    catalogue,
    now: () => Date.parse("2026-10-07T13:00:00.000Z"),
    resolveActivatedSessionRoute: (...args) => {
      calls.push(args);
      return { profile: "cloud-devnet", authority };
    },
  });
  const sender = { origin: callerOrigin, url: `${callerOrigin}/sandbox/zktls-verify`, frameId: 0 };
  const first = await resolveSessionRoute({ sender, sessionId: "session-a", candidate });
  const second = await resolveSessionRoute({ sender, sessionId: "session-b", candidate });
  assert.deepEqual(calls[0].slice(0, 3), [catalogue, callerOrigin, candidate]);
  assert.equal(calls[0][3].toISOString(), "2026-10-07T13:00:00.000Z");
  assert.deepEqual(first, { profile: "cloud-devnet", authority });
  assert.notEqual(first.authority, second.authority);
  assert.ok(Object.isFrozen(first.authority.witnesses));
  authority.witnesses.push(`0x${"2".repeat(40)}`);
  assert.equal(first.authority.witnesses.length, 1);
});

test("rejects wrong frame, wrong origin tuple and missing session before shared resolution", async () => {
  let calls = 0;
  const resolveSessionRoute = createSessionRouteResolver({
    catalogue: { records: [] },
    resolveActivatedSessionRoute: () => {
      calls += 1;
      return null;
    },
  });
  for (const { sender, sessionId } of [
    { sender: { origin: callerOrigin, frameId: 1 }, sessionId: "session-a" },
    {
      sender: { origin: callerOrigin, url: "https://admin.umia.conductor:8443/" },
      sessionId: "session-a",
    },
    { sender: { origin: callerOrigin, frameId: 0 }, sessionId: "" },
  ]) {
    assert.equal(await resolveSessionRoute({ sender, sessionId, candidate }), null);
  }
  assert.equal(calls, 0);
});

test("shared resolver controls authority selection and expiry on every call", async () => {
  let time = Date.parse("2026-10-07T13:00:00.000Z");
  const expires = Date.parse("2026-10-07T14:00:00.000Z");
  const resolveSessionRoute = createSessionRouteResolver({
    catalogue: { records: [] },
    now: () => time,
    resolveActivatedSessionRoute: (_catalogue, _origin, selected, now) =>
      selected === candidate && now.getTime() < expires
        ? { profile: "cloud-devnet", authority: { witnesses: [candidate.witness] } }
        : null,
  });
  const sender = { origin: callerOrigin, frameId: 0 };
  assert.equal(
    (await resolveSessionRoute({ sender, sessionId: "session-a", candidate })).profile,
    "cloud-devnet",
  );
  time = expires;
  assert.equal(await resolveSessionRoute({ sender, sessionId: "session-b", candidate }), null);
  assert.equal(
    await resolveSessionRoute({ sender, sessionId: "session-c", candidate: { ...candidate } }),
    null,
  );
});

test("canonical route errors reject without exposing candidate data", async () => {
  const sentinel = "private-config-canary";
  const sender = { origin: callerOrigin, frameId: 0 };
  const resolveSessionRoute = createSessionRouteResolver({
    catalogue: { records: [] },
    resolveActivatedSessionRoute: () => {
      throw Object.assign(new Error(sentinel), { code: "UNSUPPORTED_NETWORK" });
    },
  });
  assert.equal(
    await resolveSessionRoute({ sender, sessionId: "session-a", candidate: { ...candidate } }),
    null,
  );
});

test("missing trusted catalogue or shared resolver fails initialization", () => {
  assert.throws(
    () => createSessionRouteResolver({ catalogue: null, resolveActivatedSessionRoute: () => null }),
    /trusted activation/,
  );
  assert.throws(
    () => createSessionRouteResolver({ catalogue: {}, resolveActivatedSessionRoute: null }),
    /shared route resolver/,
  );
});
