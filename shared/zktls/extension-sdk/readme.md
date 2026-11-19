# Reclaim Protocol Browser Extension SDK

Trigger Reclaim zero-knowledge proof verification from your browser extension or website.

> Chrome **Manifest V3**. MV2/Firefox bundles are also included.

> **Umia fork.** This package is Umia's patched copy of the Reclaim Protocol browser extension
> SDK (upstream: <https://github.com/reclaimprotocol/reclaim-browser-extension-sdk>, MIT; see
> `PATCHES.md`). It is the workspace package `@umia/zktls-extension-sdk`, built into the
> Umia extension in `web/extension` and imported by the Umia app. A verification always starts from a
> session the Umia API has already signed and bound to the user: no app secret ever reaches a
> browser, an extension or a page. The steps below describe how Umia uses it, not the upstream
> npm package.

## Install

It is not published to npm. Depend on it as a workspace package:

```json
{ "dependencies": { "@umia/zktls-extension-sdk": "workspace:*" } }
```

## 1. Copy the SDK assets

Umia's extension build copies the SDK bundles and verifies the ZK circuit assets against
the pinned manifest (`infra/aws/src/asset-mirror/manifest.json`). The extension build does both;
see [`web/extension/README.md`](../../../web/extension/README.md#build).
Upstream's `install-assets.js` downloader is removed because it did not verify circuit digests.

Staging checks the mirrored Stwo WASM against the installed ZK package, so an outdated prover
cannot be packaged. Rebuild and reload the extension after staging. The attestor's verifier must
support this Stwo proof format; proofs made in an older format must be regenerated.

The default proof engine is `stwo`, which the shared attestor (`ZKTLS_SHARED_ATTESTOR`) supports.
Published recipes leave the engine unset and use this default. Select `snarkjs` only for an
explicitly scoped sandbox.

Transcript chunk proofs run in up to four extension workers per claim; set
`ZK_WORKER_POOL_SIZE=0` at build time to use the stock in-thread prover. Workers stop when the
claim finishes or is cancelled, so switching engines never leaves a second pool running. A crashed
worker retries once in a new worker; a worker proof timeout fails the claim instead of rerunning
the proof on the offscreen thread. Uploading a multi-megabyte Stwo proof to the attestor can take
longer than proving it. Each Stwo proof blob is compressed when the browser supports
`CompressionStream` and the result is smaller, which the attestor must accept. WebSocket message
compression stays disabled.

## 2. Update your manifest

The Umia manifest is `web/extension/public/manifest.json`. It requests no install-time host
access: hosts are optional and granted at runtime, and the content script is registered
dynamically for granted sites only (`providerContentScript()` from
`@umia/zktls-extension-sdk/provider-access`), not declared statically.

```json
{
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self';"
  },
  "permissions": ["offscreen", "cookies", "scripting", "storage"],
  "optional_host_permissions": ["http://localhost/*", "https://*/*"],
  "web_accessible_resources": [
    {
      "resources": [
        "reclaim-browser-extension-sdk/interceptor/network-interceptor.bundle.js",
        "reclaim-browser-extension-sdk/content/components/reclaim-provider-verification-popup.css",
        "reclaim-browser-extension-sdk/fonts/Geist-Variable.woff2",
        "reclaim-browser-extension-sdk/fonts/GeistMono-Variable.woff2",
        "reclaim-browser-extension-sdk/fonts/Sora-Variable.woff2"
      ],
      "matches": ["http://localhost/*", "https://*/*"]
    }
  ]
}
```

All of it is required. `wasm-unsafe-eval` runs the ZK prover, `offscreen` hosts it, `cookies`
reads the provider's auth session, and `scripting` registers the content script and runs reviewed
provider scripts in the provider tab. Only the page-injected bundles, the widget stylesheet and its
fonts are web-accessible: the offscreen document, its workers and circuits load inside the
extension, and a page that could frame them would receive every proof request.

## 3. Initialize the background

```js
// service worker (background.js)
import { reclaimExtensionSDK } from "@umia/zktls-extension-sdk";

reclaimExtensionSDK.initializeBackground();
```

Umia's service worker (`web/extension/src/extensionBackground.js`) passes the returned context
to its provider permission gate.

## 4. Start a verification

The page never initializes a request itself. It asks the Umia API for a bound session config and
hands that config to the SDK; the API keeps the app secret and signs the session server-side.

```js
import { reclaimExtensionSDK } from "@umia/zktls-extension-sdk";

// An authenticated Umia API call; the API binds the session to the signed-in user and wallet.
const { config } = await api.post("/api/v1/hub/zktls/proof-request", {
  providerId,
  walletAddress,
  target,
});

const request = reclaimExtensionSDK.fromJsonString(config, {
  extensionID: "your-chrome-extension-id",
});

request.on("completed", (proofs) => console.log(proofs));
request.on("error", (err) => console.error(err));

await request.startVerification();
```

The config carries a `umia` block (session token, attestor auth, network pin) that the fork checks
before it opens the provider's site. Do not call `init(APP_ID, APP_SECRET, …)` from any client code:
that is the upstream hosted pattern, and the Umia flow never uses it.

## Troubleshooting

| Issue                                | Fix                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `Unexpected token 'export'`          | Register `content.bundle.js` as the content script, not an ESM file                                      |
| `must specify Extension ID`          | Pass `{ extensionID }` when starting from a web page                                                     |
| Provider tab never opens             | Check `initializeBackground()` ran and the user granted the Umia app and provider sites                  |
| Proof generation fails               | Rebuild the extension so the pinned circuits are staged under `browser-rpc/resources/`                   |
| Assets missing after a fresh install | Rebuild the extension; it restages and verifies the assets (`web/extension/README.md#build`)             |
