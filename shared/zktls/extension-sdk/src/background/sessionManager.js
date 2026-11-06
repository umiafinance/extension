// Session management for background script
// Handles session start, fail, submit, and timer logic

import { loggingHub } from "../utils/logger/LoggingHub";
import { EVENT_TYPES } from "../utils/logger/constants";
import { normalizeInjectionType, withRequestKeys } from "../utils/provider-normalization";
import { TAB_TRANSITION_DELAY_MS } from "../utils/constants/config";
import { freezeBoundSession } from "../utils/session-transport";
import { boundSessionDeadline, requireLiveSession } from "../utils/session-config";
import { publicProviderData } from "./injectionManager";
import { failureCode } from "../utils/constants/interfaces";

function scheduleTabReturn(ctx, end, delayMs) {
  const tabs = chrome.tabs;
  const { sessionId, binding, callerTabId, providerTabId } = end;
  setTimeout(async () => {
    if (ctx.activeSessionId && ctx.activeSessionId !== sessionId) return;
    if (ctx.initiatingSender && ctx.initiatingSender !== binding) return;
    try {
      if (callerTabId) await tabs.update(callerTabId, { active: true });
      if (providerTabId) await tabs.remove(providerTabId);
    } catch {
      loggingHub.error("[BACKGROUND] Could not complete tab return", "background.tab");
    } finally {
      if (ctx.activeTabId === providerTabId) ctx.activeTabId = null;
      if (ctx.originalTabId === callerTabId) ctx.originalTabId = null;
    }
  }, delayMs);
}

// A session ends once: active -> ending -> ended. The path that claims the end (failure, cancel,
// expiry, tab close or proof submission) owns delivery and always delivers exactly one terminal
// outcome. A trigger that arrives meanwhile only records its code for the owner to report if its
// own outcome is a failure; it never touches the state the owner needs.
function claimSessionEnd(ctx, sessionId) {
  if (!sessionId || ctx.activeSessionId !== sessionId || ctx.sessionEnd?.sessionId === sessionId) {
    return null;
  }
  // Captured now: a tab close may clear these on ctx while the owner is still delivering.
  ctx.sessionEnd = {
    sessionId,
    reason: null,
    ended: false,
    session: ctx.session,
    binding: ctx.initiatingSender,
    callerTabId: ctx.originalTabId,
    providerTabId: ctx.activeTabId,
  };
  return ctx.sessionEnd;
}

function recordEndReason(ctx, sessionId, code) {
  const end = ctx.sessionEnd;
  if (end?.sessionId === sessionId && !end.ended && !end.reason) end.reason = code;
}

// Delivery to the initiating caller document only; see the START_VERIFICATION binding.
function sendToCaller(ctx, end, action, data) {
  if (!end.callerTabId) return Promise.resolve();
  const documentId = end.binding?.documentId;
  return chrome.tabs.sendMessage(
    end.callerTabId,
    {
      action,
      source: ctx.MESSAGE_SOURCES.BACKGROUND,
      target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
      data,
    },
    { frameId: 0, ...(documentId ? { documentId } : {}) },
  );
}

async function reportFailureStatus(ctx, end, code) {
  if (!end.session) return;
  try {
    // A cancellation keeps its own status; every other failure reports its code.
    if (code === "CANCELLED") {
      await ctx.updateSessionStatus(end.session, ctx.RECLAIM_SESSION_STATUS.SESSION_CANCELLED);
    } else {
      await ctx.updateSessionStatus(
        end.session,
        ctx.RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED,
        code,
      );
    }
  } catch (error) {
    loggingHub.error(
      `[BACKGROUND] Error updating session status to failed: ${error?.message}`,
      "background.session",
      { eventType: EVENT_TYPES.UPDATE_SESSION_STATUS_ERROR },
    );
  }
}

// The one delivery of a session's terminal outcome. A failure `code` sends the status update and
// the failure events; success has already been delivered by submitProofs.
async function finishSession(ctx, end, { code, action, requestHash, tabReturnMs, cancelled }) {
  try {
    ctx.sessionTimerManager.clearAllTimers();
    ctx.sessionTimerManager.clearExpiryTimer();
    // abort immediately to stop queue/offscreen processing
    ctx.aborted = true;
    await ctx.closeBoundSession?.(end.sessionId);

    if (code) {
      await reportFailureStatus(ctx, end, code);
      if (end.providerTabId) {
        chrome.tabs
          .sendMessage(end.providerTabId, {
            action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
            source: ctx.MESSAGE_SOURCES.BACKGROUND,
            target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
            data: { error: code, requestHash, sessionId: end.sessionId },
          })
          .catch(() => {});
      }
      await sendToCaller(ctx, end, action || ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED, {
        error: code,
        sessionId: end.sessionId,
      }).catch((error) => {
        loggingHub.error(
          `[BACKGROUND] Error notifying original tab of session end: ${error?.message}`,
          "background.session",
        );
      });
    }

    if (cancelled && !end.callerTabId && end.providerTabId) {
      await chrome.tabs.remove(end.providerTabId).catch(() => {});
    } else if (tabReturnMs !== undefined) {
      scheduleTabReturn(ctx, end, tabReturnMs);
    }
  } finally {
    end.ended = true;
    ctx.proofGenerationQueue = [];
    ctx.isProcessingQueue = false;
    if (ctx.activeSessionId === end.sessionId) {
      if (cancelled) {
        ctx.providerData = null;
        ctx.parameters = {};
        ctx.context = null;
        ctx.providerId = null;
        ctx.appId = null;
        ctx.sessionId = null;
        ctx.session = null;
        ctx.providerRequestsByHash = new Map();
        ctx.managedTabs.clear();
      }
      ctx.activeSessionId = null;
      ctx.initiatingSender = null;
      ctx.onSessionEnd?.();
    }
  }
}

// At the deadline every credential of the bound session has lapsed, so tear it down
// then instead of leaving the provider tab open until the next step fails.
export async function expireSession(ctx, session, sessionId) {
  if (ctx.session !== session) return;
  const end = claimSessionEnd(ctx, sessionId);
  if (!end) {
    recordEndReason(ctx, sessionId, "SESSION_EXPIRED");
    return;
  }
  await finishSession(ctx, end, { code: "SESSION_EXPIRED", tabReturnMs: TAB_TRANSITION_DELAY_MS });
}

export async function startVerification(ctx, templateData) {
  const startingBinding = ctx.initiatingSender;
  try {
    // clear all the member variables
    ctx.providerData = null;
    ctx.providerLoginUrl = null;
    ctx.parameters = {};
    ctx.context = null;
    ctx.providerId = null;
    ctx.appId = null;
    ctx.sessionId = templateData.sessionId;
    ctx.sessionEnd = null;
    ctx.session = null;
    ctx.generatedProofs = new Map();
    ctx.responseMatchFailures = new Set();
    ctx.filteredRequests = new Map();
    ctx.reportedExtractionFailures = new Set();
    ctx.initPopupMessage = new Map();
    ctx.providerDataMessage = new Map();
    ctx.injectionOperations = new Map();
    ctx.providerRequestsByHash = new Map();
    ctx.aborted = false;
    ctx.proofGenerationQueue = [];
    ctx.isProcessingQueue = false;
    ctx.processingSessionId = null;

    ctx.sessionTimerManager.clearAllTimers();
    ctx.sessionTimerManager.clearExpiryTimer();
    ctx.firstRequestReceived = false;

    if (!templateData.providerId) {
      throw new Error("Provider ID not found");
    }

    if (!templateData.session) {
      throw new Error("Bound session configuration is required");
    }
    ctx.session = freezeBoundSession(templateData.session);
    const boundSession = ctx.session;
    ctx.sessionTimerManager.startExpiryTimer(boundSessionDeadline(boundSession), () =>
      expireSession(ctx, boundSession, templateData.sessionId),
    );

    // fetch provider data from the backend
    loggingHub.info(
      `[BACKGROUND] Fetching provider data from the backend for provider Id ${templateData.providerId}`,
      "background.provider",
    );

    const { provider: fetchedProvider, loginUrl: providerUrl } = await ctx.fetchProviderData(
      templateData.providerId,
      ctx.session,
    );
    if (
      ctx.aborted ||
      ctx.activeSessionId !== templateData.sessionId ||
      ctx.initiatingSender !== startingBinding
    ) {
      throw new Error("CANCELLED");
    }

    const providerData = withRequestKeys(fetchedProvider);
    // Coerce injectionType before anything reads it. The router hands it to
    // the content script, which only distinguishes NONE from "inject the
    // interceptor" — an unsupported value (MSWJS/XHOOK/CDP) would otherwise
    // flow through unchecked.
    providerData.injectionType = normalizeInjectionType(providerData.injectionType, loggingHub);
    ctx.providerLoginUrl = providerUrl;
    ctx.providerData = providerData;

    loggingHub.info(
      `[BACKGROUND] Fetched provider data for ${templateData.providerId}: ` +
        `${providerData?.name || "unnamed"}, ${providerData?.requestData?.length ?? 0} request(s)`,
      "background.provider",
      { eventType: EVENT_TYPES.FETCHED_PROVIDERS },
    );

    ctx.providerId = templateData.providerId;
    if (templateData.parameters) {
      ctx.parameters = templateData.parameters;
    }

    // Store user-supplied context (contextAddress & contextMessage) for claim creation
    if (templateData.context) {
      try {
        ctx.context =
          typeof templateData.context === "string"
            ? JSON.parse(templateData.context)
            : templateData.context;
      } catch {
        ctx.context = null;
      }
    }

    if (templateData.sessionId) {
      ctx.sessionId = templateData.sessionId;
    }

    if (templateData.applicationId) {
      ctx.appId = templateData.applicationId;
    }

    // Create a new tab with provider URL DIRECTLY - not through an async flow
    if (
      ctx.aborted ||
      ctx.activeSessionId !== templateData.sessionId ||
      ctx.initiatingSender !== startingBinding
    ) {
      throw new Error("CANCELLED");
    }

    chrome.tabs.create({ url: providerUrl }, (tab) => {
      if (
        ctx.aborted ||
        ctx.activeSessionId !== templateData.sessionId ||
        ctx.initiatingSender !== startingBinding
      ) {
        if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
        return;
      }
      ctx.activeTabId = tab.id;
      loggingHub.info(
        `[BACKGROUND] New tab created for provider ${templateData.providerId} with tab id ${tab.id}`,
        "background.tab",
        { eventType: EVENT_TYPES.LOADING_INITIAL_URL },
      );

      ctx.managedTabs.add(tab.id);

      const sessionId = ctx.sessionId || "unknown";

      if (tab.id) {
        const popupMessage = {
          action: ctx.MESSAGE_ACTIONS.SHOW_PROVIDER_VERIFICATION_POPUP,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: {
            sessionId,
          },
        };

        const providerDataMessage = {
          action: ctx.MESSAGE_ACTIONS.PROVIDER_DATA_READY,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: {
            providerData: publicProviderData(ctx),
            parameters: ctx.parameters,
            sessionId: ctx.sessionId,
            providerId: ctx.providerId,
            appId: ctx.appId,
          },
        };

        if (!ctx.initPopupMessage) {
          ctx.initPopupMessage = new Map();
        }

        // Store the message in the init PopupMessage for the tab
        ctx.initPopupMessage.set(tab.id, { message: popupMessage });

        // Store the provider data in the providerDataMap for the tab
        ctx.providerDataMessage.set(tab.id, { message: providerDataMessage });
      } else {
        loggingHub.error(
          `[BACKGROUND] New tab does not have an ID, cannot queue message for popup.`,
          "background.tab",
        );
      }

      loggingHub.info(
        `[BACKGROUND] Starting verification with session id: ${ctx.sessionId}`,
        "background.verification",
        { eventType: EVENT_TYPES.USER_STARTED_VERIFICATION },
      );

      // Update session status after tab creation
      ctx
        .updateSessionStatus(ctx.session, ctx.RECLAIM_SESSION_STATUS.USER_STARTED_VERIFICATION)
        .catch((error) => {
          loggingHub.error(
            `[BACKGROUND] Error updating session status: ${error?.message}`,
            "background.session",
            { eventType: EVENT_TYPES.UPDATE_SESSION_STATUS_ERROR },
          );
        });
    });

    return {
      success: true,
      message: "Verification started, redirecting to provider login page",
    };
  } catch (error) {
    loggingHub.error(
      `[BACKGROUND] Error starting verification: ${error?.message}`,
      "background.verification",
      { eventType: EVENT_TYPES.RECLAIM_EXCEPTION },
    );
    // The router sends the terminal event and releases the guard. An older
    // start must never clear a replacement's state.
    throw error;
  }
}

export async function failSession(ctx, reason, requestHash, eventType) {
  const code = failureCode(reason);
  const sessionId = ctx.activeSessionId;
  const end = claimSessionEnd(ctx, sessionId);
  if (!end) {
    recordEndReason(ctx, sessionId, code);
    return;
  }
  loggingHub.info(`[BACKGROUND] Failing session: ${code}`, "background.session", {
    eventType: eventType || EVENT_TYPES.RECLAIM_EXCEPTION,
  });
  await finishSession(ctx, end, {
    code,
    requestHash,
    tabReturnMs: code === "CRITERIA_NOT_MET" ? TAB_TRANSITION_DELAY_MS : undefined,
  });
}

/** A response mismatch counts only while its signed recipe entry has no accepted proof. */
export function missingRequestCode(ctx) {
  const entries = ctx.providerData?.requestData;
  return Array.isArray(entries) &&
    entries.some(
      (entry) =>
        ctx.responseMatchFailures?.has(entry.requestHash) &&
        !ctx.generatedProofs?.has(entry.requestHash),
    )
    ? "CRITERIA_NOT_MET"
    : "REQUEST_NOT_CAPTURED";
}

/**
 * A conclusive miss ends the session now: the account is signed in and below the
 * threshold, so the session timer could only delay the same answer. A claim already
 * in flight for that entry keeps its chance; the miss stays recorded for the timer.
 */
export async function recordResponseMatchResult(ctx, requestHash, failed) {
  const failures = ctx.responseMatchFailures;
  if (!failed || ctx.generatedProofs.has(requestHash)) {
    failures.delete(requestHash);
    return;
  }
  failures.add(requestHash);
  if (ctx.filteredRequests?.has(requestHash)) return;
  await failSession(ctx, "CRITERIA_NOT_MET", requestHash, EVENT_TYPES.NO_RESPONSE_MATCH_WARNING);
}

function formatBoundProofs(ctx, route) {
  const requestData = ctx.providerData?.requestData;
  const formattedProofs = [];
  const templateHashes = new Set();
  for (const rd of Array.isArray(requestData) ? requestData : []) {
    if (ctx.generatedProofs.has(rd.requestHash)) {
      formattedProofs.push(ctx.formatProof(ctx.generatedProofs.get(rd.requestHash), rd, route));
      templateHashes.add(rd.requestHash);
    }
  }
  for (const [hash, proof] of ctx.generatedProofs.entries()) {
    if (templateHashes.has(hash)) continue;
    const providerRequest = ctx.providerRequestsByHash.get(hash) || {
      url: "",
      expectedPageUrl: "",
      urlType: "EXACT",
      method: "GET",
      responseMatches: [],
      responseRedactions: [],
      requestHash: hash,
    };
    formattedProofs.push(ctx.formatProof(proof, providerRequest, route));
  }
  return formattedProofs.map((fp) => ({ ...fp, publicData: ctx.publicData ?? null }));
}

export async function submitProofs(ctx) {
  const boundSession = ctx.session;
  const sessionId = ctx.sessionId;
  if (
    !boundSession ||
    ctx.aborted ||
    ctx.activeSessionId !== sessionId ||
    ctx.sessionEnd?.sessionId === sessionId
  ) {
    return;
  }

  ctx.sessionTimerManager.clearAllTimers();

  if (ctx.generatedProofs.size === 0) return;
  const requestData = ctx.providerData?.requestData;
  if (
    Array.isArray(requestData) &&
    requestData.some((rd) => !ctx.generatedProofs.has(rd.requestHash))
  ) {
    return;
  }

  // From here the submission's outcome is the session's one terminal event.
  const end = claimSessionEnd(ctx, sessionId);
  if (!end) return;
  try {
    requireLiveSession(boundSession);
    const finalProofs = formatBoundProofs(ctx, boundSession.route);
    // Proof contents stay out of local and remote diagnostics at every log level.
    loggingHub.info("[BACKGROUND] Submitting proofs", "background.proof", {
      eventType: EVENT_TYPES.SUBMITTING_PROOF,
    });
    // Bound proofs go only to the session's private intake, never to a page callback.
    const acceptedProofs = await ctx.submitBoundProofs(finalProofs, boundSession);
    if (end.binding?.sessionId !== sessionId || end.binding.tabId !== end.callerTabId) {
      throw new Error("CANCELLED");
    }
    const callerTab = await chrome.tabs.get(end.callerTabId);
    if (new URL(callerTab.url).origin !== boundSession.route.callerOrigin) {
      throw new Error("CANCELLED");
    }
    loggingHub.info(`[BACKGROUND] Proofs accepted (${acceptedProofs.length})`, "background.proof", {
      eventType: EVENT_TYPES.PROOF_SUBMITTED,
    });
    await sendToCaller(ctx, end, ctx.MESSAGE_ACTIONS.PROOF_SUBMITTED, {
      formattedProofs: acceptedProofs,
      submitted: true,
      sessionId,
    });
    // The widget shows its success state from a separate, data-free action: content relays a
    // PROOF_SUBMITTED payload to its page, and the provider page must never see the proofs.
    if (end.providerTabId) {
      chrome.tabs
        .sendMessage(
          end.providerTabId,
          {
            action: ctx.MESSAGE_ACTIONS.PROVIDER_TAB_VERIFIED,
            source: ctx.MESSAGE_SOURCES.BACKGROUND,
            target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
            data: {},
          },
          { frameId: 0 },
        )
        .catch(() => {});
    }
  } catch (error) {
    loggingHub.error("[BACKGROUND] Error submitting proof", "background.proof");
    // A trigger recorded meanwhile (tab closed, expiry, cancel) explains the failure better
    // than the intake error it caused.
    await finishSession(ctx, end, {
      code: end.reason || failureCode(error, "VERIFICATION_FAILED"),
      action: ctx.MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED,
    });
    throw error;
  }
  await finishSession(ctx, end, { tabReturnMs: TAB_TRANSITION_DELAY_MS });
  return { success: true };
}

export async function cancelSession(ctx, requestedSessionId) {
  const end = requestedSessionId === ctx.sessionId && claimSessionEnd(ctx, requestedSessionId);
  if (!end) {
    recordEndReason(ctx, requestedSessionId, "CANCELLED");
    throw new Error("CANCELLED");
  }
  loggingHub.info(`[BACKGROUND] Cancelling session`, "background.session", {
    eventType: EVENT_TYPES.RECLAIM_VERIFICATION_CANCELLED_EXCEPTION,
  });
  await finishSession(ctx, end, { code: "CANCELLED", tabReturnMs: 200, cancelled: true });
}

// A closed provider or caller tab ends the session, or records TAB_CLOSED for the path that
// already owns its end; nothing the owner needs is cleared while it is still delivering.
export async function handleTabRemoved(ctx, tabId) {
  ctx.managedTabs.delete(tabId);
  const lostActive = tabId === ctx.activeTabId;
  const lostCaller = tabId === ctx.originalTabId;
  const noManagedLeft = ctx.managedTabs.size === 0;
  if (lostActive) ctx.activeTabId = null;

  if (ctx.activeSessionId && (lostActive || lostCaller || noManagedLeft)) {
    loggingHub.error("[BACKGROUND] Verification tab closed by user", "background.tab", {
      eventType: EVENT_TYPES.RECLAIM_VERIFICATION_DISMISSED,
    });
    await failSession(ctx, "TAB_CLOSED");
  }

  if (noManagedLeft && !ctx.activeSessionId) {
    ctx.originalTabId = null;
    ctx.initiatingSender = null;
  }
}
