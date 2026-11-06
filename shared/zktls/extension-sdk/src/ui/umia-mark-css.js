import { markCss, markSvg } from "./assets/umia-mark-css.generated.js";
import stateMachine from "./assets/umia-mark.state-machine.json";

// The Umia mark as SVG + CSS keyframes compiled from the same Lottie and state machine as umia-mark.js, for pages
// that shouldn't load the Lottie player. Same interpreter, but entering a state only sets `data-state`.
const STATES = new Map(stateMachine.states.map((state) => [state.name, state]));
const FIRES_ON_COMPLETE = new Set(
  stateMachine.interactions
    .filter((interaction) => interaction.type === "OnComplete")
    .map((interaction) => interaction.stateName),
);
const STYLE_ID = "umia-mark-css";
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function mountCssMark(container, mood = "idle") {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = markCss;
    document.head.append(style);
  }
  container.innerHTML = markSvg;
  const svg = container.firstElementChild;
  let inputMood = mood;
  let current = null;

  function enter(name) {
    current = STATES.get(name);
    svg.dataset.state = name;
    // Reduced motion holds a still pose, so the clock never ends; move on as the Lottie player does.
    if (reducedMotion() && FIRES_ON_COMPLETE.has(name)) next("entered");
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

  const onAnimationEnd = (event) => {
    if (event.animationName === `um-clock-${current.name}` && FIRES_ON_COMPLETE.has(current.name)) {
      next("entered");
    }
  };
  svg.addEventListener("animationend", onAnimationEnd);
  enter(stateMachine.initial);
  next();

  return {
    setMood(value) {
      inputMood = value;
      next();
    },
    get state() {
      return current?.name;
    },
    destroy() {
      svg.removeEventListener("animationend", onAnimationEnd);
      svg.remove();
    },
  };
}
