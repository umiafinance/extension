import assert from "node:assert/strict";
import { test } from "bun:test";
import { zktlsEndpointProfile } from "@umia/zktls-config/self-host";

const devnet = zktlsEndpointProfile("native-devnet");

globalThis.__SDK_VERSION__ = "0.5.2";
globalThis.window = {
  URL,
  WebSocket,
  addEventListener() {},
  removeEventListener() {},
  postMessage(message) {
    globalThis.capturedSdkMessage = message;
  },
};
globalThis.self = globalThis;
globalThis.location = { protocol: "https:" };
globalThis.document = {
  createElement() {
    return { style: {}, setAttribute() {}, appendChild() {} };
  },
  head: { appendChild() {} },
};

const { ReclaimExtensionProofRequest } =
  await import("../src/ReclaimExtensionSDK.js");
const { freezeBoundSession, takeOffscreenSession } =
  await import("../src/utils/session-transport.js");
const { requireLiveSession } = await import("../src/utils/session-config.js");

test("bound umia survives the real SDK config, template, Chrome and offscreen copies", async () => {
  const now = Math.floor(Date.now() / 1000);
  const umia = {
    backendUrl: devnet.backendUrl,
    attestorUrl: devnet.attestorUrl,
    witness: `0x${"a".repeat(40)}`,
    sessionToken: "a".repeat(64),
    attestorAuth: {
      data: {
        id: "session-one",
        createdAt: now,
        expiresAt: now + 300,
        hostWhitelist: ["fixture.example"],
      },
      signature: `0x${"b".repeat(130)}`,
    },
    expiresAt: new Date((now + 600) * 1000).toISOString(),
    network: {
      environment: "devnet",
      chainId: 10143,
      beaconAddress: `0x${"c".repeat(40)}`,
      expectedEpoch: 2,
      authorityDigest: `sha256:${"d".repeat(64)}`,
    },
  };
  const config = {
    sessionId: "session-one",
    providerId: "provider-one",
    applicationId: "app-one",
    signature: "signed-init",
    parameters: { account: "demo" },
    umia,
  };
  const instance = ReclaimExtensionProofRequest.fromConfig(config, {
    extensionID: "test-extension",
  });
  assert.deepEqual(instance.umia, umia);
  assert.notEqual(instance.umia, umia);
  config.umia.sessionToken = "mutated-after-binding";
  assert.equal(instance.umia.sessionToken, "a".repeat(64));
  config.umia.sessionToken = "a".repeat(64);
  assert.equal(instance.getStatusUrl(), `${devnet.backendUrl}/api/sdk/session/session-one`);

  const verification = instance.startVerification();
  const template = globalThis.capturedSdkMessage.data;
  assert.notEqual(template.umia, instance.umia);
  assert.notEqual(template.parameters, instance.parameters);
  assert.deepEqual(template.umia, umia);
  assert.equal(template.sessionId, config.sessionId);
  assert.equal(template.umia.sessionId, undefined);
  const chromeCopy = JSON.parse(JSON.stringify(template));
  const sessionRoute = {
    profile: devnet.profile,
    callerOrigin: devnet.callerOrigin,
    backendUrl: umia.backendUrl,
    attestorUrl: umia.attestorUrl,
    witness: umia.witness,
    network: umia.network,
  };
  const offscreenCopy = JSON.parse(
    JSON.stringify({
      name: "http",
      session: freezeBoundSession({
        sessionId: chromeCopy.sessionId,
        umia: chromeCopy.umia,
        route: sessionRoute,
      }),
      client: { url: sessionRoute.attestorUrl },
    }),
  );
  const offscreen = takeOffscreenSession(offscreenCopy);
  const { sessionToken, attestorAuth, expiresAt } = umia;
  assert.deepEqual(offscreen.session.umia, {
    sessionToken,
    attestorAuth,
    expiresAt,
  });
  assert.equal(offscreen.session.sessionId, config.sessionId);
  assert.equal(offscreen.claim.session, undefined);
  assert.equal(offscreen.claim.client.url, umia.attestorUrl);
  assert.equal(JSON.stringify(offscreen.claim).includes(umia.sessionToken), false);
  assert.equal(requireLiveSession(offscreen.session).route.profile, "native-devnet");

  instance._emit("completed", []);
  await verification;
  instance.dispose();
});

test("raw init cannot promote an unbound response into a bearer session", async () => {
  const original = ReclaimExtensionProofRequest.prototype._initSession;
  let initPayload;
  ReclaimExtensionProofRequest.prototype._initSession = async (payload) => {
    initPayload = payload;
    return {
      sessionId: "raw-session",
      umia: { sessionToken: "unexpected-private-data" },
    };
  };
  try {
    const request = await ReclaimExtensionProofRequest.init(
      "app-one",
      `0x${"1".repeat(64)}`,
      "provider-one",
      { extensionID: "test-extension" },
    );
    assert.deepEqual(Object.keys(initPayload), ["providerId", "appId", "timestamp", "signature"]);
    assert.equal(request.sessionId, "raw-session");
    assert.equal(request.umia, null);
    await assert.rejects(request.startVerification(), /Bound session configuration is required/);
    request.dispose();
  } finally {
    ReclaimExtensionProofRequest.prototype._initSession = original;
  }
});
