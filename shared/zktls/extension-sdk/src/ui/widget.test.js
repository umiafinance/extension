import assert from "node:assert/strict";
import { test } from "node:test";
import { OTHER, providerForSite, providerForSites } from "./providers.js";
import { initialWidgetView, reduceWidget } from "./widget-state.js";
import { renderWidget } from "./widget-view.js";

const github = providerForSite("github.com");
const start = (overrides = {}) =>
  initialWidgetView({ provider: github, site: "github.com", sessionId: "s-1", ...overrides });
const fold = (events, view = start()) => events.reduce(reduceWidget, view);

test("a provider is found by its site or any subdomain, and unknown sites get the generic copy", () => {
  assert.equal(providerForSite("gist.github.com").id, "github");
  assert.equal(providerForSite("notgithub.com"), OTHER);
  assert.equal(providerForSite(undefined), OTHER);
});

test("session-wide progress decides when every proof is in and the result is being sent", () => {
  const halfway = fold([
    { type: "CLAIM_CREATION_REQUESTED", progress: { completed: 0, total: 2 } },
    { type: "PROOF_GENERATION_SUCCESS", progress: { completed: 1, total: 2 } },
  ]);
  assert.equal(halfway.phase, "proving");
  assert.match(renderWidget(halfway), /1\/2/);
  const sending = fold([{ type: "PROOF_GENERATION_SUCCESS", progress: { completed: 2, total: 2 } }], halfway);
  assert.equal(sending.phase, "submitting");
  assert.equal(fold([{ type: "PROOF_SUBMITTED" }], sending).phase, "complete");
});

test("without session counts the widget still advances from the messages it saw", () => {
  const view = fold([{ type: "CLAIM_CREATION_REQUESTED" }, { type: "PROOF_GENERATION_SUCCESS" }]);
  assert.deepEqual(view.progress, { completed: 1, total: 1 });
  assert.equal(view.phase, "submitting");
});

test("each failure message picks its own copy, and only an unmet rule reads as not qualifying", () => {
  const failure = (event) => fold([event]).failure;
  assert.equal(failure({ type: "CLAIM_CREATION_FAILED" }), "claim");
  assert.equal(failure({ type: "PROOF_GENERATION_FAILED", code: "CRITERIA_NOT_MET" }), "criteria");
  assert.equal(failure({ type: "PROOF_GENERATION_FAILED", code: "ATTESTOR_UNREACHABLE" }), "proof");
  const submission = fold([{ type: "PROOF_SUBMISSION_FAILED", code: "BACKEND_UNREACHABLE" }]);
  assert.equal(submission.failure, "submission");
  assert.match(renderWidget(submission), /BACKEND_UNREACHABLE/);
});

test("a finished widget ignores later messages", () => {
  const done = fold([{ type: "PROOF_SUBMITTED" }]);
  assert.equal(fold([{ type: "CLAIM_CREATION_FAILED" }], done), done);
});

test("text from the page and the session is escaped", () => {
  const html = renderWidget(
    fold([{ type: "CLAIM_CREATION_FAILED" }], start({ provider: OTHER, site: "<img src=x>", sessionId: '"><script>' })),
  );
  assert.doesNotMatch(html, /<img|<script/);
  const waiting = renderWidget(start({ provider: OTHER, site: "<b>x</b>" }));
  assert.match(waiting, /Sign in to &lt;b&gt;x&lt;\/b&gt;/);
});

test("proving shows the usual duration, ticks elapsed time, and says when it's taking longer", () => {
  const started = fold([{ type: "CLAIM_CREATION_REQUESTED", at: 1_000 }]);
  assert.equal(started.startedAt, 1_000);
  const html = renderWidget(started, 64_000);
  assert.match(html, /Usually about a minute/);
  assert.match(html, /data-elapsed-since="1000">1:03</);
  assert.equal(fold([{ type: "PROOF_GENERATION_STARTED", at: 9_000 }], started).startedAt, 1_000);

  const slow = fold([{ type: "PROVING_SLOW" }], started);
  assert.match(renderWidget(slow, 100_000), /Taking longer than usual/);
  assert.equal(fold([{ type: "PROVING_SLOW" }]).slow, undefined, "only proving can be slow");
});

test("a grant bundling the Umia hosts with one provider still gets that provider's copy", () => {
  assert.equal(
    providerForSites("hub.umia.localhost, api.umia.localhost, github.com").id,
    "github",
  );
  assert.equal(providerForSites("github.com, x.com"), OTHER, "two providers stay generic");
  assert.equal(providerForSites("hub.umia.localhost"), OTHER);
});

test("the ticking clock stays out of the live region's announcements", () => {
  const html = renderWidget(fold([{ type: "CLAIM_CREATION_REQUESTED", at: 1_000 }]), 5_000);
  assert.match(html, /<span aria-hidden="true" data-elapsed-since="1000">0:04<\/span>/);
});
