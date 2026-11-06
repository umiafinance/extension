# Umia browser extension

Manifest V3 Chrome extension that generates zkTLS proofs for Umia auctions. The Umia app starts
a verification, the extension runs the provider's flow in the user's own browser session through
Umia's fork of Reclaim's browser extension SDK (`@umia/zktls-extension-sdk`, in
`shared/zktls/extension-sdk/`), and the proof goes back to the Umia app and API for off-chain
verification. It is published as **Umia** on the Chrome Web Store
(`ejcaahfcaaiblipldkfijdcbannidbdd`). Data handling is described in [`PRIVACY.md`](PRIVACY.md).

## Layout

| Path | What it is |
|---|---|
| `src/extensionBackground.js` | Service worker entry: starts the SDK background with the profiles this build serves and installs the site-access gate |
| `src/providerPermissionGate.js` | Site-access gate: runtime host grants, content-script registration, grant leases, and the control channel from the Umia app |
| `src/callerOrigin.js` | Exact-origin checks for messages from the Umia app |
| `grant.html`, `src/grant/` | The site-access window whose **Allow access** click supplies the user gesture `chrome.permissions.request` needs |
| `public/manifest.json` | Source manifest; the build fills in `externally_connectable` and `key` |
| `scripts/` | Build, packaging, release checks and release verification |
| `harness/` | Tests that run the SDK's session start checks against the canonical profiles |
| `release-baseline.json` | Reviewed permissions, host scopes, CSP and pinned SDK versions that every release must match |
| `store-key.json` | The store item's public key, so unpacked builds run under the published extension ID |

## Channels

`scripts/build-options.js` defines two channels, both built from the canonical profiles in
`shared/zktls/config/src/self-host.ts` (`ZKTLS_EXTENSION_ORIGIN_ALLOWLIST`):

- **`store`** (the default) serves only the production Umia app (`app.umia.finance`). This is
  what is published to the Chrome Web Store, and `scripts/package.js` refuses a store package
  that names any other profile.
- **`dev`** also serves the devnet, testnet and local Umia app origins, for loading unpacked.

Both channels use the one attestor all profiles share (`ZKTLS_SHARED_ATTESTOR`). The build writes
each profile's caller origin to `dist/manifest.json` and passes the profile names to the SDK
(`initializeBackground({ profiles })`), which refuses any other caller even if a user grants its
site by hand. Rotating the attestor key or claim epoch means updating `ZKTLS_SHARED_ATTESTOR` and
rebuilding.

Every build writes the public key from `store-key.json` into `dist/manifest.json` as `key`, so an
unpacked build runs as the store item's ID and the Umia app can reach it. The build refuses a key
that no longer yields the committed ID. An unpacked build and the store install therefore share
one ID: a browser can run only one of them at a time.

## Build

From the repository root, `./build.sh` installs the locked dependencies, downloads and checks the
circuit files listed in `infra/aws/src/asset-mirror/manifest.json`, and builds the store channel
into `web/extension/dist/`. The steps it runs:

```bash
bun install --frozen-lockfile
node infra/aws/src/asset-mirror/assets.mjs stage infra/aws/src/asset-mirror/manifest.json .assets
cd web/extension
bun run build --asset-dir ../../.assets --channel store   # or --channel dev
```

`bun run build` builds the SDK, copies the staged circuits and SDK bundles into place, runs Vite,
applies the store key and writes `dist/artifact-manifest.json`. It reads assets only from
`--asset-dir` and never downloads them; a missing or altered asset fails the build. The artifact
manifest records the source commit, the profile set and attestor, package versions, the
asset-manifest and SDK hashes, and every packaged file's size and SHA-256.

```bash
bun run package [out.zip]   # reproducible ZIP of dist/, only if it matches artifact-manifest.json
bun run release-check       # manifest and package versions, permissions and privacy notice vs. the baseline
bun run test                # unit tests and the SDK harness
```

To try a build, load `dist/` from `chrome://extensions` with **Load unpacked**. The ZIP also
carries the `key`, so it is for loading unpacked, not for a store upload.

## Permissions

The manifest declares no `host_permissions` and no static `content_scripts`, so installing shows
no "read and change your data" warning. Every host is an `optional_host_permissions` entry granted
at runtime, one site at a time. API `permissions` are `offscreen`, `cookies`, `scripting` and
`storage`, which the SDK needs; `scripting` also backs the dynamic content-script registration.

- **The Umia app and its API.** The user enables the extension once from the Umia app. The Umia
  app sends `umia:enable` over `externally_connectable`, the gate opens the site-access window,
  and on approval it registers the SDK relay for future loads and injects it into the open tab, so
  the verification continues without a reload. That grant may fold in the current provider's site
  (`extraOrigins`, exact hosts only) so the user approves both in one window.
- **Provider sites.** The wildcard `https://*/*` (plus `http://localhost/*`) is never requested
  itself. When the SDK opens a provider tab, the gate wraps `chrome.tabs.create`, requests that
  URL's exact host and the provider's request hosts, registers the content script, and only then
  opens the tab. Verifying on `developers.google.com` never grants `mail.google.com`. On denial the
  verification fails cleanly. A new provider needs no manifest change.
- **Provider access lasts one verification.** Each provider grant gets a lease in
  `chrome.storage.session`. When a session ends, the gate removes the provider grants made before
  it and keeps the Umia app and API grants. On worker start it removes provider grants with no
  lease or one older than 15 minutes (the attestor's auth window), since a restarted worker has
  lost any session in progress.

The content-script registration always mirrors exactly what is granted: it is reconciled on worker
start, `onStartup`, `onInstalled` and every `permissions.onAdded` / `onRemoved`.

### Control channel from the Umia app

Before the relay is granted, the Umia app cannot reach the extension through the page, so
`externally_connectable` (limited to the build's caller origins) carries three control messages:

- `umia:status`: whether the extension is installed and enabled for this origin and its API host,
  plus the installed `version`, which the Umia app checks against its minimum compatible release;
- `umia:enable`: opens the site-access window for the calling origin;
- `umia:theme`: the Umia app's `light`, `dark` or `system` choice, stored as `umiaTheme` for the
  extension's own windows.

The proof protocol itself only flows through the content-script relay.

`web_accessible_resources` lists only the network interceptor bundle, the provider-tab widget
stylesheet and its fonts. The offscreen document, its proof workers and circuits load only inside
the extension, so a page can neither frame nor fingerprint them.

## Releases

`release-baseline.json` is the reviewed surface of a release. `bun run release-check` and
`scripts/package.js` fail if the manifest and `package.json` versions differ, if the SDK or
attestor-core version leaves its pin, or if any permission, host scope, `externally_connectable`
entry, web-accessible resource or CSP differs from the baseline. A deliberate permission change
means editing the baseline in the same change.

Every store version is published as an immutable release of this repository with its ZIP,
`artifact-manifest.json` and `SHA256SUMS`. How to check an installed extension against a release
(`scripts/verify-install.js`) and how to rebuild one from source (`scripts/compare-artifacts.js`)
is described in the [top-level README](../../README.md).
