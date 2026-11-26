/* Shared motion for the small cards in the window's bottom-left corner
 * (sidebar notices, mail and meeting reminders, the update card). They rise
 * in on a spring that overshoots a little and settles, and sink away when
 * dismissed instead of vanishing. Cards in the dock's flow also grow and
 * shrink their height, so what's above them moves smoothly too. Reduced
 * motion shows and hides them at once. */

// A damped spring (about 8% overshoot, one small rebound), as a linear() curve.
export const SPRING = "linear(0, 0.18 6%, 0.52 13%, 0.86 21%, 1.05 29%, 1.08 34%, 1.07 39%, 1.02 48%, 0.99 57%, 0.985 64%, 1 80%, 1)";
export const SETTLE = "cubic-bezier(.2, .8, .25, 1)";
export const SINK = "cubic-bezier(.5, 0, .75, .2)";

function reduced(node) {
  return node.ownerDocument?.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function stop(node) {
  for (const animation of node.limaMotion ?? []) animation.cancel();
  node.limaMotion = null;
  node.limaLeaving = false;
}

/** Shows `node` with a springy rise. `flow` also grows it from no height
 * (for cards laid out in the dock); `gap` is the flex gap it sits above. */
export function popIn(node, { flow = false, gap = 6 } = {}) {
  const wasShown = !node.hidden && !node.limaLeaving;
  stop(node);
  node.hidden = false;
  if (reduced(node)) return;
  const animations = [];
  if (flow && !wasShown) {
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    const height = node.getBoundingClientRect().height;
    animations.push(node.animate([
      { height: "0px", paddingTop: "0px", paddingBottom: "0px", marginBottom: `${-gap}px` },
      { height: `${height}px`, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, marginBottom: "0px" },
    ], { duration: 320, easing: SETTLE }));
  }
  animations.push(node.animate(wasShown
    ? [{ transform: "scale(.985)" }, { transform: "none" }]
    : [{ opacity: 0, transform: "translateY(16px) scale(.94)" }, { opacity: 1, transform: "none" }],
  { duration: wasShown ? 380 : 560, easing: SPRING }));
  node.limaMotion = animations;
  animations.at(-1).finished.then(() => { if (node.limaMotion === animations) node.limaMotion = null; }, () => {});
}

/** Hides `node` by sinking it away, then runs `done` (e.g. remove it). */
export function sinkAway(node, { flow = false, gap = 6, done } = {}) {
  if (node.hidden || node.limaLeaving) return;
  stop(node);
  const finish = () => { node.limaMotion = null; node.limaLeaving = false; node.hidden = true; done?.(); };
  if (reduced(node) || !node.isConnected) { finish(); return; }
  node.limaLeaving = true;
  const animations = [node.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(12px) scale(.95)" }],
    { duration: 220, easing: SINK, fill: "forwards" })];
  if (flow) {
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    const height = node.getBoundingClientRect().height;
    animations.push(node.animate([
      { height: `${height}px`, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, marginBottom: "0px" },
      { height: "0px", paddingTop: "0px", paddingBottom: "0px", marginBottom: `${-gap}px` },
    ], { duration: 300, delay: 60, easing: SETTLE, fill: "forwards" }));
  }
  node.limaMotion = animations;
  Promise.all(animations.map(animation => animation.finished)).then(() => {
    if (node.limaMotion !== animations) return;
    for (const animation of animations) animation.cancel();
    finish();
  }, () => {});
}

/** The card is on its way out (still visible, but not to be reused). */
export function isLeaving(node) {
  return Boolean(node.limaLeaving);
}
