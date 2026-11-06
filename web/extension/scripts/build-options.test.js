import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChannel, parseBuildOptions } from "./build-options.js";

test("takes the staged asset root and an optional channel, defaulting to the store", () => {
  assert.deepEqual(parseBuildOptions(["--asset-dir", "/tmp/assets"]), {
    assetDir: "/tmp/assets",
    channel: "store",
  });
  assert.deepEqual(parseBuildOptions(["--channel", "dev", "--asset-dir", "/tmp/assets"]), {
    assetDir: "/tmp/assets",
    channel: "dev",
  });
});

test("missing, unknown and repeated build inputs fail closed", () => {
  for (const args of [
    [],
    ["--asset-dir"],
    ["--asset-dir", "--activation"],
    ["--activation", "/tmp/a"],
    ["--channel", "dev"],
    ["--asset-dir", "/tmp/assets", "--network-config", "/tmp/n"],
    ["--asset-dir", "/tmp/assets", "--asset-dir", "/tmp/other"],
  ]) {
    assert.throws(() => parseBuildOptions(args), /requires exactly --asset-dir/);
  }
  assert.throws(
    () => parseBuildOptions(["--asset-dir", "/tmp/a", "--channel", "testnet"]),
    /unknown extension channel/,
  );
  assert.throws(() => buildChannel("prod"), /unknown extension channel/);
});
