import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { activationInputFiles, callerProfilesForBuild } from "./activation-build-input.js";

test("hosted activation keeps the native Hub reachable for status and enable", () => {
  const profiles = [
    {
      profile: "hosted-devnet",
      environment: "devnet",
      callerOrigin: "https://app.devnet.umia.finance",
    },
    { profile: "native-devnet", environment: "devnet", callerOrigin: "https://hub.umia.localhost" },
    { profile: "mainnet-future", environment: "mainnet", callerOrigin: "https://app.umia.finance" },
  ];
  assert.deepEqual(
    callerProfilesForBuild(profiles, new Set(["hosted-devnet"])),
    profiles.slice(0, 2),
  );
  assert.throws(() => callerProfilesForBuild(profiles, new Set(["missing"])), /canonical profiles/);
});

const temporary = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("attests exact bytes of each independent config and activation input", () => {
  const root = mkdtempSync(join(tmpdir(), "umia-extension-activation-"));
  temporary.push(root);
  const activationFile = join(root, "activation.json");
  const networkConfigFiles = [join(root, "devnet.json"), join(root, "testnet.json")];
  const contents = ['{"version":1}', '{"network":"devnet"}', '{"network":"testnet"}'];
  for (const [index, path] of [activationFile, ...networkConfigFiles].entries()) {
    writeFileSync(path, contents[index]);
  }
  const { activation, configs } = activationInputFiles({ activationFile, networkConfigFiles });
  assert.equal(activation.sha256, createHash("sha256").update(contents[0]).digest("hex"));
  assert.deepEqual(
    configs.map(({ sha256 }) => sha256),
    contents.slice(1).map((value) => createHash("sha256").update(value).digest("hex")),
  );
  writeFileSync(networkConfigFiles[1], `${contents[2]}\n`);
  const changed = activationInputFiles({ activationFile, networkConfigFiles });
  assert.notEqual(changed.configs[1].sha256, configs[1].sha256);
  assert.equal(changed.configs[0].sha256, configs[0].sha256);
});

test("rejects absent, empty and duplicate reviewed inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "umia-extension-activation-"));
  temporary.push(root);
  const activationFile = join(root, "activation.json");
  const configFile = join(root, "network.json");
  writeFileSync(activationFile, "{}");
  writeFileSync(configFile, "");
  assert.throws(
    () => activationInputFiles({ activationFile, networkConfigFiles: [configFile] }),
    /empty/,
  );
  writeFileSync(configFile, "{}");
  assert.throws(
    () => activationInputFiles({ activationFile, networkConfigFiles: [configFile, configFile] }),
    /duplicate/,
  );
  assert.throws(
    () => activationInputFiles({ activationFile, networkConfigFiles: [] }),
    /at least one/,
  );
});
