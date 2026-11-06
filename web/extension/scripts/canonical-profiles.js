import { existsSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./artifact-files.js";
import { buildChannel } from "./build-options.js";

// The canonical Umia app origins the channel serves and the one attestor they all share.
export async function loadCanonicalTrust(repoRoot, channel = buildChannel()) {
  const modulePath = join(repoRoot, "shared/zktls/config/src/self-host.ts");
  if (!existsSync(modulePath))
    throw new Error("canonical endpoint profiles are absent from the foundation dependency");
  const { ZKTLS_EXTENSION_ORIGIN_ALLOWLIST: profiles, ZKTLS_SHARED_ATTESTOR: attestor } =
    await import(modulePath);
  if (
    !Array.isArray(profiles) ||
    profiles.length === 0 ||
    profiles.some((row) => Object.hasOwn(row, "enabled") || row.attestorUrl !== attestor?.url) ||
    !/^0x[0-9a-f]{40}$/.test(attestor.signerAddress ?? "") ||
    !Number.isInteger(attestor.claimEpoch) ||
    attestor.claimEpoch < 1
  ) {
    throw new Error("canonical profiles must all use the one shared attestor");
  }
  const served =
    channel === "store"
      ? profiles.filter((profile) => profile.environment === "mainnet")
      : profiles;
  if (served.length === 0) throw new Error(`no canonical profile for the ${channel} channel`);
  return {
    channel,
    endpointProfiles: served,
    eligibleCallerOrigins: [...new Set(served.map((profile) => profile.callerOrigin))],
    profileSetSha256: sha256(JSON.stringify(served)),
    attestor: { ...attestor },
  };
}
