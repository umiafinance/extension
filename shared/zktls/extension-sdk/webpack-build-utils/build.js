// Do this as the first thing so that any code reading it knows the right env.
process.env.BABEL_ENV = "production";
process.env.NODE_ENV = "production";
process.env.ASSET_PATH = "/";

var webpack = require("webpack"),
  path = require("path"),
  fs = require("fs"),
  configs = require("../webpack.config");

// Hub needs only the public ESM entry, not the content/offscreen workers or MV2 bundles.
// Keep the same entry and compiler options so the SDK's runtime behavior stays identical.
const sdkOnly = process.argv.includes("--sdk-only");
const esmConfig = configs.find((config) => config.name === "background-esm-mv3");
const config = sdkOnly
  ? {
      ...esmConfig,
      name: "page-sdk",
      entry: { ReclaimExtensionSDK: esmConfig.entry.ReclaimExtensionSDK },
    }
  : configs;

console.log(`Building ${sdkOnly ? "page SDK" : "extension SDK"} for production...`);

fs.rmSync(path.resolve(__dirname, "../build"), { recursive: true, force: true });

webpack(config, function (err, stats) {
  if (stats) {
    console.log(
      stats.toString({ preset: "errors-warnings", timings: true, colors: !!process.stdout.isTTY }),
    );
  }
  if (err) throw err;
  if (stats?.hasErrors()) process.exitCode = 1;
});
