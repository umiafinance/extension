import { resolve } from "node:path";

export function parseBuildOptions(args) {
  const options = { networkConfigFiles: [] };
  const names = new Map([
    ["--asset-dir", "assetDir"],
    ["--activation", "activationFile"],
    ["--network-config", "networkConfigFiles"],
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const key = names.get(args[index]);
    const value = args[index + 1];
    if (!key || !value || value.startsWith("--")) {
      throw new Error(
        "build requires --asset-dir, --activation and repeated --network-config paths",
      );
    }
    if (key === "networkConfigFiles") options[key].push(resolve(value));
    else {
      if (options[key]) throw new Error(`duplicate ${args[index]} option`);
      options[key] = resolve(value);
    }
  }
  if (!options.assetDir || !options.activationFile || options.networkConfigFiles.length === 0) {
    throw new Error("build requires --asset-dir, --activation and at least one --network-config");
  }
  return options;
}
