#!/usr/bin/env bash
# Build the store extension from this kit, the same way Umia builds the release.
# Needs Bun (the version in package.json "packageManager") and Node 22 or later.
set -euo pipefail
cd "$(dirname "$0")"
bun install --frozen-lockfile
node infra/aws/src/asset-mirror/assets.mjs stage infra/aws/src/asset-mirror/manifest.json .assets
(cd web/extension && bun run build --asset-dir ../../.assets --channel store)
echo "Built web/extension/dist. Compare it with a release:"
echo "  node web/extension/scripts/compare-artifacts.js web/extension/dist/artifact-manifest.json <release>/artifact-manifest.json"
