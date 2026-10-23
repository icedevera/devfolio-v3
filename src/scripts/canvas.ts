// A canvas sized for crisp drawing, and the frame loop that draws on it.

export { clamp, random } from "./math";

export const still = matchMedia("(prefers-reduced-motion: reduce)");

export type Surface = { ctx: CanvasRenderingContext2D; width: number; height: number };

// Sizes a canvas to its CSS box at the device pixel ratio, and draws in CSS
// pixels.
export function fitCanvas(canvas: HTMLCanvasElement): Surface {
  const { width, height } = canvas.getBoundingClientRect();
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is unavailable");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width, height };
}

// Waits for a font so text measurements match the glyphs, then calls setup
// again whenever the canvas, or anything in `watch`, changes size, or the
// canvas moves to a screen with another pixel ratio. One observer watches
// them all, so a change to several still sets up once.
export function onReady(
  canvas: HTMLCanvasElement,
  family: string,
  setup: () => void,
  watch: Iterable<Element> = [],
) {
  document.fonts
    .load(`16px ${family}`)
    .catch(() => [])
    .then(() => {
      const sizes = new ResizeObserver(setup);
      for (const box of [canvas, ...watch]) sizes.observe(box);
      const watchRatio = () => {
        matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener(
          "change",
          () => {
            setup();
            watchRatio();
          },
          { once: true },
        );
      };
      watchRatio();
    });
}

// Runs draw at up to `fps` frames a second. With reduced motion it draws
// only after wake(), which callers use when something the visitor did
// changes the picture.
export function loop(draw: (time: number) => void, fps = 30) {
  let last = -Infinity;
  let woken = true;
  const tick = (time: number) => {
    requestAnimationFrame(tick);
    if (time - last < 1000 / fps - 2) return;
    if (still.matches && !woken) return;
    woken = false;
    last = time;
    draw(time);
  };
  requestAnimationFrame(tick);
  const wake = () => {
    woken = true;
  };
  still.addEventListener("change", wake);
  return wake;
}
