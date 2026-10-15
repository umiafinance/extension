import { existsSync } from "node:fs";
import { join } from "node:path";

export async function loadCanonicalProfiles(repoRoot) {
  const modulePath = join(repoRoot, "shared/types/src/zktls-self-host.ts");
  if (!existsSync(modulePath))
    throw new Error("canonical endpoint profiles are absent from the foundation dependency");
  const { ZKTLS_EXTENSION_ORIGIN_ALLOWLIST, ZKTLS_DEVNET_CHAIN_ID } = await import(modulePath);
  if (
    !Array.isArray(ZKTLS_EXTENSION_ORIGIN_ALLOWLIST) ||
    ZKTLS_EXTENSION_ORIGIN_ALLOWLIST.length === 0 ||
    ZKTLS_EXTENSION_ORIGIN_ALLOWLIST.some((row) => Object.hasOwn(row, "enabled")) ||
    !Number.isSafeInteger(ZKTLS_DEVNET_CHAIN_ID)
  ) {
    throw new Error("canonical structural profiles and devnet chain are unavailable");
  }
  return {
    profiles: ZKTLS_EXTENSION_ORIGIN_ALLOWLIST,
    devnetChainId: ZKTLS_DEVNET_CHAIN_ID,
  };
}
