import { installFonts } from "../../ui/fonts.js";
import { icons } from "../../ui/icons.js";
import { providerForSite } from "../../ui/providers.js";
import { followTheme } from "../../ui/theme.js";
import { renderPreservingMarks } from "../../ui/umia-mark.js";
import { initialWidgetView, reduceWidget, SLOW_AFTER_MS } from "../../ui/widget-state.js";
import { formatElapsed, renderWidget } from "../../ui/widget-view.js";

const SDK_PATH = "reclaim-browser-extension-sdk/";
const STYLESHEET = `${SDK_PATH}content/components/reclaim-provider-verification-popup.css`;
const EDGE_GAP_PX = 24;

/**
 * The Umia widget docked on the provider page. It lives in a closed shadow root so neither the
 * host page's styles nor its scripts reach it, and it is shown only once its stylesheet and the
 * saved theme are in.
 * Every handler folds one background message into the view through reduceWidget.
 */
export function createProviderVerificationPopup(sessionId) {
  const host = document.createElement("div");
  host.id = "reclaim-protocol-popup";
  // Inline `all: initial` outranks the page's selectors on the host element itself; the shadow
  // root shields everything inside it.
  host.style.cssText = `all:initial;position:fixed;right:${EDGE_GAP_PX}px;bottom:${EDGE_GAP_PX}px;visibility:hidden;`;
  // Host-page modal backdrops beat a stylesheet z-index; inline and important wins from the start.
  host.style.setProperty("z-index", "2147483647", "important");

  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  const container = document.createElement("div");
  container.className = "umia-theme";
  root.append(style, container);
  const theme = followTheme(container);

  installFonts(document, chrome.runtime.getURL(`${SDK_PATH}fonts/`));

  let view = initialWidgetView({
    provider: providerForSite(globalThis.location?.hostname),
    site: globalThis.location?.hostname,
    sessionId,
  });
  const render = () => renderPreservingMarks(container, renderWidget(view));
  let slowTimer = null;
  const dispatch = (event) => {
    const next = reduceWidget(view, { ...event, at: Date.now() });
    if (next === view) return;
    view = next;
    render();
    if (view.phase === "proving" && view.startedAt && !view.slow && !slowTimer) {
      slowTimer = setTimeout(
        () => dispatch({ type: "PROVING_SLOW" }),
        Math.max(0, view.startedAt + SLOW_AFTER_MS - Date.now()),
      );
    }
  };
  // Ticks the elapsed time in place; a full render each second would restart the spinner.
  const clock = setInterval(() => {
    const now = Date.now();
    for (const el of container.querySelectorAll("[data-elapsed-since]")) {
      el.textContent = formatElapsed(now - Number(el.dataset.elapsedSince));
    }
  }, 1000);

  const stylesheet = fetch(chrome.runtime.getURL(STYLESHEET)).then((response) => response.text());
  Promise.all([stylesheet, theme.ready])
    .then(([css]) => {
      style.textContent = css;
      render();
      host.style.visibility = "visible";
    })
    .catch((error) => console.error("Failed to load the Umia widget stylesheet:", error));

  container.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-copy-session]");
    if (button) copySessionId(button);
  });
  enableDragging(host, container);

  async function copySessionId(button) {
    try {
      await navigator.clipboard.writeText(view.sessionId);
      button.innerHTML = icons.check;
      setTimeout(() => {
        button.innerHTML = icons.copy;
      }, 1500);
    } catch (error) {
      console.error("Failed to copy the session ID:", error);
    }
  }

  return {
    element: host,
    dispose: () => {
      clearInterval(clock);
      clearTimeout(slowTimer);
      theme.dispose();
      for (const mark of container.querySelectorAll(".umia-mark")) mark.umiaMark?.destroy();
    },
    handleClaimCreationRequested: (_requestHash, progress) =>
      dispatch({ type: "CLAIM_CREATION_REQUESTED", progress }),
    handleClaimCreationSuccess: () => dispatch({ type: "CLAIM_CREATION_SUCCESS" }),
    handleClaimCreationFailed: () => dispatch({ type: "CLAIM_CREATION_FAILED" }),
    handleProofGenerationStarted: () => dispatch({ type: "PROOF_GENERATION_STARTED" }),
    handleProofGenerationSuccess: (_requestHash, progress) =>
      dispatch({ type: "PROOF_GENERATION_SUCCESS", progress }),
    handleProofGenerationFailed: (_requestHash, code) =>
      dispatch({ type: "PROOF_GENERATION_FAILED", code }),
    handleProofSubmitted: () => dispatch({ type: "PROOF_SUBMITTED" }),
    handleProofSubmissionFailed: (code) => dispatch({ type: "PROOF_SUBMISSION_FAILED", code }),
  };
}

// The header is the drag handle; the widget stays fully inside the viewport.
function enableDragging(host, container) {
  let offset = null;

  const move = (event) => {
    const x = Math.min(Math.max(0, event.clientX - offset.x), innerWidth - host.offsetWidth);
    const y = Math.min(Math.max(0, event.clientY - offset.y), innerHeight - host.offsetHeight);
    Object.assign(host.style, { left: `${x}px`, top: `${y}px`, right: "auto", bottom: "auto" });
  };
  const stop = () => {
    offset = null;
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", stop);
  };

  container.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || !event.target.closest?.(".umia-widget__header")) return;
    const rect = host.getBoundingClientRect();
    offset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    event.preventDefault();
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stop);
  });
}
