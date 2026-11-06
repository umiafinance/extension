import animationData from "./assets/umia-mark.json";
import stateMachine from "./assets/umia-mark.state-machine.json";

// lottie_light has no expression engine, so it never reaches eval and stays inside MV3's CSP.
// It cannot read .lottie state machines, so this interprets the exported one: each state plays
// a marker segment, String guards follow `mood`, and OnComplete fires the `entered` event.
// The player probes a canvas when evaluated, so it loads on first mount; "eager" keeps it inside
// the content bundle, which cannot fetch chunks from the provider page's origin.
let lottiePlayer;
const loadLottie = () =>
  (lottiePlayer ??= import(/* webpackMode: "eager" */ "lottie-web/build/player/lottie_light").then(
    (module) => module.default,
  ));

const SEGMENTS = new Map(animationData.markers.map((m) => [m.cm, [m.tm, m.tm + m.dr]]));
const STATES = new Map(stateMachine.states.map((state) => [state.name, state]));
const FIRES_ON_COMPLETE = new Set(
  stateMachine.interactions
    .filter((interaction) => interaction.type === "OnComplete")
    .map((interaction) => interaction.stateName),
);

export const MOODS = ["idle", "peek", "focus", "happy", "oops"];

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function mountMark(container, mood = "idle") {
  let anim = null;
  let current = null;
  let inputMood = mood;
  let destroyed = false;

  function enter(name) {
    current = STATES.get(name);
    const [start, end] = SEGMENTS.get(current.segment);
    if (reducedMotion()) {
      anim.resetSegments(true);
      anim.goToAndStop(current.loop ? start : end - 1, true);
      if (FIRES_ON_COMPLETE.has(current.name)) next("entered");
      return;
    }
    anim.loop = current.loop;
    anim.playSegments([start, end], true);
  }

  function next(event) {
    const transition = current.transitions.find((t) =>
      t.guards.every((guard) =>
        guard.type === "Event"
          ? guard.inputName === event
          : guard.inputName === "mood" && guard.compareTo === inputMood,
      ),
    );
    if (transition) enter(transition.toState);
  }

  loadLottie()
    .then((lottie) => {
    if (destroyed) return;
    anim = lottie.loadAnimation({
      container,
      renderer: "svg",
      loop: false,
      autoplay: false,
      animationData: structuredClone(animationData),
    });
    anim.addEventListener("complete", () => {
      if (FIRES_ON_COMPLETE.has(current.name)) next("entered");
    });
    anim.addEventListener("DOMLoaded", () => {
      enter(stateMachine.initial);
      next();
    });
  })
    // The mark is decoration; a player that can't load leaves the space empty.
    .catch((error) => console.warn("Umia mark animation unavailable:", error));

  function setMood(value) {
    inputMood = value;
    if (current) next();
  }

  return {
    setMood,
    get state() {
      return current?.name;
    },
    destroy: () => {
      destroyed = true;
      anim?.destroy();
    },
  };
}

/** Mounts a mark on every `.umia-mark` under `root`, or moves an existing one to its new mood. */
export function hydrateMarks(root) {
  for (const el of root.querySelectorAll(".umia-mark[data-mood]")) {
    if (el.umiaMark) el.umiaMark.setMood(el.dataset.mood);
    else el.umiaMark = mountMark(el, el.dataset.mood);
  }
}

// Re-rendering keeps each live mark element (matched by size), so its state machine transitions
// instead of restarting from idle.
export function renderPreservingMarks(container, html) {
  const sizeOf = (el) => el.style.getPropertyValue("--mark-size");
  const live = new Map([...container.querySelectorAll(".umia-mark")].map((el) => [sizeOf(el), el]));
  container.innerHTML = html;
  for (const placeholder of container.querySelectorAll(".umia-mark")) {
    const existing = live.get(sizeOf(placeholder));
    if (!existing) continue;
    existing.dataset.mood = placeholder.dataset.mood;
    placeholder.replaceWith(existing);
    live.delete(sizeOf(placeholder));
  }
  for (const el of live.values()) el.umiaMark?.destroy();
  hydrateMarks(container);
}
