import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBuildOptions } from "./build-options.js";

test("accepts explicit ordered network config inputs", () => {
  const options = parseBuildOptions([
    "--asset-dir",
    "/tmp/assets",
    "--activation",
    "/tmp/activation.json",
    "--network-config",
    "/tmp/devnet.json",
    "--network-config",
    "/tmp/testnet.json",
  ]);
  assert.deepEqual(options.networkConfigFiles, ["/tmp/devnet.json", "/tmp/testnet.json"]);
});

test("missing, unknown and duplicate build inputs fail closed", () => {
  for (const args of [
    [],
    ["--asset-dir", "/tmp/assets"],
    ["--asset-dir", "/tmp/assets", "--activation", "/tmp/a", "--network-config"],
    ["--asset-dir", "/tmp/assets", "--activation", "/tmp/a", "--bad", "/tmp/n"],
  ]) {
    assert.throws(() => parseBuildOptions(args), /requires/);
  }
  assert.throws(
    () =>
      parseBuildOptions([
        "--asset-dir",
        "/tmp/assets",
        "--asset-dir",
        "/tmp/other",
        "--activation",
        "/tmp/a",
        "--network-config",
        "/tmp/n",
      ]),
    /duplicate/,
  );
});
