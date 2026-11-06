// Compiles the Umia mark Lottie into static SVG plus CSS keyframes, one animation set per state-machine state,
// so a page can play the mark without a Lottie player. Covers what umia-mark.json uses: shape and null layers,
// parenting, split position, groups, paths (incl. morphs), rects, ellipses, fills, strokes, hold and bezier
// keyframes, and layer in/out points. The output is not committed; `bun run build:mark-css` regenerates it.

const r3 = (n) => +(+n).toFixed(3);
const first = (v) => (Array.isArray(v) ? v[0] : v);
const clamp01 = (n) => Math.min(1, Math.max(0, n));
const staticValue = (prop) => (prop.a ? prop.k[0].s : prop.k);

const pathD = ({ v, i, o, c }) => {
  if (!v.length) return "";
  const pt = (p) => `${r3(p[0])} ${r3(p[1])}`;
  const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
  let d = `M${pt(v[0])}`;
  const segments = c ? v.length : v.length - 1;
  for (let k = 0; k < segments; k++) {
    const next = (k + 1) % v.length;
    d += `C${pt(add(v[k], o[k]))} ${pt(add(v[next], i[next]))} ${pt(v[next])}`;
  }
  return c ? `${d}Z` : d;
};
const shapePath = (value) => pathD(Array.isArray(value) ? value[0] : value);
const rgb = ([r, g, b]) => `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;

const DECLARATION = {
  translate: (s) => `translate: ${r3(s[0])}px ${r3(s[1])}px`,
  tx: (s) => `translate: ${r3(first(s))}px 0px`,
  ty: (s) => `translate: 0px ${r3(first(s))}px`,
  rotate: (s) => `rotate: ${r3(first(s))}deg`,
  scale: (s) => `scale: ${r3(s[0] / 100)} ${r3(s[1] / 100)}`,
  opacity: (s) => `opacity: ${r3(first(s) / 100)}`,
  d: (s) => `d: path("${shapePath(s)}")`,
};

// The export keeps every segment boundary on a keyframe or inside a constant/hold run, so a segment never
// starts mid-curve and no bezier has to be split.
function valueAt(keys, t) {
  return (keys.findLast((k) => k.t <= t) ?? keys[0]).s;
}
function easingAt(keys, t) {
  const key = keys.findLast((k) => k.t <= t);
  if (!key || key === keys.at(-1)) return "linear";
  if (key.h) return "step-end";
  const bezier = [first(key.o.x), first(key.o.y), first(key.i.x), first(key.i.y)];
  return `cubic-bezier(${r3(clamp01(bezier[0]))},${r3(bezier[1])},${r3(clamp01(bezier[2]))},${r3(bezier[3])})`;
}

export function compileMarkCss(animation, stateMachine) {
  const fps = animation.fr;
  const segments = new Map(animation.markers.map((m) => [m.cm, [m.tm, m.tm + m.dr]]));
  const states = stateMachine.states.map((s) => ({ name: s.name, loop: s.loop, seg: segments.get(s.segment) }));

  let nextId = 0;
  const newClass = () => `um-${nextId++}`;
  const baseCss = [];
  const animated = [];
  const visibility = [];
  const track = (cls, kind, prop) => prop?.a && animated.push({ cls, kind, keys: prop.k });

  // Lottie's translate(p) rotate(r) scale(s) translate(-a) is CSS's individual translate/rotate/scale followed by
  // `transform`. A split position animates x and y on their own timelines, so x gets an outer wrapper.
  function transformGroup(ks, inner) {
    const cls = newClass();
    const anchor = staticValue(ks.a ?? { k: [0, 0] });
    const split = ks.p?.s === true;
    const decl = [`transform: translate(${r3(-anchor[0])}px, ${r3(-anchor[1])}px)`];
    if (split) decl.push(DECLARATION.ty(staticValue(ks.p.y)));
    else if (ks.p) decl.push(DECLARATION.translate(staticValue(ks.p)));
    if (ks.r) decl.push(DECLARATION.rotate(staticValue(ks.r)));
    if (ks.s) decl.push(DECLARATION.scale(staticValue(ks.s)));
    baseCss.push(`.${cls}{${decl.join(";")}}`);
    track(cls, split ? "ty" : "translate", split ? ks.p.y : ks.p);
    track(cls, "rotate", ks.r);
    track(cls, "scale", ks.s);
    const group = `<g class="${cls}">${inner}</g>`;
    if (!split) return group;
    const xCls = newClass();
    baseCss.push(`.${xCls}{${DECLARATION.tx(staticValue(ks.p.x))}}`);
    track(xCls, "tx", ks.p.x);
    return `<g class="${xCls}">${group}</g>`;
  }

  function shapes(items) {
    const fill = items.find((s) => s.ty === "fl");
    const stroke = items.find((s) => s.ty === "st");
    const paint = [
      fill ? `fill="${rgb(fill.c.k)}"${fill.r === 2 ? ' fill-rule="evenodd"' : ""}` : 'fill="none"',
      stroke
        ? `stroke="${rgb(stroke.c.k)}" stroke-width="${stroke.w.k}" stroke-linecap="${["butt", "butt", "round", "square"][stroke.lc]}" stroke-linejoin="${["miter", "miter", "round", "bevel"][stroke.lj]}"`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    return items
      .map((s) => {
        if (s.ty === "gr") {
          const tr = s.it.find((x) => x.ty === "tr");
          return transformGroup(tr, shapes(s.it.filter((x) => x !== tr)));
        }
        if (s.ty === "sh") {
          const cls = newClass();
          track(cls, "d", s.ks);
          return `<path class="${cls}" d="${shapePath(staticValue(s.ks))}" ${paint}/>`;
        }
        if (s.ty === "rc") {
          const [w, h] = s.s.k;
          const [x, y] = s.p.k;
          const rx = r3(Math.min(s.r.k, w / 2, h / 2));
          return `<rect x="${r3(x - w / 2)}" y="${r3(y - h / 2)}" width="${w}" height="${h}" rx="${rx}" ${paint}/>`;
        }
        if (s.ty === "el") {
          const [w, h] = s.s.k;
          return `<ellipse cx="${s.p.k[0]}" cy="${s.p.k[1]}" rx="${w / 2}" ry="${h / 2}" ${paint}/>`;
        }
        if (s.ty === "fl" || s.ty === "st") return "";
        throw new Error(`Unsupported Lottie shape type "${s.ty}"`);
      })
      .join("");
  }

  // Lottie parenting passes on transforms only, so opacity and in/out points sit on the layer's own content.
  const byParent = new Map();
  for (const layer of [...animation.layers].reverse()) {
    const key = layer.parent ?? "root";
    byParent.set(key, [...(byParent.get(key) ?? []), layer]);
  }
  function layerMarkup(layer) {
    const contentCls = newClass();
    baseCss.push(`.${contentCls}{${DECLARATION.opacity([staticValue(layer.ks.o ?? { k: 100 })])}}`);
    track(contentCls, "opacity", layer.ks.o);
    visibility.push({ cls: contentCls, ip: layer.ip, op: layer.op });
    const own = layer.ty === 4 ? `<g class="${contentCls}">${shapes(layer.shapes)}</g>` : "";
    const children = (byParent.get(layer.ind) ?? []).map(layerMarkup).join("");
    return transformGroup(layer.ks, own + children);
  }
  const body = (byParent.get("root") ?? []).map(layerMarkup).join("");

  const keyframes = [];
  const rules = new Map();
  const rule = (state, cls) => {
    const key = `${state}|${cls}`;
    if (!rules.has(key)) rules.set(key, { state, cls, animations: [], decls: [] });
    return rules.get(key);
  };
  const reducedMotion = [];

  for (const state of states) {
    const [a, b] = state.seg;
    const duration = r3((b - a) / fps);
    const timing = `${duration}s linear ${state.loop ? "infinite" : "1 both"}`;
    const pct = (t) => `${r3(((t - a) / (b - a)) * 100)}%`;

    for (const prop of animated) {
      const times = [a, ...prop.keys.map((k) => k.t).filter((t) => t > a && t < b), b];
      const values = times.map((t) => DECLARATION[prop.kind](valueAt(prop.keys, t)));
      if (values.every((v) => v === values[0])) {
        rule(state.name, prop.cls).decls.push(values[0]);
        continue;
      }
      const name = `${prop.cls}-${prop.kind}-${state.name}`;
      const frames = times.map((t, i) => `${pct(t)}{${values[i]};animation-timing-function:${easingAt(prop.keys, t)}}`);
      keyframes.push(`@keyframes ${name}{${frames.join("")}}`);
      rule(state.name, prop.cls).animations.push(`${name} ${timing}`);
    }

    for (const layer of visibility) {
      if (layer.ip <= a && layer.op >= b) continue;
      if (layer.op <= a || layer.ip >= b) {
        rule(state.name, layer.cls).decls.push("visibility: hidden");
        continue;
      }
      const frames = [[0, layer.ip <= a]];
      if (layer.ip > a) frames.push([layer.ip, true]);
      if (layer.op < b) frames.push([layer.op, false]);
      const name = `${layer.cls}-vis-${state.name}`;
      const css = frames.map(([t, shown]) => `${t ? pct(t) : "0%"}{visibility:${shown ? "visible" : "hidden"};animation-timing-function:step-end}`);
      keyframes.push(`@keyframes ${name}{${css.join("")}}`);
      rule(state.name, layer.cls).animations.push(`${name} ${timing}`);
    }

    // `animationend` of the clock is the state machine's OnComplete.
    const clock = `um-clock-${state.name}`;
    keyframes.push(`@keyframes ${clock}{from{opacity:1}to{opacity:1}}`);
    rule(state.name, "um-clock").animations.push(`${clock} ${timing}`);

    // Reduced motion holds a still pose like the Lottie player does: a loop's first frame, a one-shot's last.
    const hold = state.loop ? 0 : r3(-(duration - 1 / fps));
    reducedMotion.push(
      `.um-root[data-state="${state.name}"] *{animation-delay:${hold}s!important;animation-play-state:paused!important}`,
    );
  }

  const stateCss = [...rules.values()].map(({ state, cls, animations, decls }) => {
    const declarations = [...decls, animations.length ? `animation:${animations.join(",")}` : ""].filter(Boolean);
    return `.um-root[data-state="${state}"] .${cls}{${declarations.join(";")}}`;
  });

  const css = [
    ".um-root{display:block;width:100%;height:100%;overflow:visible}",
    ...baseCss,
    ...keyframes,
    ...stateCss,
    `@media (prefers-reduced-motion: reduce){${reducedMotion.join("")}}`,
  ].join("\n");
  const svg = `<svg class="um-root" viewBox="0 0 ${animation.w} ${animation.h}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g class="um-clock"></g>${body}</svg>`;
  return { css, svg };
}

export const generatedModule = ({ css, svg }) =>
  `// Generated from umia-mark.json and umia-mark.state-machine.json by umia-mark-css-compiler.js. Not committed.\nexport const markCss = ${JSON.stringify(css)};\nexport const markSvg = ${JSON.stringify(svg)};\n`;
