import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compileMarkCss } from "./umia-mark-css-compiler.js";

const asset = (file) => readFileSync(new URL(`./assets/${file}`, import.meta.url), "utf8");
const animation = JSON.parse(asset("umia-mark.json"));
const stateMachine = JSON.parse(asset("umia-mark.state-machine.json"));
const compiled = compileMarkCss(animation, stateMachine);

test("the mark compiles to an SVG with a transform group for every Lottie layer", () => {
  assert.match(compiled.svg, /^<svg class="um-root"/);
  assert.ok(compiled.svg.match(/<g class="um-\d+">/g).length > animation.layers.length);
});

test("every state has a clock and a reduced-motion pose", () => {
  for (const { name } of stateMachine.states) {
    assert.match(compiled.css, new RegExp(`@keyframes um-clock-${name}\\{`));
    assert.match(compiled.css, new RegExp(`\\.um-root\\[data-state="${name}"\\] \\*\\{animation-delay`));
  }
});

test("a one-shot state plays once and holds, a loop repeats", () => {
  const timing = (name) => compiled.css.match(new RegExp(`um-clock-${name} ([\\d.]+s linear [^,;}]+)`))[1];
  assert.equal(timing("peek-in"), "0.7s linear 1 both");
  assert.equal(timing("idle"), "4s linear infinite");
});
