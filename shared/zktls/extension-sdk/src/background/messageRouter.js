// Message router for background script
// Handles chrome.runtime.onMessage and routes actions to modules

import { loggingHub } from "../utils/logger/LoggingHub";
import { EVENT_TYPES } from "../utils/logger/constants";
import { DEFAULT_INJECTION_TYPE } from "../utils/provider-normalization";
import * as sessionManager from "./sessionManager";
import { MESSAGE_ACTIONS } from "../utils/constants/interfaces";
import { authorizeStart, validateCaller } from "../utils/session-config";
import {
  publicProviderData,
  REPLAY_OP,
  runBoundRequestChain,
  runBoundReplay,
} from "./injectionManager";
import { failureCode } from "../utils/constants/interfaces";
import { isClaimSender, resolveClaimRequest } from "./claimRequest";

export function ownsBoundCancellation(ctx, sessionId, sender) {
  const binding = ctx.initiatingSender;
  if (
    !binding ||
    typeof sessionId !== "string" ||
    sessionId !== binding.sessionId ||
    ctx.activeSessionId !== sessionId ||
    sender?.tab?.id !== binding.tabId ||
    sender?.frameId !== 0 ||
    sender?.id !== binding.extensionId ||
    sender?.documentId !== binding.documentId
  ) {
    return false;
  }
  try {
    validateCaller(sender, binding.profile);
    return true;
  } catch {
    return false;
  }
}

// This extension's own pages (offscreen, popup); never a content script or a framed copy.
export function isExtensionPage(sender) {
  return sender?.id === chrome.runtime.id && !sender.tab;
}

function isSameStart(binding, sessionId, sender) {
  return (
    typeof sessionId === "string" &&
    sessionId.length > 0 &&
    binding?.sessionId === sessionId &&
    binding.tabId === sender?.tab?.id &&
    binding.extensionId === sender?.id &&
    binding.documentId === sender?.documentId &&
    sender?.frameId === 0
  );
}

// Relayed logs come from extension pages or the content script of a verification tab.
function isLogSender(ctx, sender) {
  if (isExtensionPage(sender)) return true;
  const tabId = sender?.tab?.id;
  return (
    sender?.id === chrome.runtime.id &&
    tabId !== undefined &&
    (ctx.managedTabs.has(tabId) || tabId === ctx.initiatingSender?.tabId)
  );
}

/**
 * Offscreen replies that have their own one-shot listener. They still pass
 * through this router, so the default case must recognise them instead of
 * reporting them as unsupported actions.
 */
const OFFSCREEN_REPLY_ACTIONS = new Set([
  MESSAGE_ACTIONS.GENERATE_PROOF,
  MESSAGE_ACTIONS.CLOSE_BOUND_SESSION,
  MESSAGE_ACTIONS.GET_PRIVATE_KEY_RESPONSE,
  MESSAGE_ACTIONS.GENERATE_PROOF_RESPONSE,
]);

export async function handleMessage(ctx, message, sender, sendResponse) {
  const { action, source, target, data } = message;

  try {
    // data.source labels the originating context, so a multi-context flow reads in one place.
    if (action === ctx.MESSAGE_ACTIONS.LOG_MESSAGE) {
      if (isLogSender(ctx, sender)) {
        ctx.loggingHub.handleRemoteLog(
          data?.message,
          data?.type,
          data?.level || "INFO",
          data?.source || source,
          data?.options,
        );
      }
      sendResponse({ success: true });
      return true;
    }

    if (action === ctx.MESSAGE_ACTIONS.UPDATE_LOG_CONFIG) {
      if (!isExtensionPage(sender) || !data?.config) {
        sendResponse({ success: false, error: "Action not supported" });
        return true;
      }
      ctx.loggingHub.setConfig(data.config);
      sendResponse({ success: true });
      return true;
    }

    switch (action) {
      case ctx.MESSAGE_ACTIONS.CONTENT_SCRIPT_LOADED:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          const isManaged = sender.tab?.id && ctx.managedTabs.has(sender.tab.id);
          chrome.tabs
            .sendMessage(sender.tab.id, {
              action: ctx.MESSAGE_ACTIONS.SHOULD_INITIALIZE,
              source: ctx.MESSAGE_SOURCES.BACKGROUND,
              target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
              data: {
                shouldInitialize: isManaged,
                injectionType: ctx.providerData?.injectionType || DEFAULT_INJECTION_TYPE,
              },
            })
            .catch((err) =>
              loggingHub.error(
                "[BACKGROUND] Error sending initialization status: " + err?.message,
                "background.message",
              ),
            );

          if (isManaged && ctx.initPopupMessage && ctx.initPopupMessage.has(sender.tab.id)) {
            const pendingMessage = ctx.initPopupMessage.get(sender.tab.id);
            // Content runs in every frame of a provider tab; the popup belongs only in the
            // top one, since a small provider iframe would be covered by it.
            chrome.tabs
              .sendMessage(sender.tab.id, pendingMessage.message, { frameId: 0 })
              .then(() => {
                if (chrome.runtime.lastError) {
                  loggingHub.error(
                    `[BACKGROUND] Error sending (pending) SHOW_PROVIDER_VERIFICATION_POPUP to tab ${sender.tab.id}: ${chrome.runtime.lastError.message}`,
                    "background.popup",
                  );
                }
              })
              .catch((error) =>
                loggingHub.error(
                  `[BACKGROUND] Error sending (pending) SHOW_PROVIDER_VERIFICATION_POPUP to tab ${sender.tab.id} (promise catch): ${error?.message}`,
                  "background.popup",
                ),
              );
          }

          if (isManaged && ctx.providerDataMessage && ctx.providerDataMessage.has(sender.tab.id)) {
            const pendingMessage = ctx.providerDataMessage.get(sender.tab.id);
            chrome.tabs
              .sendMessage(sender.tab.id, pendingMessage.message)
              .then(() => {
                if (chrome.runtime.lastError) {
                  loggingHub.error(
                    `[BACKGROUND] Error sending (pending) PROVIDER_DATA_READY to tab ${sender.tab.id}: ${chrome.runtime.lastError.message}`,
                    "background.provider",
                  );
                }
              })
              .catch((error) =>
                loggingHub.error(
                  `[BACKGROUND] Error sending (pending) PROVIDER_DATA_READY to tab ${sender.tab.id} (promise catch): ${error?.message}`,
                  "background.provider",
                ),
              );
            ctx.providerDataMessage.delete(sender.tab.id);
          }

          loggingHub.info(
            `[BACKGROUND] Successfully sent (pending) SHOW_PROVIDER_VERIFICATION_POPUP and PROVIDER_DATA_READY to tab ${sender.tab.id}`,
            "background.message",
          );
          sendResponse({ success: true });
          break;
        }
        break;
      case ctx.MESSAGE_ACTIONS.REQUEST_PROVIDER_DATA:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          loggingHub.info(
            "[BACKGROUND] Content script requested provider data",
            "background.provider",
          );

          if (
            sender.tab?.id &&
            ctx.managedTabs.has(sender.tab.id) &&
            ctx.providerData &&
            ctx.parameters &&
            ctx.sessionId
          ) {
            // Identifiers and shape only: a provider's requestData can be tens of kilobytes.
            loggingHub.info(
              "[BACKGROUND] Sending provider data to content script: " +
                `${ctx.providerData?.httpProviderId || ctx.providerId} ` +
                `(${ctx.providerData?.name || "unnamed"}), ` +
                `${ctx.providerData?.requestData?.length ?? 0} request(s)`,
              "background.provider",
            );
            if (sender.frameId === 0) ctx.reportTelemetry("page_ready");
            sendResponse({
              success: true,
              data: {
                providerData: publicProviderData(ctx),
                parameters: ctx.parameters || {},
                sessionId: ctx.sessionId,
                providerId: ctx.providerId,
                appId: ctx.appId,
              },
            });
          } else {
            loggingHub.error(
              "[BACKGROUND] Provider data not available or tab not managed",
              "background.provider",
            );
            sendResponse({
              success: false,
              error: "Provider data not available or tab not managed",
            });
          }
        }
        break;
      case ctx.MESSAGE_ACTIONS.CHECK_IF_MANAGED_TAB:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          const isManaged = sender.tab?.id && ctx.managedTabs.has(sender.tab.id);
          loggingHub.info(
            "[BACKGROUND] Checking if tab is managed: " + isManaged,
            "background.tab",
          );
          sendResponse({
            success: true,
            isManaged,
            injectionType: ctx.providerData?.injectionType || DEFAULT_INJECTION_TYPE,
          });
        }
        break;
      case ctx.MESSAGE_ACTIONS.START_VERIFICATION:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          // Reserve the start before route authorization awaits. The two relays
          // from one document can submit the same session in that window.
          if (
            isSameStart(ctx.pendingVerificationStart, data?.sessionId, sender) ||
            (ctx.activeSessionId === data?.sessionId &&
              isSameStart(ctx.initiatingSender, data?.sessionId, sender))
          ) {
            sendResponse({ success: true, alreadyStarted: true });
            break;
          }
          if (ctx.pendingVerificationStart || ctx.activeSessionId) {
            sendResponse({ success: false, error: "CONFIG_REJECTED" });
            // A rejected relay must never fail the session already owned by
            // another start. A distinct session still needs its own terminal
            // event so its SDK promise settles.
            if (
              sender.tab?.id &&
              data?.sessionId &&
              data.sessionId !== ctx.pendingVerificationStart?.sessionId &&
              data.sessionId !== ctx.activeSessionId
            ) {
              chrome.tabs
                .sendMessage(
                  sender.tab.id,
                  {
                    action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
                    source: ctx.MESSAGE_SOURCES.BACKGROUND,
                    target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
                    data: { error: "CONFIG_REJECTED", sessionId: data.sessionId },
                  },
                  {
                    frameId: sender.frameId,
                    ...(sender.documentId ? { documentId: sender.documentId } : {}),
                  },
                )
                .catch(() => {});
            }
            break;
          }
          let pendingStart;
          try {
            if (typeof sender?.documentId !== "string" || !sender.documentId) {
              throw new Error("Caller document identity is required");
            }
            pendingStart = Object.freeze({
              sessionId: data?.sessionId,
              tabId: sender.tab?.id,
              extensionId: sender.id,
              documentId: sender.documentId,
            });
            ctx.pendingVerificationStart = pendingStart;
            // Sender metadata, not an existing host permission, authorizes this relay.
            data.session = await authorizeStart(data, sender);
            delete data.umia;
          } catch (error) {
            const ownsPendingStart = pendingStart && ctx.pendingVerificationStart === pendingStart;
            if (ownsPendingStart) ctx.pendingVerificationStart = null;
            const rejectedCode = failureCode(error, "CONFIG_REJECTED");
            sendResponse({ success: false, error: rejectedCode });
            if (ownsPendingStart && sender.tab?.id) {
              chrome.tabs
                .sendMessage(
                  sender.tab.id,
                  {
                    action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
                    source: ctx.MESSAGE_SOURCES.BACKGROUND,
                    target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
                    data: { error: rejectedCode, sessionId: data?.sessionId },
                  },
                  {
                    frameId: sender.frameId,
                    ...(sender.documentId ? { documentId: sender.documentId } : {}),
                  },
                )
                .catch(() => {});
            }
            break;
          }
          loggingHub.info(
            "Starting new verification using Reclaim Extension SDK",
            "background.verification",
            { eventType: EVENT_TYPES.IS_RECLAIM_EXTENSION_SDK },
          );

          loggingHub.info("[BACKGROUND] Starting verification flow", "background.verification", {
            eventType: EVENT_TYPES.VERIFICATION_FLOW_STARTED,
          });
          const initiatingBinding = Object.freeze({
            sessionId: data.sessionId,
            tabId: sender.tab.id,
            extensionId: sender.id,
            documentId: sender.documentId,
            profile: data.session.route.profile,
          });
          ctx.activeSessionId = data.sessionId;
          ctx.initiatingSender = initiatingBinding;
          ctx.pendingVerificationStart = null;

          if (sender.tab && sender.tab.id) {
            ctx.originalTabId = sender.tab.id;
          }
          loggingHub.info(
            "[BACKGROUND] Starting verification with session id: " + data.sessionId,
            "background.verification",
          );

          try {
            const result = await sessionManager.startVerification(ctx, data);
            sendResponse({ success: true, result });
          } catch (startError) {
            loggingHub.error(
              "[BACKGROUND] startVerification failed: " + startError?.message,
              "background.verification",
            );
            const startCode = failureCode(startError, "CONFIG_REJECTED");
            sendResponse({ success: false, error: startCode });
            if (
              ctx.activeSessionId !== data.sessionId ||
              ctx.initiatingSender !== initiatingBinding
            ) {
              break;
            }
            // startVerification clears ctx.sessionId before it can throw,
            // so restore it from the original request data before calling
            // failSession — otherwise the terminal event carries sessionId:null
            // and the SDK ignores it.
            if (data.sessionId) {
              ctx.sessionId = data.sessionId;
            }
            // Send terminal failure event so the SDK Promise doesn't hang.
            // The content script does not fire VERIFICATION_FAILED from the
            // sendMessage callback, so we must dispatch it through failSession.
            await sessionManager.failSession(ctx, startCode);
          }
        } else {
          sendResponse({ success: false, error: "Action not supported" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.CANCEL_VERIFICATION:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          if (!ownsBoundCancellation(ctx, data?.sessionId, sender)) {
            sendResponse({ success: false, error: "CANCELLED" });
            break;
          }
          await sessionManager.cancelSession(ctx, data?.sessionId);
          sendResponse({ success: true });
        } else {
          loggingHub.error(
            "[BACKGROUND] CANCEL_VERIFICATION: Action not supported",
            "background.message",
          );
          sendResponse({ success: false, error: "Action not supported" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.OFFSCREEN_DOCUMENT_READY:
        if (source === ctx.MESSAGE_SOURCES.OFFSCREEN && target === ctx.MESSAGE_SOURCES.BACKGROUND) {
          loggingHub.info("[BACKGROUND] Offscreen document ready", "background.offscreen");
          sendResponse({ success: true });
        } else {
          loggingHub.error(
            "[BACKGROUND] OFFSCREEN_DOCUMENT_READY: Action not supported",
            "background.message",
          );
          sendResponse({ success: false, error: "Action not supported" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.CLOSE_CURRENT_TAB:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          if (sender.tab && sender.tab.id) {
            chrome.tabs.remove(sender.tab.id, () => {
              if (chrome.runtime.lastError) {
                loggingHub.error(
                  "[BACKGROUND] Error closing tab: " + chrome.runtime.lastError.message,
                  "background.tab",
                );
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
              } else {
                if (ctx.managedTabs.has(sender.tab.id)) {
                  ctx.managedTabs.delete(sender.tab.id);
                }
                loggingHub.info("[BACKGROUND] Tab closed", "background.tab");
                sendResponse({ success: true });
              }
            });
          } else {
            loggingHub.error(
              "[BACKGROUND] CLOSE_CURRENT_TAB: No tab ID provided by sender.",
              "background.tab",
            );
            sendResponse({ success: false, error: "No tab ID found to close." });
          }
        } else {
          sendResponse({ success: false, error: "Action not supported" });
        }
        return true;
      case ctx.MESSAGE_ACTIONS.FILTERED_REQUEST_FOUND: {
        const claim =
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND &&
          isClaimSender(ctx, sender)
            ? resolveClaimRequest(ctx, data)
            : null;
        if (!claim) {
          loggingHub.error(
            "[BACKGROUND] FILTERED_REQUEST_FOUND: request rejected",
            "background.message",
          );
          sendResponse({ success: false, error: "REQUEST_REJECTED" });
          break;
        }
        const { requestHash } = claim.criteria;
        ctx.responseMatchFailures?.delete(requestHash);
        if (ctx.filteredRequests.has(requestHash)) {
          loggingHub.info(
            "[BACKGROUND] Filtered request found with hash: " + requestHash,
            "background.filter",
          );
          sendResponse({ success: true, result: ctx.filteredRequests.get(requestHash) });
          break;
        }
        ctx.filteredRequests.set(requestHash, claim.request);
        const result = await ctx.processFilteredRequest(
          claim.request,
          claim.criteria,
          ctx.sessionId,
          ctx.providerLoginUrl,
        );
        // Un-memoize a retryable reject, otherwise the early-return above
        // would answer every later (possibly matching) response for this
        // hash from the cached miss.
        if (result?.retryable) {
          ctx.filteredRequests.delete(requestHash);
          sendResponse({ success: false, retryable: true, error: result.error });
          break;
        }
        loggingHub.info(
          "[BACKGROUND] Filtered request processed with hash: " + requestHash,
          "background.filter",
        );
        sendResponse({ success: true, result });
        break;
      }
      case ctx.MESSAGE_ACTIONS.RESPONSE_MATCH_RESULT: {
        const allowed =
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND &&
          isClaimSender(ctx, sender) &&
          !ctx.aborted &&
          typeof data?.sessionId === "string" &&
          data.sessionId.length > 0 &&
          data.sessionId === ctx.activeSessionId &&
          typeof data?.failed === "boolean" &&
          ctx.providerData?.requestData?.some((entry) => entry.requestHash === data?.requestHash);
        if (!allowed) {
          sendResponse({ success: false, error: "REQUEST_REJECTED" });
          break;
        }
        await sessionManager.recordResponseMatchResult(ctx, data.requestHash, data.failed);
        sendResponse({ success: true });
        break;
      }
      case ctx.MESSAGE_ACTIONS.GET_CURRENT_TAB_ID:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          loggingHub.info(
            "[BACKGROUND] Getting current tab id: " + sender.tab?.id,
            "background.tab",
          );
          sendResponse({ success: true, tabId: sender.tab?.id });
        } else {
          loggingHub.error(
            "[BACKGROUND] GET_CURRENT_TAB_ID: Action not supported",
            "background.message",
          );
          sendResponse({ success: false, error: "Action not supported" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.INJECT_VIA_SCRIPTING: {
        if (
          source !== ctx.MESSAGE_SOURCES.CONTENT_SCRIPT ||
          target !== ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          sendResponse({ success: false, error: "INJECTION_REJECTED" });
          break;
        }
        sendResponse(
          await (data?.op === REPLAY_OP ? runBoundReplay : runBoundRequestChain)(ctx, sender, data),
        );
        break;
      }
      default: {
        // The offscreen document's replies are consumed by the dedicated
        // one-shot listeners in claim-creator / proof-generator, but this router
        // sees every chrome.runtime message, so they reach the default case too.
        // They are answered by their own listener, so this neither logs them as
        // errors nor calls sendResponse.
        if (OFFSCREEN_REPLY_ACTIONS.has(action)) {
          break;
        }
        // Name the action: "Action not supported" with no action is not
        // diagnosable from the logs, which is the whole point of logging it.
        loggingHub.error(
          `[BACKGROUND] DEFAULT: Action not supported: ${action}`,
          "background.message",
        );
        sendResponse({ success: false, error: "Action not supported" });
      }
    }
  } catch (error) {
    loggingHub.error(
      "[BACKGROUND] Error handling " + action + ": " + error?.message,
      "background.message",
    );
    sendResponse({ success: false, error: error.message });
  }
  // Required for async response
  return true;
}
