import { icons } from "./icons.js";
import { esc, mark } from "./view-utils.js";

// The in-page widget. Phases map onto the handlers in reclaim-provider-verification-popup.js:
//
//   waiting     mounted, no claim yet
//   proving     claim requested or proofs in progress, completed < total
//   submitting  every proof generated, before PROOF_SUBMITTED
//   complete    the proof was accepted; only the Umia page learns whether the account qualifies
//   failed      claim creation, proof generation or submission failed

export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export const FAILURES = {
  claim: {
    title: "Couldn't start the check",
    subtitle: "Nothing was shared",
    body: "Something went wrong before anything left your browser. Go back to Umia and try again.",
  },
  proof: {
    title: "Couldn't finish the check",
    subtitle: "No result was saved",
    body: "Something interrupted your proof. Go back to Umia and try again.",
  },
  criteria: {
    title: "Account doesn't qualify",
    subtitle: "Nothing was shared",
    body: "This account doesn't meet the auction's requirement. Taking you back to Umia, where you can try another account.",
  },
  submission: {
    title: "Couldn't save the result",
    subtitle: "No result was saved",
    body: "Your proof was made, but Umia couldn't save it. Go back to Umia and try again.",
  },
};

// `aside` is trusted markup built here, never page or session text.
const stage = (status, label, aside = "") => {
  const icon =
    status === "done"
      ? `<span class="umia-stage__done">${icons.checkSmall}</span>`
      : status === "active"
        ? icons.spinner
        : icons.pending;
  return `<div class="umia-stage" data-status="${status}">
    ${icon}<p class="umia-stage__label">${esc(label)}</p>${aside ? `<p class="umia-stage__aside">${aside}</p>` : ""}
  </div>`;
};

const rule = '<div class="umia-rule" role="presentation"></div>';

function stages(view, place, now) {
  const { completed = 0, total = 0 } = view.progress ?? {};
  const submitting = view.phase === "submitting";
  const count = total > 1 ? `${Math.min(completed, total)}/${total}` : "";
  const elapsed =
    view.startedAt && !submitting
      ? `<span aria-hidden="true" data-elapsed-since="${Number(view.startedAt)}">${formatElapsed(now - view.startedAt)}</span>`
      : "";
  return [
    stage("done", `Signed in to ${place}`),
    stage(
      submitting ? "done" : "active",
      "Checking your account",
      [count, elapsed].filter(Boolean).join(" · "),
    ),
    stage(submitting ? "active" : "pending", "Sending the result to Umia"),
  ].join(rule);
}

const header = (title, subtitle, mood) => `
  <header class="umia-widget__header" title="Drag to move">
    <div class="umia-widget__title">
      <p class="umia-widget__heading">${esc(title)}</p>
      <p class="umia-widget__sub">${esc(subtitle)}</p>
    </div>
    ${mood ? mark(mood, 32) : ""}
  </header>`;

const noteFooter = (text) => `
  <footer class="umia-widget__footer">
    ${icons.eyeOffSmall}<p>${esc(text)}</p>
  </footer>`;

const sessionFooter = (sessionId) => `
  <footer class="umia-widget__footer">
    <div class="umia-session">
      <p>Need help? Send support this ID</p>
      <p class="umia-session__id" data-session-id>${esc(sessionId)}</p>
    </div>
    <button type="button" class="umia-icon-button" data-copy-session aria-label="Copy session ID">
      ${icons.copy}
    </button>
  </footer>`;

export function renderWidget(view, now = Date.now()) {
  const place = view.provider?.label ?? view.site;
  let body;

  switch (view.phase) {
    case "waiting":
      body = `${header(`Sign in to ${place}`, "Step 1 of 3", "peek")}
        <div class="umia-widget__card" data-gap="16">
          <p class="umia-widget__lead">Sign in as usual. The check starts on its own once you're in.</p>
          <p class="umia-waiting"><span class="umia-waiting__dot"></span>Waiting for sign-in</p>
        </div>
        ${noteFooter("Umia can't see your password")}`;
      break;
    case "proving":
    case "submitting": {
      const subtitle =
        view.phase === "submitting"
          ? "Step 3 of 3 · Almost done"
          : view.slow
            ? "Step 2 of 3 · Taking longer than usual"
            : "Step 2 of 3 · Usually about a minute";
      body = `${header("Proving you qualify", subtitle, "focus")}
        <div class="umia-widget__card" data-gap="12">${stages(view, place, now)}</div>
        ${noteFooter(view.slow ? "Still working. Keep this tab open." : "Keep this tab open until it's done")}`;
      break;
    }
    case "complete":
      body = `${header("Sent to Umia", "Step 3 of 3")}
        <div class="umia-widget__card" data-gap="20">
          <div class="umia-celebration">${mark("happy", 68)}</div>
          <div class="umia-widget__result">
            <p class="umia-widget__display">Proof complete</p>
            <p class="umia-widget__muted">Taking you back to Umia for your result.</p>
          </div>
        </div>`;
      break;
    case "failed": {
      const failure = FAILURES[view.failure];
      body = `${header(failure.title, failure.subtitle, "oops")}
        <div class="umia-widget__card" data-gap="20">
          <p class="umia-widget__lead">${esc(failure.body)}</p>
          ${view.code ? `<p class="umia-widget__code">${esc(view.code)}</p>` : ""}
        </div>
        ${sessionFooter(view.sessionId)}`;
      break;
    }
    default:
      throw new Error(`unknown widget phase: ${view.phase}`);
  }

  return `<section class="umia-widget" data-phase="${view.phase}" aria-live="polite">${body}</section>`;
}
