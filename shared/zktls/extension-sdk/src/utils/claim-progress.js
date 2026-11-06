/**
 * Session-wide claim progress for the in-page popup.
 *
 * The popup cannot count this itself. It lives in the content script, which is
 * destroyed and rebuilt at `document_start` on every navigation, and a
 * multi-request provider routinely spans several origins (the `example`
 * provider walks example.org -> example.com -> jsonplaceholder), so each page's
 * popup only sees the events that arrive after it is built.
 *
 * The background is the only context that survives those navigations, so it is
 * the only place these numbers are real. It sends them with
 * CLAIM_CREATION_REQUESTED and PROOF_GENERATION_SUCCESS.
 *
 * Its own module rather than a function in background.js so it is reachable
 * from `node --test`: background.js uses extensionless imports, which webpack
 * resolves and Node's ESM loader does not.
 *
 * @param {{generatedProofs?: Map<string, unknown>, providerData?: {requestData?: unknown[]}}} ctx
 * @returns {{completed: number, total: number}}
 */
export function claimProgress(ctx) {
  const completed = ctx?.generatedProofs?.size ?? 0;
  const declared = Array.isArray(ctx?.providerData?.requestData)
    ? ctx.providerData.requestData.length
    : 0;
  // `total` takes the larger of the two, so a counter never reads `4/3`.
  return { completed, total: Math.max(declared, completed) };
}
