import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { computeAuthorityDigest, resolveActivatedSessionRoute } from "@umia/zktls/network-config";
import { zktlsEndpointProfile } from "../../../shared/types/src/zktls-self-host";
import { authorizeStart } from "../../../shared/zktls/extension-sdk/src/utils/session-config.js";
import { loadActivationBuildInput } from "../scripts/activation-build-input.js";
import { sha256 } from "../scripts/artifact-files.js";
import { createSessionRouteResolver } from "../src/sessionRoute.js";

const repoRoot = resolve(import.meta.dir, "../../..");
const callerOrigin = "https://hub.umia.conductor:8443";
const backendUrl = "https://api.umia.conductor:8443/zktls";
const attestorUrl = zktlsEndpointProfile("cloud-devnet").attestorUrl;
const beaconAddress = "0x2222222222222222222222222222222222222222";
const witness = "0x5555555555555555555555555555555555555555";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function reviewedInputs() {
  const root = mkdtempSync(join(tmpdir(), "umia-extension-real-loader-"));
  roots.push(root);
  const activationFile = join(root, "activation.json");
  const networkFile = join(root, "network.json");
  const testnetFile = join(root, "testnet.json");
  const now = Date.now();
  const authorityWithoutDigest = {
    environment: "devnet" as const,
    chainId: 10143,
    beaconAddress,
    epoch: 7,
    attestorUrl,
    witnesses: [witness],
    minimumWitnesses: 1,
    sourceBlockNumber: "123",
    sourceBlockHash: `0x${"b".repeat(64)}`,
    observedAt: new Date(now - 60_000).toISOString(),
    validUntil: new Date(now + 3_600_000).toISOString(),
  };
  const authority = {
    ...authorityWithoutDigest,
    digest: computeAuthorityDigest(authorityWithoutDigest),
  };
  const network = {
    version: 1,
    localAttestor: { url: attestorUrl, signerAddress: witness, claimEpoch: 7 },
    authorities: [authority],
  };
  const activation = { version: 1, records: [{ profile: "cloud-devnet", authority }] };
  writeFileSync(networkFile, JSON.stringify(network));
  const testnetWithoutDigest = {
    ...authorityWithoutDigest,
    environment: "testnet" as const,
    chainId: 84532,
    beaconAddress: "0x3333333333333333333333333333333333333333",
    epoch: 8,
    attestorUrl: "wss://attestor.zktls.umia.finance/ws",
    witnesses: ["0x6666666666666666666666666666666666666666"],
  };
  const testnetAuthority = {
    ...testnetWithoutDigest,
    digest: computeAuthorityDigest(testnetWithoutDigest),
  };
  writeFileSync(
    testnetFile,
    JSON.stringify({
      version: 1,
      localAttestor: {
        url: testnetAuthority.attestorUrl,
        signerAddress: testnetAuthority.witnesses[0],
        claimEpoch: testnetAuthority.epoch,
      },
      authorities: [testnetAuthority],
    }),
  );
  writeFileSync(activationFile, JSON.stringify(activation));
  return { root, activationFile, networkFile, testnetFile, authority, activation, now };
}

test("real build loader and runtime resolver select only the reviewed cloud route", async () => {
  const input = reviewedInputs();
  const loaded = await loadActivationBuildInput(repoRoot, {
    activationFile: input.activationFile,
    networkConfigFiles: [input.networkFile, input.testnetFile],
  });
  expect(loaded.endpointProfiles.map((profile) => profile.profile)).toContain("native-devnet");
  expect(loaded.eligibleCallerOrigins).toContain(callerOrigin);
  expect(loaded.eligibleCallerOrigins).toContain("https://hub.umia.localhost");
  const activationBytes = readFileSync(input.activationFile);
  const networkBytes = readFileSync(input.networkFile);
  const testnetBytes = readFileSync(input.testnetFile);
  expect(loaded.activationRaw).toBe(activationBytes.toString("utf8"));
  expect(loaded.activationCatalogueSize).toBe(activationBytes.length);
  expect(loaded.activationCatalogueSha256).toBe(sha256(activationBytes));
  expect(loaded.networkConfigRaws).toEqual([
    networkBytes.toString("utf8"),
    testnetBytes.toString("utf8"),
  ]);
  expect(loaded.networkConfigInputs).toEqual([
    { size: networkBytes.length, sha256: sha256(networkBytes) },
    { size: testnetBytes.length, sha256: sha256(testnetBytes) },
  ]);

  const { loadTrustedActivationCatalogue, loadTrustedNetworkConfig } = await import(
    "@umia/zktls/network-config"
  );
  const at = new Date(input.now);
  const catalogue = loadTrustedActivationCatalogue(
    loaded.activationRaw,
    loaded.networkConfigRaws.map((raw) => loadTrustedNetworkConfig(raw, at)),
    at,
  );
  expect(catalogue.records.map((record) => record.profile)).toEqual(["cloud-devnet"]);
  const resolveSessionRoute = createSessionRouteResolver({
    catalogue,
    resolveActivatedSessionRoute,
    now: () => input.now,
  });
  const candidate = {
    backendUrl,
    attestorUrl,
    witness,
    network: {
      environment: "devnet",
      chainId: 10143,
      beaconAddress,
      expectedEpoch: 7,
      authorityDigest: input.authority.digest,
    },
  };
  const sender = {
    origin: callerOrigin,
    url: `${callerOrigin}/sandbox/zktls-verify`,
    frameId: 0,
    tab: { id: 42 },
  };
  expect(await resolveSessionRoute({ sender, sessionId: "synthetic-session", candidate })).toEqual({
    profile: "cloud-devnet",
    authority: input.authority,
  });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const request = {
    sessionId: "synthetic-session",
    providerId: "synthetic-provider",
    providerVersion: "v7",
    resolvedProviderVersion: "v7",
    applicationId: "synthetic-app",
    signature: "synthetic-public-signature",
    timestamp: String(Date.now()),
    parameters: {},
    umia: {
      ...candidate,
      providerVersion: "v7",
      sessionToken: "a".repeat(64),
      attestorAuth: {
        data: {
          id: "synthetic-session",
          createdAt: nowSeconds,
          expiresAt: nowSeconds + 300,
          hostWhitelist: ["fixture.example"],
        },
        signature: `0x${"d".repeat(130)}`,
      },
      expiresAt: new Date((nowSeconds + 600) * 1000).toISOString(),
    },
  };
  const bound = await authorizeStart(resolveSessionRoute, request, sender);
  expect(bound.sessionId).toBe("synthetic-session");
  expect(bound.route.authority.digest).toBe(input.authority.digest);
  expect(bound.route.backendUrl).toBe(backendUrl);
  expect(Object.isFrozen(bound.route.authority)).toBe(true);
  expect(
    await resolveSessionRoute({
      sender: { ...sender, origin: "https://admin.umia.conductor:8443" },
      sessionId: "synthetic-session",
      candidate,
    }),
  ).toBeNull();
  expect(
    await resolveSessionRoute({
      sender,
      sessionId: "synthetic-session",
      candidate: { ...candidate, network: { ...candidate.network, chainId: 84532 } },
    }),
  ).toBeNull();
  await expect(
    authorizeStart(
      resolveSessionRoute,
      {
        ...request,
        umia: {
          ...request.umia,
          network: { ...candidate.network, chainId: 84532 },
        },
      },
      sender,
    ),
  ).rejects.toThrow(/not provisioned/);
});

test("real build loader rejects an activation that differs from reviewed network input", async () => {
  const input = reviewedInputs();
  writeFileSync(
    input.activationFile,
    JSON.stringify({
      ...input.activation,
      records: [
        {
          profile: "cloud-devnet",
          authority: { ...input.authority, sourceBlockNumber: "124" },
        },
      ],
    }),
  );
  await expect(
    loadActivationBuildInput(repoRoot, {
      activationFile: input.activationFile,
      networkConfigFiles: [input.networkFile, input.testnetFile],
    }),
  ).rejects.toThrow();
});
