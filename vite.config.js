import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import {
  assertSameActivationInput,
  loadActivationBuildInput,
} from "./scripts/activation-build-input.js";
import { umiaDesignTheme } from "./scripts/design-theme.js";
import { manifestForProfiles } from "./scripts/profile-manifest.js";

const extensionRoot = dirname(fileURLToPath(import.meta.url));
const staged = JSON.parse(readFileSync(resolve(extensionRoot, ".staged-assets.json"), "utf8"));
assertSameActivationInput(
  staged,
  await loadActivationBuildInput(resolve(extensionRoot, "../.."), staged.activationSources),
);

export default defineConfig({
  plugins: [
    umiaDesignTheme(),
    {
      name: "umia-extension-profile-manifest",
      closeBundle() {
        const path = resolve(extensionRoot, "dist/manifest.json");
        const manifest = manifestForProfiles(
          JSON.parse(readFileSync(path, "utf8")),
          staged.endpointProfiles,
        );
        writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
      },
    },
  ],
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        extensionBackground: "src/extensionBackground.js",
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
        manualChunks: undefined,
      },
    },
    target: ["es2022", "chrome88"],
    modulePreload: false,
  },
  define: {
    global: "globalThis",
    __UMIA_EXTENSION_ACTIVATION_RAW__: JSON.stringify(staged.activationRaw),
    __UMIA_EXTENSION_NETWORK_CONFIG_RAWS__: JSON.stringify(staged.networkConfigRaws),
    __UMIA_EXTENSION_CALLERS__: JSON.stringify(staged.eligibleCallerOrigins),
    __UMIA_EXTENSION_ENDPOINT_PROFILES__: JSON.stringify(staged.endpointProfiles),
  },
  worker: {
    format: "es",
  },
});
