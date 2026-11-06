import { resolve } from "node:path";

export const BUILD_CHANNELS = ["store", "dev"];

// `store` (the default) serves only the production Umia app; `dev` adds devnet, testnet and local.
export function parseBuildOptions(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (
      !["--asset-dir", "--channel"].includes(flag) ||
      values.has(flag) ||
      !value ||
      value.startsWith("--")
    ) {
      throw new Error(
        "build requires exactly --asset-dir <staged mirror root> [--channel store|dev]",
      );
    }
    values.set(flag, value);
  }
  if (!values.has("--asset-dir")) {
    throw new Error(
      "build requires exactly --asset-dir <staged mirror root> [--channel store|dev]",
    );
  }
  return {
    assetDir: resolve(values.get("--asset-dir")),
    channel: buildChannel(values.get("--channel") ?? "store"),
  };
}

export function buildChannel(value = process.env.UMIA_EXTENSION_CHANNEL ?? "store") {
  if (!BUILD_CHANNELS.includes(value)) throw new Error(`unknown extension channel: ${value}`);
  return value;
}
