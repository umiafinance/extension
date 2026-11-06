# Background service worker

The background owns every verification session. `initBackground()` in `background.js` builds one
shared context object (`ctx`) holding session state and injected dependencies, binds the module
functions onto it, and registers the Chrome listeners. Every module here is a set of free
functions that take `ctx` first. This file maps the modules.

## Modules

| File                  | Role                                                                                                                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `background.js`       | Builds `ctx` (state, `fetchProviderData`, `updateSessionStatus`, `postTelemetry`, `submitBoundProofs`, `loggingHub`, …), binds `failSession`, `submitProofs`, `reportTelemetry` and friends, runs `processFilteredRequest` (cookies + `createClaimObject` + queue), and returns `ctx`. |
| `messageRouter.js`    | `handleMessage` checks each message's `source`/`target` and sender (managed tab, extension page, caller tab) before dispatching. `START_VERIFICATION` runs `authorizeStart` (`../utils/session-config.js`) on the relayed sender before anything else.                                |
| `sessionManager.js`   | `startVerification`, `failSession`, `cancelSession`, `expireSession`, `submitProofs`, `recordResponseMatchResult`, `missingRequestCode`, `handleTabRemoved`. A session ends once; the trigger that claims the end delivers the one terminal outcome.                                   |
| `claimRequest.js`     | `resolveClaimRequest` takes a claim's criteria from the pinned recipe entry its `requestHash` names, never from the page; `isClaimSender` accepts only the provider tab's top frame or a signed-host subframe.                                                                         |
| `injectionManager.js` | `runBoundRequestChain` runs a recipe's declarative `requestChain` fetches once per document in the MAIN world; `runBoundReplay` re-requests a declared GET document the interceptor missed, with the recipe's other fixed-URL GETs on its origin (at most 3 per session for each declared GET). |
| `proofQueue.js`       | Sequential proof queue. Pauses the session timer while proofs generate and drops work from a replaced or aborted session.                                                                                                                                                             |
| `cookieUtils.js`      | `getCookiesForUrl(url, loggingHub, topLevelUrl)` reads the cookies the request would send, across cookie stores.                                                                                                                                                                     |
| `telemetry.js`        | `reportTelemetry(ctx, type)` posts fixed `page_ready`, `permission_requested`, `permission_granted` and `request_captured` events to the bound backend, at most 20 per 5 s.                                                                                                             |
| `providerAccess.js`   | Exported as `@umia/zktls-extension-sdk/provider-access`: `providerContentScript()` builds the consumer's dynamic content-script registration, `providerRequestUrls()` lists the hosts a provider's recipe requests.                                                                    |
| `tabManager.js`       | `isManagedTab` / `removeManagedTab` over `ctx.managedTabs`.                                                                                                                                                                                                                            |
| `types.js`            | Placeholder; holds no definitions.                                                                                                                                                                                                                                                     |

## Messages it handles

From content scripts and extension pages, all in `../utils/constants/interfaces.js`
(`MESSAGE_ACTIONS`): `CONTENT_SCRIPT_LOADED`, `REQUEST_PROVIDER_DATA`, `CHECK_IF_MANAGED_TAB`,
`START_VERIFICATION`, `CANCEL_VERIFICATION`, `OFFSCREEN_DOCUMENT_READY`, `CLOSE_CURRENT_TAB`,
`FILTERED_REQUEST_FOUND`, `RESPONSE_MATCH_RESULT`, `GET_CURRENT_TAB_ID`, `INJECT_VIA_SCRIPTING`, plus the log relay (`LOG_MESSAGE`, `UPDATE_LOG_CONFIG`).

Adding a handler means adding its case in `messageRouter.js` and the matching sender guard;
unmanaged tabs must be rejected. Any path that ends a session goes through `failSession` with a
fixed `ZktlsErrorCode` (`failureCode`), never prose.
