// Folds the content script's popup messages into a widget view, one case per popup handler.

// Proving usually takes about a minute; past this the widget says it's taking longer.
export const SLOW_AFTER_MS = 90_000;

export function initialWidgetView({ provider, site, sessionId }) {
  return { phase: "waiting", provider, site, sessionId, progress: { completed: 0, total: 0 } };
}

const isTerminal = (view) => view.phase === "complete" || view.phase === "failed";

// The background sends session-wide counts; a message without them bumps the counter by one.
function progressAfter(view, event, bump) {
  if (event.progress && typeof event.progress.total === "number") {
    const { total, completed = 0 } = event.progress;
    return { total, completed: Math.min(completed, total) };
  }
  return { ...view.progress, [bump]: view.progress[bump] + 1 };
}

// `at` is when the message arrived; the first one starts the elapsed-time clock.
const proving = (view, event) => ({
  ...view,
  phase: "proving",
  startedAt: view.startedAt ?? event.at,
});

export function reduceWidget(view, event) {
  if (isTerminal(view)) return view;
  switch (event.type) {
    case "CLAIM_CREATION_REQUESTED":
      return {
        ...proving(view, event),
        progress: progressAfter(view, event, "total"),
      };
    case "CLAIM_CREATION_SUCCESS":
    case "PROOF_GENERATION_STARTED":
      return proving(view, event);
    case "PROOF_GENERATION_SUCCESS": {
      const progress = progressAfter(view, event, "completed");
      const allDone = progress.total > 0 && progress.completed >= progress.total;
      return { ...proving(view, event), phase: allDone ? "submitting" : "proving", progress };
    }
    case "PROVING_SLOW":
      return view.phase === "proving" ? { ...view, slow: true } : view;
    case "PROOF_SUBMITTED":
      return { ...view, phase: "complete" };
    case "CLAIM_CREATION_FAILED":
      return { ...view, phase: "failed", failure: "claim" };
    case "PROOF_GENERATION_FAILED":
      return {
        ...view,
        phase: "failed",
        failure: event.code === "CRITERIA_NOT_MET" ? "criteria" : "proof",
      };
    case "PROOF_SUBMISSION_FAILED":
      return { ...view, phase: "failed", failure: "submission", code: event.code };
    default:
      return view;
  }
}
