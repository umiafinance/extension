import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { loadCanonicalTrust } from "./scripts/canonical-profiles.js";
import { manifestForProfiles } from "./scripts/profile-manifest.js";

const extensionRoot = dirname(fileURLToPath(import.meta.url));
const trust = await loadCanonicalTrust(resolve(extensionRoot, "../.."));

export default defineConfig({
  plugins: [
    {
      name: "umia-extension-profile-manifest",
      closeBundle() {
        const path = resolve(extensionRoot, "dist/manifest.json");
        const manifest = manifestForProfiles(
          JSON.parse(readFileSync(path, "utf8")),
          trust.endpointProfiles,
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
        grant: resolve(extensionRoot, "grant.html"),
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
    __UMIA_EXTENSION_CALLERS__: JSON.stringify(trust.eligibleCallerOrigins),
    __UMIA_EXTENSION_ENDPOINT_PROFILES__: JSON.stringify(trust.endpointProfiles),
  },
  worker: {
    format: "es",
  },
});
