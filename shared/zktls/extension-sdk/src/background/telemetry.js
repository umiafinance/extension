// Client observations the API accepts; lifecycle states stay server-owned.
// proof_started is absent: offscreen's PROOF_GENERATION_STARTED status update already records it.
const TELEMETRY_STAGES = new Map([
  ["page_ready", "page"],
  ["permission_requested", "permission"],
  ["permission_granted", "permission"],
  ["request_captured", "capture"],
]);
const TELEMETRY_WINDOW_MS = 5_000;
const TELEMETRY_WINDOW_EVENTS = 20;

// Only fixed tokens leave the extension, never page, request or error text.
export function reportTelemetry(ctx, type) {
  const stage = TELEMETRY_STAGES.get(type);
  const session = ctx.session;
  if (!stage || !session || ctx.aborted) return;

  const now = Date.now();
  const current = ctx.telemetryWindow;
  if (current?.session !== session || now - current.start >= TELEMETRY_WINDOW_MS) {
    ctx.telemetryWindow = { session, start: now, count: 0 };
  }
  if (ctx.telemetryWindow.count >= TELEMETRY_WINDOW_EVENTS) return;
  ctx.telemetryWindow.count += 1;

  ctx.postTelemetry(session, [{ type, data: { stage, clientEnv: "extension" } }]).catch(() => {});
}
