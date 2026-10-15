import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256 } from "./artifact-files.js";
import { loadCanonicalProfiles } from "./canonical-profiles.js";

function inputFile(path) {
  const bytes = readFileSync(path);
  if (bytes.length === 0) throw new Error("empty activation or network config input");
  return {
    path: resolve(path),
    raw: bytes.toString("utf8"),
    size: bytes.length,
    sha256: sha256(bytes),
  };
}

export function activationInputFiles({ activationFile, networkConfigFiles }) {
  if (!activationFile || !Array.isArray(networkConfigFiles) || networkConfigFiles.length === 0) {
    throw new Error("explicit activation catalogue and at least one network config are required");
  }
  const activation = inputFile(activationFile);
  const configs = networkConfigFiles.map(inputFile);
  const paths = [activation.path, ...configs.map((config) => config.path)];
  if (new Set(paths).size !== paths.length) throw new Error("duplicate activation input path");
  return { activation, configs };
}

export function callerProfilesForBuild(profiles, activeNames) {
  const active = profiles.filter((profile) => activeNames.has(profile.profile));
  if (active.length !== activeNames.size || active.length === 0) {
    throw new Error("activation catalogue has no canonical profiles");
  }
  // Admit every canonical Hub origin in an activated environment. A devnet
  // build can answer native and hosted Hub probes without exposing testnet or
  // mainnet callers. Proof admission still uses the activation catalogue.
  const environments = new Set(active.map((profile) => profile.environment));
  return profiles.filter((profile) => environments.has(profile.environment));
}

export async function loadActivationBuildInput(repoRoot, files) {
  const { activation, configs } = activationInputFiles(files);
  const { profiles } = await loadCanonicalProfiles(repoRoot);
  const { loadTrustedNetworkConfig, loadTrustedActivationCatalogue } = await import(
    "@umia/zktls/network-config"
  );
  const now = new Date();
  const trustedConfigs = configs.map((config) => loadTrustedNetworkConfig(config.raw, now));
  const catalogue = loadTrustedActivationCatalogue(activation.raw, trustedConfigs, now);
  const activeNames = new Set(catalogue.records.map((record) => record.profile));
  const endpointProfiles = callerProfilesForBuild(profiles, activeNames);
  return {
    activationSources: {
      activationFile: activation.path,
      networkConfigFiles: configs.map((config) => config.path),
    },
    activationRaw: activation.raw,
    networkConfigRaws: configs.map((config) => config.raw),
    endpointProfiles,
    eligibleCallerOrigins: [...new Set(endpointProfiles.map((profile) => profile.callerOrigin))],
    profileSetSha256: sha256(JSON.stringify(endpointProfiles)),
    activationCatalogueSha256: activation.sha256,
    activationCatalogueSize: activation.size,
    networkConfigInputs: configs.map(({ size, sha256 }) => ({ size, sha256 })),
  };
}

export function assertSameActivationInput(staged, current) {
  for (const field of [
    "activationSources",
    "activationRaw",
    "networkConfigRaws",
    "endpointProfiles",
    "eligibleCallerOrigins",
    "profileSetSha256",
    "activationCatalogueSha256",
    "activationCatalogueSize",
    "networkConfigInputs",
  ]) {
    if (JSON.stringify(staged[field]) !== JSON.stringify(current[field])) {
      throw new Error(`staged ${field} differs from reviewed activation input`);
    }
  }
}
