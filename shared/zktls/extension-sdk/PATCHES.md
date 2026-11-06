# Extension SDK fork: baseline and patches

This directory is Reclaim Protocol's browser extension SDK plus Umia's self-host patch set,
published in the workspace as `@umia/zktls-extension-sdk`. `web/extension` builds its background,
content and offscreen bundles from it, and the Umia app loads its request API for bound sessions.

**Bound sessions only.** This fork serves only sessions the Umia API has signed and bound to a
user: `startVerification` refuses a request without the nested `umia` block, and no page-callback
or unbound submission path remains.

## Provenance and updating

- Upstream: <https://github.com/reclaimprotocol/reclaim-browser-extension-sdk>
- Release branch: `codex/release-0.5.2`; commit: `bba0264f640777b0202898d4270d8836507ecb6b`
  (upstream has not published a `v0.5.2` tag).
- Upstream package version: `0.5.2`; package metadata declares `MIT`. The release tree
  contains no standalone `LICENSE` file. Keep the upstream copyright notices and
  license metadata when updating.
- Attestor client: `@reclaimprotocol/attestor-core` **exactly `5.1.5`**.
- Imported as a squashed `git subtree` of upstream `v0.5.1`; the 0.5.2 release diff was applied
  by hand on top.

Upstream 0.5.2 downloads Stwo WASM and overrides it with the release package's copy. Umia removes
that unverified downloader and stages a digest-pinned mirror of the same
`@reclaimprotocol/zk-symmetric-crypto@5.1.7` WASM.

To pull a future upstream release:

```bash
git remote add reclaim-extension-upstream https://github.com/reclaimprotocol/reclaim-browser-extension-sdk.git
git fetch reclaim-extension-upstream --tags
git subtree pull --prefix shared/zktls/extension-sdk reclaim-extension-upstream vNEXT --squash
```

Resolve local patch conflicts using the file lists at the end of this document. Generated
`build/`, `dist/` and `zip/` are ignored. The upstream `package-lock.json` is not tracked; the
workspace `bun.lock` is the install lock.

### Build changes

`package.json` and `webpack-build-utils/build.js` differ from upstream only in build metadata:

- The workspace name, `private: true` and `author: "Umia"`; npm publishing metadata, unused
  scripts and unused dependencies are removed.
- `prebuild` is removed: it ran `prettier --write .`, which rewrote the imported source on every
  build. Do not run `prettier --write` on this directory.
- `parse5-htmlparser2-tree-adapter` is pinned to exactly `8.0.0`. `8.0.1` brings `domhandler@6`,
  while the vendored `patch-parse5-tree.js` patches `domhandler@5`, so XPath matching breaks.
- `ejs@3.1.10` is a direct dev dependency: the webpack config requires it, and an isolated Bun
  install does not hoist a transitive copy.
- The build exits nonzero when webpack stats contain errors; upstream returned success with
  missing bundles.

Webpack uses natural module and chunk IDs, and `webpack-build-utils/stable-import-meta-url.js`
replaces attestor-core's inlined absolute `import.meta.url` with a package-relative path, so two
checkouts of the same commit produce byte-identical builds.

## Reproducing a build

```bash
bun install --frozen-lockfile
bun --filter @umia/zktls-extension-sdk test
bun --filter @umia/zktls-extension-sdk build
bash scripts/zktls-sdk-domain-scan.sh --strict
```

`build` deletes `build/` before each run. To check reproducibility, build twice and compare the
sorted SHA-256 lists of the files in `build/`. The domain scan rejects missing runtime artifacts
and fails on any forbidden host.

### Artifact layout

The `package.json` exports resolve to `build/ReclaimExtensionSDK.bundle.js`,
`build/background/background.bundle.js`, `build/content/content.bundle.js`,
`build/offscreen/offscreen.bundle.js` and the bundles in `build/interceptor/`. The build also
contains `build/offscreen/offscreen.html`, `build/offscreen/load-s2circuits.js`, the proof workers
`build/offscreen/stwo-worker.js` and `build/offscreen/snarkjs-worker.js`, the widget stylesheet
(concatenated from `src/ui/`), `build/fonts/` (copied from `shared/design/fonts`) and
`build/browser-rpc/resources/snarkjs/snarkjs.min.js` (copied from `node_modules/snarkjs`).
Upstream's `build/scripts/install-assets.js` downloader is removed.
`web/extension/scripts/setup.js` copies the SDK build and stages the circuit objects and their
license from `infra/aws/src/asset-mirror/manifest.json`, verifying each size and SHA-256. SDK
bundles and `snarkjs.min.js` always come from the local build, never the mirror.

## Runtime patches

**Bound session routing.** `fromConfig` freezes the nested `umia` block and
`verificationTemplate` (`src/utils/session-transport.js`) carries it to the background.
`authorizeStart` (`src/utils/session-config.js`) checks the relayed `START_VERIFICATION` sender
(extension ID, top frame, tab, document, exact caller origin), selects the endpoint profile from
`ZKTLS_EXTENSION_ORIGIN_ALLOWLIST` by caller origin, backend and environment, and checks the
devnet chain, the shared attestor's signer and claim epoch (`ZKTLS_SHARED_ATTESTOR`), expiry, the
signed attestor auth (which must end before the session) and the pinned provider version, all
before fetching provider data or opening a tab. A rejected start reaches the caller only as
`CONFIG_REJECTED`, `SESSION_EXPIRED` or `UNSUPPORTED_NETWORK`. The background then carries one
frozen bound session `{ sessionId, umia, route }`: the route alone holds destinations and the
network, and `umia` keeps only the session credentials. Raw SDK init stays unbound.

**Backend calls.** `API_ENDPOINTS` take the backend from the bound route; no Reclaim or
build-time backend constant remains. `sessionHeaders` attaches the session bearer only to the
bound backend's provider, status, telemetry and proof-intake calls, and rejects redirects. Bound
proofs go only to `/session/:id/proof`, the accepted status is polled, and accepted proofs reach
only the initiating top-frame document. The upstream page-callback submission and the
popup/runtime proof broadcasts are removed, so the bearer never reaches a page.

**Attestor.** The claim's client URL and the reported witness come from the bound route, and
`formatProof` rejects a proof whose attestor address is not the route's witness. Offscreen
decodes the signed `attestorAuth` into the attestor's `authRequest` (`src/offscreen/session-attestor.js`)
and discards any page-supplied auth. `BoundAttestorSessions` opens a fresh client and socket per
session and auth identity, so each socket carries only its own session's auth, and closes it on
replacement, cancellation, completion, offscreen `pagehide` and the session deadline. Offscreen
drops late results after a close, and the background accepts a reply only for its own
`transportRequestId`, session and extension sender.

**Session lifecycle.** The background tears an idle expired session down at its deadline with
`SESSION_EXPIRED`, and the initiating document's `pagehide` cancels its session, since proofs can
be delivered only to that document. A session ends once (active, ending, ended): the trigger that
claims the end sends the one terminal outcome, and a later trigger only records its code.

**Finite errors.** `failureCode` (`src/utils/constants/interfaces.js`) maps any failure onto the
closed `ZKTLS_ERROR_CODES` enum, `UNKNOWN` otherwise, so no free text reaches the page, the
provider-tab popup or the backend. Attestor rejections map through
`ZKTLS_ATTESTOR_REJECTION_CODES`; a proof timeout or a socket that never opened is
`ATTESTOR_UNREACHABLE`.

**Telemetry.** The hosted `logs.reclaimprotocol.org` sink is removed and `LoggingHub` is
console-only. `src/background/telemetry.js` sends only fixed `page_ready`,
`permission_requested`, `permission_granted` and `request_captured` events to the bound route's
`/api/sdk/telemetry`, at most 20 per session per 5 seconds. Log config and relayed logs accept
only extension-internal senders, and no level prints a cookie, key or token.

**Provider permissions.** `providerContentScript()` (`src/background/providerAccess.js`,
exported as `@umia/zktls-extension-sdk/provider-access`) builds the dynamic content-script
registration with `allFrames: true`, and `providerRequestUrls` returns the recipe's request URLs
so the consumer can request those hosts before the provider tab opens. The router sends the
verification popup to `frameId: 0` only. The popup host renders the `src/ui` widget inside a
closed shadow root with an inline `z-index: 2147483647`, so it stays above host-page modals.

**No geo lookup.** `pinnedGeoLocation` accepts only a fixed two-letter code or none from the
pinned recipe and rejects `{{DYNAMIC_GEO}}` with `CONFIG_REJECTED`; upstream's IP lookups are
removed.

**No provider-authored code.** `src/interceptor/injection-scripts.js` (`window.Reclaim`), the
`customInjection` runner, the hosted loader and the `localStorage` code paths are removed, and
`fetchProviderData` refuses a provider carrying `customInjection`. The only page-world run is a
recipe's declarative `requestChain`: `src/background/injectionManager.js` checks the extension
sender, live bound session, managed tab, top frame, active document, login-URL origin and signed
hosts, then runs one fixed fetch function once per document.

**Bound document replay.** A server-rendered page loads before the page-world interceptor
exists, so a recipe whose request is the page itself would never match. `runBoundReplay` applies
the same sender, session, tab, document and origin checks, takes the URL from `chrome.tabs.get`,
and requires it to equal the sender's URL, be on a signed host and fully match a declared GET
with no sniffed body (query included, in order, nothing extra). It then sends one credentialed
same-origin XHR from the bound document, plus every other fixed-URL plain GET of the recipe on
that origin. Each (document, URL) pair replays at most once, with at most 3 replays per declared
GET per session. Only `disableRequestReplay: true` disables replay. Upstream's CSP-stripping
rule (`cspRuleManager.js`) is deleted, so strict-CSP pages fail closed.

**Claim requests.** A claim's criteria come from the pinned recipe entry its `requestHash`
names, never from the page. The request must match that entry, its host must be signed, and only
the live provider tab's top frame or a signed-host subframe may send it
(`src/background/claimRequest.js`). Page-reported `Cookie`, `Origin` and `Referer` headers are
dropped. The owner key is generated and returned only for this extension's own pages, and the
offscreen document and circuits are not web-accessible.

The production bundles contain no `reclaimprotocol.org` host. The extension accepts only the
shared attestor's signer and claim epoch; each session's chain, beacon and authority digest come
from the Umia API.

## Patch file inventory

Umia-owned files (no upstream counterpart; a subtree pull never touches them):
`src/utils/session-config.js`, `src/utils/session-transport.js`,
`src/utils/at-deadline.js`, `src/background/injectionManager.js`,
`src/background/telemetry.js`, `src/background/providerAccess.js`,
`src/background/claimRequest.js`, `src/offscreen/session-attestor.js`,
`src/content/criteria-result.js` (conclusive criteria misses), `src/offscreen/stwo-worker.js` and
`src/offscreen/snarkjs-worker.js` (proof workers), `src/utils/zk/` (the per-claim worker pool and
Stwo proof compression), each with its tests, `src/ui/` (the Umia widget kit), `tests/`,
`build-checks/`, `webpack-build-utils/stable-import-meta-url.js`, `tsconfig.webpack.json` and
this file.

Upstream files Umia rewrote; resolve a pull by keeping the Umia version and porting any
upstream fix by hand: `src/utils/fetch-calls.js`, `src/utils/constants/constants.js`,
`src/utils/claim-creator/get-dynamic-geo.js`,
`src/utils/logger/LoggingHub.js` (and its README and test),
`src/content/components/reclaim-provider-verification-popup.js`, and the module READMEs
`src/background/README.md`, `src/content/README.md` and `src/offscreen/README.md`.

Upstream files with Umia hooks (expect conflicts here): `src/background/sessionManager.js`,
`src/background/messageRouter.js`, `src/background/background.js`, `src/background/proofQueue.js`,
`src/offscreen/offscreen.js`, `src/content/content.js`, `src/ReclaimExtensionSDK.js`,
`src/utils/claim-creator/claim-creator.js`, `src/utils/claim-creator/network-filter.js`,
`src/utils/proof-generator/*`, `src/utils/provider-normalization.js`,
`src/utils/offscreen-manager.js`, `src/utils/session-timer.js`,
`src/utils/constants/{config,interfaces}.js`,
`src/utils/logger/{constants,redact,RemoteLogger,index}.js`, `src/types/index.d.ts`,
`package.json`, `webpack.config.js` and `webpack-build-utils/build.js`. Small comment, doc or
test edits: `readme.md`, `.prettierignore`, `src/interceptor/{log-bridge,network-interceptor}.js`,
`src/utils/claim-creator/{attestor-extraction.js,attestor-zk-engine.test.js,claim-shape.test.js,network-filter.test.js}`,
`src/utils/provider-normalization.test.js` and `src/utils/logger/redact.test.js`.

The upstream `examples/` directory is deleted: its demos used Reclaim's hosted app secret, so
they cannot run against bound sessions. A subtree pull that brings it back should delete it
again.
