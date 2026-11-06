import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { authorizeStart } from "../../../shared/zktls/extension-sdk/src/utils/session-config.js";
import { loadCanonicalTrust } from "../scripts/canonical-profiles.js";

const repoRoot = resolve(import.meta.dir, "../../..");
const CHAIN_IDS = { devnet: 10143, testnet: 84532, mainnet: 8453 } as const;

type Trust = Awaited<ReturnType<typeof loadCanonicalTrust>>;
type Profile = Trust["endpointProfiles"][number];

function startRequest(profile: Profile, attestor: Trust["attestor"], sessionId: string) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    sessionId,
    providerId: "synthetic-provider",
    providerVersion: "v7",
    resolvedProviderVersion: "v7",
    applicationId: "synthetic-app",
    signature: "synthetic-public-signature",
    timestamp: String(Date.now()),
    parameters: {},
    umia: {
      backendUrl: profile.backendUrl,
      attestorUrl: attestor.url,
      witness: attestor.signerAddress,
      network: {
        environment: profile.environment,
        chainId: CHAIN_IDS[profile.environment],
        beaconAddress: "0x2222222222222222222222222222222222222222",
        expectedEpoch: attestor.claimEpoch,
        authorityDigest: `sha256:${"e".repeat(64)}`,
      },
      providerVersion: "v7",
      sessionToken: "a".repeat(64),
      attestorAuth: {
        data: {
          id: sessionId,
          createdAt: nowSeconds,
          expiresAt: nowSeconds + 300,
          hostWhitelist: ["fixture.example"],
        },
        signature: `0x${"d".repeat(130)}`,
      },
      expiresAt: new Date((nowSeconds + 600) * 1000).toISOString(),
    },
  };
}

function callerSender(profile: Profile) {
  return {
    origin: profile.callerOrigin,
    url: `${profile.callerOrigin}/sandbox/zktls-verify`,
    frameId: 0,
    tab: { id: 42 },
  };
}

test("the dev build starts sessions from every canonical Umia app on the shared attestor", async () => {
  const trust = await loadCanonicalTrust(repoRoot, "dev");
  expect(trust.eligibleCallerOrigins).toEqual(
    expect.arrayContaining([
      "https://hub.umia.localhost",
      "https://hub.umia.conductor:8443",
      "https://app.devnet.umia.finance",
      "https://app.umia.finance",
    ]),
  );
  for (const profile of trust.endpointProfiles) {
    const sessionId = `synthetic-${profile.profile}`;
    const bound = await authorizeStart(
      startRequest(profile, trust.attestor, sessionId),
      callerSender(profile),
    );
    expect(bound.route).toMatchObject({
      profile: profile.profile,
      backendUrl: profile.backendUrl,
      attestorUrl: trust.attestor.url,
      witness: trust.attestor.signerAddress,
      network: { environment: profile.environment, expectedEpoch: trust.attestor.claimEpoch },
    });
    expect(Object.isFrozen(bound.route.network)).toBe(true);
  }
});

test("a session naming another witness, epoch or devnet chain does not start", async () => {
  const trust = await loadCanonicalTrust(repoRoot, "dev");
  const profile = trust.endpointProfiles.find((row) => row.profile === "hosted-devnet")!;
  const request = startRequest(profile, trust.attestor, "synthetic-session");
  const start = (umia: Partial<typeof request.umia>) =>
    authorizeStart({ ...request, umia: { ...request.umia, ...umia } }, callerSender(profile));
  await expect(start({ witness: `0x${"6".repeat(40)}` })).rejects.toThrow(/authority mismatch/);
  await expect(
    start({ network: { ...request.umia.network, expectedEpoch: trust.attestor.claimEpoch + 1 } }),
  ).rejects.toThrow(/authority mismatch/);
  await expect(start({ network: { ...request.umia.network, chainId: 84532 } })).rejects.toThrow(
    "UNSUPPORTED_NETWORK",
  );
});
