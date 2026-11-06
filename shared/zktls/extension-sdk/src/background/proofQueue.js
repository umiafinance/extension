import { failureCode } from "../utils/constants/interfaces";

export function addToProofGenerationQueue(ctx, claimData, requestHash) {
  if (claimData?.session?.sessionId !== ctx.activeSessionId || ctx.aborted) return;
  ctx.proofGenerationQueue.push({
    claimData,
    requestHash,
  });

  if (!ctx.isProcessingQueue) {
    ctx.sessionTimerManager.pauseSessionTimer();
    processNextQueueItem(ctx);
  }
}

export async function processNextQueueItem(ctx) {
  const { loggingHub, EVENT_TYPES } = ctx;
  const processingSessionId = ctx.activeSessionId;

  if (ctx.aborted) {
    loggingHub.info("[BACKGROUND] Proof generation queue aborted", "background.proofQueue", {
      eventType: EVENT_TYPES.CLAIM_CREATION_CANCELLED_EXCEPTION,
    });
    return;
  }

  if (ctx.isProcessingQueue) return;
  if (ctx.proofGenerationQueue.length === 0) {
    if (ctx.proofGenerationQueue.length === 0) {
      const templateCount = Array.isArray(ctx.providerData?.requestData)
        ? ctx.providerData.requestData.length
        : 0;

      if (templateCount > 0) {
        const completedTemplate = ctx.providerData.requestData.filter((rd) =>
          ctx.generatedProofs.has(rd.requestHash),
        ).length;

        if (completedTemplate === templateCount) {
          ctx.sessionTimerManager.clearAllTimers();
          setTimeout(() => {
            if (ctx.activeSessionId === processingSessionId) ctx.submitProofs();
          }, 0);
        } else {
          ctx.sessionTimerManager.resumeSessionTimer();
        }
      } else {
        // Manual mode: queue is empty → submit whatever we have
        ctx.sessionTimerManager.clearAllTimers();
        setTimeout(() => {
          if (ctx.activeSessionId === processingSessionId) ctx.submitProofs();
        }, 0);
      }
      return;
    }
    ctx.sessionTimerManager.resumeSessionTimer();
  }

  ctx.isProcessingQueue = true;
  ctx.processingSessionId = processingSessionId;

  const task = ctx.proofGenerationQueue.shift();
  if (task?.claimData?.session?.sessionId !== processingSessionId) {
    ctx.isProcessingQueue = false;
    ctx.processingSessionId = null;
    return;
  }

  try {
    if (ctx.aborted || ctx.activeSessionId !== processingSessionId) {
      loggingHub.info("[BACKGROUND] Proof generation aborted", "background.proofQueue", {
        eventType: EVENT_TYPES.CLAIM_CREATION_CANCELLED_EXCEPTION,
      });
      return;
    }

    chrome.tabs.sendMessage(ctx.activeTabId, {
      action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_STARTED,
      source: ctx.MESSAGE_SOURCES.BACKGROUND,
      target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
      data: { requestHash: task.requestHash },
    });

    loggingHub.info(
      "[BACKGROUND] Proof generation started for request hash: " + task.requestHash,
      "background.proofQueue",
      { eventType: EVENT_TYPES.PROOF_GENERATION_STARTED },
    );

    const proofResponseObject = await ctx.generateProof(
      {
        ...task.claimData,
        publicData: ctx.publicData ?? null,
      },
      loggingHub,
    );

    if (ctx.aborted || ctx.activeSessionId !== processingSessionId) {
      loggingHub.info("[BACKGROUND] Proof generation aborted", "background.proofQueue", {
        eventType: EVENT_TYPES.CLAIM_CREATION_CANCELLED_EXCEPTION,
      });
      return;
    }

    if (!proofResponseObject.success) {
      loggingHub.error(
        "[BACKGROUND] Proof generation failed for request hash: " +
          task.requestHash +
          ": " +
          proofResponseObject.error,
        "background.proofQueue",
        { eventType: EVENT_TYPES.PROOF_GENERATION_FAILED_EXCEPTION },
      );
      ctx.failSession(
        failureCode(proofResponseObject.error, "PROOF_GENERATION_FAILED"),
        task.requestHash,
      );
      return;
    }

    const proof = proofResponseObject.proof;

    if (proof) {
      if (!ctx.generatedProofs.has(task.requestHash)) {
        ctx.generatedProofs.set(task.requestHash, proof);
      }

      loggingHub.info(
        "[BACKGROUND] Proof generation successful for request hash: " + task.requestHash,
        "background.proofQueue",
        { eventType: EVENT_TYPES.PROOF_GENERATED },
      );

      chrome.tabs.sendMessage(ctx.activeTabId, {
        action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_SUCCESS,
        source: ctx.MESSAGE_SOURCES.BACKGROUND,
        target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
        // Sent after generatedProofs is updated above, so `completed` counts
        // this proof. The popup cannot derive it — see claimProgress().
        data: { requestHash: task.requestHash, progress: ctx.claimProgress?.() },
      });

      ctx.sessionTimerManager.resetSessionTimer();
    }
  } catch (error) {
    if (ctx.activeSessionId !== processingSessionId || ctx.aborted) return;
    // Not every rejection down this path is an Error, so read both shapes to keep a
    // plain `{success, error}` rejection legible.
    const reason = error?.message || error?.error || String(error);

    loggingHub.error(
      "[BACKGROUND] Proof generation failed for request hash: " + task.requestHash + ": " + reason,
      "background.proofQueue",
      { eventType: EVENT_TYPES.PROOF_GENERATION_FAILED_EXCEPTION },
    );

    ctx.failSession(failureCode(error, "PROOF_GENERATION_FAILED"), task.requestHash);
    return;
  } finally {
    if (ctx.processingSessionId !== processingSessionId) return;
    ctx.isProcessingQueue = false;
    ctx.processingSessionId = null;

    if (ctx.aborted || ctx.activeSessionId !== processingSessionId) return;

    if (ctx.proofGenerationQueue.length > 0) {
      // The timer this proof restarted must not run while an already-captured claim generates.
      ctx.sessionTimerManager.clearSessionTimer();
      processNextQueueItem(ctx);
    } else {
      const templateCount = Array.isArray(ctx.providerData?.requestData)
        ? ctx.providerData.requestData.length
        : 0;

      if (templateCount > 0) {
        const completedTemplate = ctx.providerData.requestData.filter((rd) =>
          ctx.generatedProofs.has(rd.requestHash),
        ).length;

        ctx.sessionTimerManager.clearAllTimers();
        if (completedTemplate === templateCount) {
          setTimeout(() => {
            if (ctx.activeSessionId === processingSessionId) ctx.submitProofs();
          }, 0);
        } else {
          ctx.sessionTimerManager.resumeSessionTimer();
        }
      } else {
        // Manual mode: queue is empty → submit whatever we have
        ctx.sessionTimerManager.clearAllTimers();
        setTimeout(() => {
          if (ctx.activeSessionId === processingSessionId) ctx.submitProofs();
        }, 0);
      }
    }
  }
}
