import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZKTLS_EXTENSION_ORIGIN_ALLOWLIST } from "@umia/zktls-config/self-host";
import {
  authorizeStart,
  boundSessionDeadline,
  approvedBackendUrl,
  requireLiveSession,
  validateCaller,
  validateSessionConfig,
} from "./session-config.js";
import {
  copyUmia,
  freezeBoundSession,
  takeOffscreenSession,
  verificationTemplate,
} from "./session-transport.js";
import { fetchProviderData, postTelemetry, updateSessionStatus } from "./fetch-calls.js";
import { formatProof } from "./proof-generator/proof-formatter.js";
import { failureCode } from "./constants/interfaces.js";

const approved = ZKTLS_EXTENSION_ORIGIN_ALLOWLIST[0];
const profiles = [approved];
const sender = {
  url: `${approved.callerOrigin}/auction/1`,
  origin: approved.callerOrigin,
  tab: { id: 42 },
  frameId: 0,
};
const witness = `0x${"a".repeat(40)}`;
const selectedNetwork = {
  environment: "devnet",
  chainId: 10143,
  beaconAddress: `0x${"b".repeat(40)}`,
  expectedEpoch: 2,
  authorityDigest: `sha256:${"c".repeat(64)}`,
  witness,
  attestorUrl: approved.attestorUrl,
};

function fixture() {
  const now = Math.floor(Date.now() / 1000);
  return {
    sessionId: "session-one",
    providerId: "provider-one",
    applicationId: "app-one",
    signature: "public-signature",
    timestamp: String(Date.now()),
    parameters: {},
    umia: {
      backendUrl: approved.backendUrl,
      attestorUrl: approved.attestorUrl,
      witness,
      sessionToken: "a".repeat(64),
      attestorAuth: {
        data: {
          id: "session-one",
          createdAt: now,
          expiresAt: now + 300,
          hostWhitelist: ["fixture.example"],
        },
        signature: `0x${"d".repeat(130)}`,
      },
      expiresAt: new Date((now + 600) * 1000).toISOString(),
      network: {
        environment: selectedNetwork.environment,
        chainId: selectedNetwork.chainId,
        beaconAddress: selectedNetwork.beaconAddress,
        expectedEpoch: selectedNetwork.expectedEpoch,
        authorityDigest: selectedNetwork.authorityDigest,
      },
    },
  };
}

function validate(request = fixture(), from = sender) {
  return validateSessionConfig(request, from, approved, attestor());
}

function attestor(profile = approved) {
  return { url: profile.attestorUrl, signerAddress: witness, claimEpoch: 2 };
}

function route(profile = approved, network = selectedNetwork) {
  return {
    profile: profile.profile,
    callerOrigin: profile.callerOrigin,
    backendUrl: profile.backendUrl,
    attestorUrl: profile.attestorUrl,
    witness,
    network: {
      environment: network.environment,
      chainId: network.chainId,
      beaconAddress: network.beaconAddress,
      expectedEpoch: network.expectedEpoch,
      authorityDigest: network.authorityDigest,
    },
  };
}

const CREDENTIAL_KEYS = ["sessionToken", "attestorAuth", "expiresAt"];

function bound({ sessionId = "session-one", umia = fixture().umia, sessionRoute = route() } = {}) {
  return freezeBoundSession({ sessionId, umia, route: sessionRoute });
}

describe("bound SDK session routing", () => {
  it("keeps the canonical nested block through config copy, template, Chrome JSON and background copy", () => {
    const request = fixture();
    const fromConfig = { ...request, umia: copyUmia(request.umia) };
    const template = verificationTemplate(fromConfig);
    const chromeMessage = JSON.parse(
      JSON.stringify({ action: "START_VERIFICATION", data: template }),
    );
    const backgroundCopy = copyUmia(validate(chromeMessage.data));
    const offscreenMessage = JSON.parse(
      JSON.stringify({
        session: bound({ sessionId: template.sessionId, umia: backgroundCopy }),
        client: { url: backgroundCopy.attestorUrl },
      }),
    );
    const offscreen = takeOffscreenSession({
      ...offscreenMessage,
      profiles: ["mainnet"],
      client: {
        ...offscreenMessage.client,
        authRequest: { data: { hostWhitelist: ["attacker.example"] } },
      },
    });
    assert.deepEqual(offscreen.profiles, ["mainnet"]);
    assert.equal(offscreen.claim.profiles, undefined);
    assert.deepEqual(Object.keys(offscreen.session.umia), CREDENTIAL_KEYS);
    for (const key of CREDENTIAL_KEYS) {
      assert.deepEqual(offscreen.session.umia[key], request.umia[key]);
    }
    assert.equal(offscreen.session.sessionId, request.sessionId);
    assert.equal(offscreen.session.route.backendUrl, request.umia.backendUrl);
    assert.equal(offscreen.claim.session, undefined);
    assert.equal(JSON.stringify(offscreen.claim).includes(request.umia.sessionToken), false);
    assert.equal(offscreen.claim.client.url, request.umia.attestorUrl);
    assert.equal(offscreen.claim.client.authRequest, undefined);
    assert.notEqual(fromConfig.umia, request.umia);
    assert.notEqual(template.umia, fromConfig.umia);
    assert.notEqual(backgroundCopy, chromeMessage.data.umia);
    assert.throws(
      () =>
        takeOffscreenSession({
          ...offscreenMessage,
          client: { url: "wss://attestor.zktls.umia.finance.evil/ws" },
        }),
      /Offscreen attestor destination mismatch/,
    );
  });

  it("rejects absent, malformed and mismatched bound credentials and pin", () => {
    for (const change of [
      (r) => delete r.umia,
      (r) => {
        r.umia.sessionToken = "";
      },
      (r) => {
        r.umia.sessionToken = "A".repeat(64);
      },
      (r) => {
        r.umia.sessionToken = "x".repeat(64);
      },
      (r) => {
        r.umia.attestorAuth.signature = "0x12";
      },
      (r) => {
        r.umia.attestorAuth.data.id = "other";
      },
      (r) => {
        r.umia.attestorAuth.data.hostWhitelist = [];
      },
      (r) => {
        r.umia.expiresAt = "2000-01-01T00:00:00.000Z";
      },
      (r) => {
        r.umia.sessionId = "other";
      },
    ]) {
      const request = fixture();
      change(request);
      assert.throws(() => validate(request));
    }
  });

  it("accepts a scoped attestor authorization only for its exact session", () => {
    const request = fixture();
    request.umia.attestorAuth.data.id = `umia1:${request.sessionId}:github:0x${"a".repeat(64)}:${"b".repeat(64)}`;
    assert.equal(validate(request).attestorAuth.data.id, request.umia.attestorAuth.data.id);
    request.umia.attestorAuth.data.id = `umia1:other:github:0x${"a".repeat(64)}:${"b".repeat(64)}`;
    assert.throws(() => validate(request), /Invalid attestor authorization/);
  });

  it("accepts only the signed canonical ASCII host wire form", () => {
    const canonical = fixture();
    canonical.umia.attestorAuth.data.hostWhitelist = ["api.example", "xn--bcher-kva.example"];
    assert.deepEqual(
      validate(canonical).attestorAuth.data.hostWhitelist,
      canonical.umia.attestorAuth.data.hostWhitelist,
    );
    for (const host of [
      "API.example",
      " api.example",
      "api.example ",
      "api_example",
      "api..example",
      "-api.example",
      "api-.example",
      "api.example.",
      "singlelabel",
      "api.localhost",
      "api.local",
      "api.internal",
      "127.0.0.1",
      "0x7f.1",
      `${"a".repeat(64)}.example`,
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.example`,
      "bücher.example",
    ]) {
      const request = fixture();
      request.umia.attestorAuth.data.hostWhitelist = [host];
      assert.throws(() => validate(request), /Invalid attestor authorization/, host);
    }
  });

  it("accepts only the explicitly activated exact caller/backend/attestor profile", () => {
    assert.deepEqual(validate(), fixture().umia);
    assert.equal(validateCaller(sender, approved.profile).profile, approved.profile);
    for (const url of [
      "https://admin.umia.localhost/auction/1",
      "https://hub.umia.localhost:8443/auction/1",
      "https://hub.umia.localhost.evil/auction/1",
      "https://hub.umia.localhost:444/auction/1",
      "http://hub.umia.localhost/auction/1",
      "https://user@hub.umia.localhost/auction/1",
      "https://hub.umia.localhost/%2e%2e/auction/1",
    ])
      assert.throws(() => validate(fixture(), { url, permissionsGranted: true }));
    for (const backendUrl of [
      "https://api.umia.localhost:8443/zktls",
      "https://api.umia.localhost/zktls-evil",
      "https://api.umia.localhost/zktls/",
      "https://admin.umia.localhost/zktls",
      "https://api.umia.localhost/zktls/../zktls",
      "https://api.umia.localhost/zktls?token=x",
      "https://api.umia.localhost/zktls#x",
      "https://user@api.umia.localhost/zktls",
    ]) {
      const request = fixture();
      request.umia.backendUrl = backendUrl;
      assert.throws(() => validate(request));
    }
    for (const attestorUrl of [
      `${approved.attestorUrl}-evil`,
      approved.attestorUrl.replace("/ws", "/ws-evil"),
      approved.attestorUrl.replace("/ws", ":444/ws"),
      approved.attestorUrl.replace("wss:", "ws:"),
      approved.attestorUrl.replace("/ws", "/%2e%2e/ws"),
    ]) {
      const request = fixture();
      request.umia.attestorUrl = attestorUrl;
      assert.throws(() => validate(request));
    }
  });

  it("authorizes an OAuth callback document by its exact origin after the page clears its query", async () => {
    for (const suffix of [
      "?privy_oauth_state=state&privy_oauth_provider=github&privy_oauth_code=code%2F%2B%3D",
      "#pass",
      "?next=https%3A%2F%2Fevil.example%2F#pass",
    ]) {
      // Chrome's sender.url retains the original document URL after history.replaceState.
      const from = { ...sender, url: `${approved.callerOrigin}/portfolio${suffix}` };
      assert.equal(validateCaller(from, approved.profile).callerOrigin, approved.callerOrigin);
      const session = await authorizeStart(fixture(), from, profiles, attestor());
      assert.equal(session.route.callerOrigin, approved.callerOrigin);
      assert.throws(() => validate(fixture(), { ...from, origin: "https://evil.example" }));
      await assert.rejects(
        authorizeStart(
          fixture(),
          { ...from, url: `https://evil.example/portfolio${suffix}` },
          profiles,
          attestor(),
        ),
      );
    }
  });

  it("normalizes only the effective default HTTPS port", () => {
    assert.equal(
      validateCaller({ url: "https://hub.umia.localhost:443/auction/1" }, "native-devnet")
        .callerOrigin,
      "https://hub.umia.localhost",
    );
    assert.equal(
      approvedBackendUrl("https://api.umia.localhost:443/zktls"),
      "https://api.umia.localhost/zktls",
    );
    assert.throws(
      () => approvedBackendUrl("https://api.umia.localhost:444/zktls"),
      /Unapproved backend/,
    );
  });

  it("accepts devnet Monad 10143 and rejects Base 84532 and a network the attestor does not sign", () => {
    assert.equal(validate().network.chainId, 10143);
    const base = fixture();
    base.umia.network.chainId = 84532;
    assert.throws(() => validate(base), /UNSUPPORTED_NETWORK/);
    for (const field of ["beaconAddress", "expectedEpoch", "authorityDigest"]) {
      const request = fixture();
      request.umia.network[field] = field === "expectedEpoch" ? 3 : "wrong";
      assert.throws(() => validate(request), /authority mismatch/);
    }
    const wrongEnvironment = fixture();
    wrongEnvironment.umia.network.environment = "testnet";
    assert.throws(() => validate(wrongEnvironment), /authority mismatch/);
  });

  it("starts each session on the caller's profile for its network and the shared attestor", async () => {
    const testnetProfile = { ...approved, profile: "native-testnet", environment: "testnet" };
    const start = (request, from = sender) =>
      authorizeStart(request, from, [approved, testnetProfile], attestor());
    const first = fixture();
    const firstBound = await start(first);
    assert.equal(firstBound.sessionId, "session-one");
    assert.deepEqual(Object.keys(firstBound.umia), CREDENTIAL_KEYS);
    assert.equal(firstBound.route.profile, approved.profile);
    assert.equal(firstBound.route.backendUrl, approved.backendUrl);
    assert.equal(firstBound.route.witness, witness);
    assert.equal(Object.isFrozen(firstBound.umia.attestorAuth.data.hostWhitelist), true);
    assert.equal(Object.isFrozen(firstBound.route.network), true);
    const second = fixture();
    second.sessionId = "session-two";
    second.umia.network.environment = "testnet";
    second.umia.network.chainId = 8453;
    second.umia.attestorAuth.data.id = "session-two";
    assert.equal((await start(second)).route.profile, testnetProfile.profile);
    const network = second.umia.network;
    for (const [changed, message] of [
      [{ backendUrl: `${approved.backendUrl}-evil` }, /not provisioned/],
      [{ network: { ...network, environment: "mainnet" } }, /not provisioned/],
      [{ attestorUrl: "wss://attestor.example/ws" }, /Unapproved attestor URL/],
      [{ witness: `0x${"f".repeat(40)}` }, /authority mismatch/],
      [{ network: { ...network, expectedEpoch: 3 } }, /authority mismatch/],
      [{ network: { ...network, extra: true } }, /Session network is required/],
    ]) {
      await assert.rejects(start({ ...second, umia: { ...second.umia, ...changed } }), message);
    }
    const admin = "https://admin.umia.localhost";
    await assert.rejects(
      start(first, { ...sender, url: `${admin}/auction/1`, origin: admin, permissionsGranted: true }),
      /Caller is not approved/,
    );
    await assert.rejects(start(first, { ...sender, frameId: 1 }), /top frame/);
    await assert.rejects(start(first, { ...sender, tab: undefined }), /top frame/);
    const originalChrome = globalThis.chrome;
    globalThis.chrome = { runtime: { id: "approved-extension" } };
    try {
      await assert.rejects(
        start(first, { ...sender, id: "other-extension" }),
        /Wrong extension sender/,
      );
      await start(first, { ...sender, id: "approved-extension" });
    } finally {
      globalThis.chrome = originalChrome;
    }
  });

  it("rejects at start a signed auth that outlives its session or predates the epoch", async () => {
    const request = fixture();
    request.umia.expiresAt = new Date(
      (request.umia.attestorAuth.data.expiresAt - 60) * 1000,
    ).toISOString();
    await assert.rejects(
      authorizeStart(request, sender, profiles, attestor()),
      /Invalid attestor authorization/,
    );
    const negative = fixture();
    negative.umia.attestorAuth.data.createdAt = -1;
    assert.throws(() => validate(negative), /Invalid attestor authorization/);
  });
});

function pinnedProvider() {
  return {
    id: "provider-one",
    recipeDigest: `sha256:${"a".repeat(64)}`,
    providerConfigs: [{ loginUrl: "https://provider.example/login" }],
  };
}

describe("backend and consumer transport", () => {
  it("returns the single login URL with the pinned provider", async () => {
    const original = globalThis.fetch;
    let served;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ providers: served }) });
    try {
      served = pinnedProvider();
      assert.deepEqual(await fetchProviderData("provider-one", bound()), {
        provider: served,
        loginUrl: "https://provider.example/login",
      });
      for (const change of [
        (p) => (p.id = "other-provider"),
        (p) => (p.recipeDigest = "invalid"),
        (p) => delete p.recipeDigest,
        (p) => (p.loginUrl = "https://provider.example/login"),
        (p) => (p.loginUrl = "https://other.example/login"),
      ]) {
        served = pinnedProvider();
        change(served);
        await assert.rejects(fetchProviderData("provider-one", bound()), /metadata rejected/);
      }
      for (const configs of [
        undefined,
        [],
        [
          { loginUrl: "https://provider.example/login" },
          { loginUrl: "https://provider.example/login" },
        ],
        [{}],
        [{ loginUrl: "" }],
        [{ loginUrl: "/login" }],
        [{ loginUrl: "http://provider.example/login" }],
        [{ loginUrl: "https://user@provider.example/login" }],
        [{ loginUrl: "https:provider.example/login" }],
        [{ loginUrl: "data:text/html,unsafe" }],
        [{ loginUrl: " https://provider.example/login" }],
        [{ loginUrl: "https://provider.example/login " }],
        [{ loginUrl: "https://provider.example\\@other.example/login" }],
      ]) {
        served = { ...pinnedProvider(), providerConfigs: configs };
        await assert.rejects(fetchProviderData("provider-one", bound()), /login URL unavailable/);
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects a response without a provider object", async () => {
    const original = globalThis.fetch;
    try {
      for (const body of [{}, null, { providers: null }, { providers: "provider-one" }]) {
        globalThis.fetch = async () => ({ ok: true, json: async () => body });
        await assert.rejects(fetchProviderData("provider-one", bound()), /metadata rejected/);
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("sends bearer only to pinned provider and status endpoints", async () => {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () =>
          url.endsWith("/api/sdk/update/session/")
            ? { status: "success" }
            : { providers: pinnedProvider() },
        text: async () => "ok",
      };
    };
    try {
      const { umia } = fixture();
      const session = bound({ umia });
      await fetchProviderData("provider-one", session);
      await updateSessionStatus(session, "PROOF_GENERATION_STARTED");
      assert.equal(calls[0].url, `${approved.backendUrl}/api/providers/provider-one`);
      assert.equal(calls[1].url, `${approved.backendUrl}/api/sdk/update/session/`);
      assert.equal(calls[0].options.headers.Authorization, `Bearer ${umia.sessionToken}`);
      assert.equal(calls[1].options.headers.Authorization, `Bearer ${umia.sessionToken}`);
      assert.equal(calls[0].options.redirect, "error");
      assert.equal(calls[1].options.redirect, "error");
      assert.deepEqual(JSON.parse(calls[1].options.body), {
        sessionId: "session-one",
        status: "PROOF_GENERATION_STARTED",
      });
      assert.equal(calls.length, 2);
      const forged = bound({
        sessionRoute: { ...route(), backendUrl: "https://api.umia.localhost.evil/zktls" },
      });
      await assert.rejects(
        fetchProviderData("provider-one", forged),
        /Unapproved backend destination/,
      );
      assert.equal(calls.length, 2);
      await assert.rejects(fetchProviderData("..", session), /Invalid backend path segment/);
      await assert.rejects(
        fetchProviderData("provider-one", bound({ sessionId: "other-session" })),
        /Bound session route mismatch/,
      );
      assert.equal(calls.length, 2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("posts telemetry only to the bound session route with its bearer", async () => {
    const original = globalThis.fetch;
    const calls = [];
    let status = 202;
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return { ok: status < 300, status };
    };
    try {
      const { umia } = fixture();
      const events = [{ type: "page_ready", data: { stage: "page", clientEnv: "extension" } }];
      await postTelemetry(bound({ umia }), events);
      assert.equal(calls[0].url, `${approved.backendUrl}/api/sdk/telemetry`);
      assert.equal(calls[0].options.method, "POST");
      assert.equal(calls[0].options.redirect, "error");
      assert.equal(calls[0].options.headers.Authorization, `Bearer ${umia.sessionToken}`);
      assert.deepEqual(JSON.parse(calls[0].options.body), { sessionId: "session-one", events });
      status = 200;
      await assert.rejects(postTelemetry(bound({ umia }), events), /Telemetry rejected/);
      await assert.rejects(
        postTelemetry(bound({ sessionId: "other-session" }), events),
        /Bound session route mismatch/,
      );
      assert.equal(calls.length, 2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects dynamic or malformed geo at fetch time, before any tab opens", async () => {
    const original = globalThis.fetch;
    let served;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ providers: served }) });
    try {
      served = { ...pinnedProvider(), geoLocation: "US" };
      assert.equal((await fetchProviderData("provider-one", bound())).provider.geoLocation, "US");
      for (const geoLocation of ["{{DYNAMIC_GEO}}", "USA", 1]) {
        served = { ...pinnedProvider(), geoLocation };
        await assert.rejects(fetchProviderData("provider-one", bound()), /CONFIG_REJECTED/);
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports an unreachable backend and an expired session by their own codes", async () => {
    const original = globalThis.fetch;
    const events = [{ type: "page_ready", data: { stage: "page", clientEnv: "extension" } }];
    try {
      for (const transport of [
        async () => {
          throw new TypeError("Failed to fetch");
        },
        async () => ({ ok: true, status: 202, json: async () => JSON.parse("<html>") }),
      ]) {
        globalThis.fetch = transport;
        for (const call of [
          () => fetchProviderData("provider-one", bound()),
          () => updateSessionStatus(bound(), "PROOF_GENERATION_STARTED"),
        ]) {
          const error = await call().then(
            () => null,
            (e) => e,
          );
          assert.equal(failureCode(error, "CONFIG_REJECTED"), "BACKEND_UNREACHABLE");
        }
      }
      globalThis.fetch = async () => {
        throw new TypeError("Failed to fetch");
      };
      await assert.rejects(postTelemetry(bound(), events), /BACKEND_UNREACHABLE/);

      const expired = { ...fixture().umia, expiresAt: "2000-01-01T00:00:00.000Z" };
      const error = await fetchProviderData("provider-one", bound({ umia: expired })).then(
        () => null,
        (e) => e,
      );
      assert.equal(failureCode(error, "CONFIG_REJECTED"), "SESSION_EXPIRED");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("records only the attestor selected for the session", () => {
    const proof = {
      claim: { identifier: "claim" },
      signatures: { attestorAddress: witness, claimSignature: { 0: 1 } },
    };
    assert.equal(formatProof(proof, {}, route()).witnesses[0].url, approved.attestorUrl);
    proof.signatures.attestorAddress = `0x${"e".repeat(40)}`;
    assert.throws(() => formatProof(proof, {}, route()), /witness/);
  });

  it("rejects expired credentials and foreign sessions at lifecycle use", () => {
    assert.equal(requireLiveSession(bound()).route.backendUrl, approved.backendUrl);
    const { umia } = fixture();
    assert.throws(
      () => requireLiveSession(bound({ umia: { ...umia, expiresAt: "2000-01-01T00:00:00.000Z" } })),
      /SESSION_EXPIRED/,
    );
    assert.throws(
      () => requireLiveSession(bound({ sessionId: "other-session" })),
      /route mismatch/,
    );
    assert.throws(() => requireLiveSession(null), /route mismatch/);
  });

  it("dates a bound session's end by its earliest credential expiry", () => {
    const session = bound();
    const authExpiry = session.umia.attestorAuth.data.expiresAt * 1000;
    assert.equal(
      boundSessionDeadline(session),
      Math.min(authExpiry, Date.parse(session.umia.expiresAt)),
    );
    const early = { ...session.umia, expiresAt: new Date(authExpiry - 1000).toISOString() };
    assert.equal(boundSessionDeadline(bound({ umia: early })), authExpiry - 1000);
  });
});
