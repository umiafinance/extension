import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "bun:test";

const driver = readFileSync(new URL("../webpack-build-utils/build.js", import.meta.url), "utf8");

function runBuild(args = [], { errors = false, fatalError = null } = {}) {
  const entry = { import: "src/ReclaimExtensionSDK.js", library: { type: "module" } };
  const configs = [
    { name: "extension-classic", entry: { content: "src/content/content.js" } },
    {
      name: "background-esm-mv3",
      entry: { ReclaimExtensionSDK: entry, background: "src/background/background.js" },
      output: { path: "/sdk/build", module: true },
    },
    { name: "background-commonjs-mv2", entry: { background: "src/background/background.js" } },
  ];
  const process = { argv: ["node", "build.js", ...args], env: {}, stdout: {} };
  let selected;
  let cleaned;
  vm.runInNewContext(driver, {
    __dirname: "/sdk/webpack-build-utils",
    process,
    console: { log() {} },
    require(name) {
      if (name === "path") return path;
      if (name === "fs") return { rmSync(dir) { cleaned = dir; } };
      if (name === "../webpack.config") return configs;
      if (name === "webpack") return (config, callback) => {
        selected = config;
        callback(fatalError, { toString: () => "", hasErrors: () => errors });
      };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return { selected, configs, process, cleaned };
}

test("default build retains all extension targets and cleans previous artifacts", () => {
  const { selected, configs, process, cleaned } = runBuild();
  assert.equal(selected, configs);
  assert.equal(cleaned, "/sdk/build");
  assert.equal(process.env.NODE_ENV, "production");
});

test("page build selects only the existing ESM SDK entry with the same output options", () => {
  const { selected, configs, cleaned } = runBuild(["--sdk-only"]);
  assert.deepEqual(Object.keys(selected.entry), ["ReclaimExtensionSDK"]);
  assert.equal(selected.entry.ReclaimExtensionSDK, configs[1].entry.ReclaimExtensionSDK);
  assert.equal(selected.output, configs[1].output);
  assert.equal(cleaned, "/sdk/build");
  assert.equal(Object.keys(configs[1].entry).length, 2);
});

test("both build modes fail when webpack reports compilation errors", () => {
  for (const args of [[], ["--sdk-only"]]) {
    assert.equal(runBuild(args, { errors: true }).process.exitCode, 1);
    const fatalError = new Error("compiler failed");
    assert.throws(() => runBuild(args, { fatalError }), (error) => error === fatalError);
  }
});
