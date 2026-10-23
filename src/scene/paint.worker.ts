import type { Bounds, Layout } from "../scripts/bonsai";
import { paletteOf } from "./palette";
import { buildScene, skyPixels } from "./scene";
import type { Sky } from "./sky";
import { keepLayer, paintLayer, paintSmall, PIXEL_SIZES } from "./tree";

// Paints what the scene draws from pictures, away from the page's thread
// while the characters grow, and hands each back without a copy: the moon,
// the Milky Way and the clouds as pixels; then the smooth tree, with the
// palette the pixel stage snaps to. The scene is built here from the same
// plain data as the page's, so it's the same scene.
// First, whether there's a GPU for the 3D stages, asked here so the page
// never waits while the browser first sets up WebGL: "fast" a GPU, "slow"
// only a software stand-in, "unknown" if a worker can't tell (the page then
// asks itself).
export type Gpu = "fast" | "slow" | "unknown";
function gpu(): Gpu {
  const fast = new OffscreenCanvas(1, 1).getContext("webgl2", { failIfMajorPerformanceCaveat: true });
  if (fast) {
    fast.getExtension("WEBGL_lose_context")?.loseContext();
    return "fast";
  }
  const any = new OffscreenCanvas(1, 1).getContext("webgl2");
  any?.getExtension("WEBGL_lose_context")?.loseContext();
  return any ? "slow" : "unknown";
}
self.postMessage({ gpu: gpu() });

type Job = { id: number; layout: Layout; width: number; height: number; sky: Sky; seed: number; words: Bounds[]; ratio: number };

self.onmessage = ({ data }: MessageEvent<Job>) => {
  const { id, layout, width, height, sky, seed, words, ratio } = data;
  const scene = buildScene(layout, width, height, sky, seed, words);
  const pixels = skyPixels(scene.recipe);
  scene.adopt(pixels);
  const images = [pixels.moon, pixels.galaxy, ...pixels.clouds].filter((image) => image !== undefined);
  self.postMessage({ id, sky: pixels }, { transfer: images.map((image) => image.data.buffer) });
  // The tree is painted in memory: its thousands of shapes would keep the
  // GPU from the page's frames. The palette and the pixel stage's copies,
  // which are read back, come from it there. Then it goes up to the GPU in
  // one copy, where the page draws it whole.
  const w = Math.round(width * ratio);
  const h = Math.round(height * ratio);
  const paper = new OffscreenCanvas(w, h);
  const paperCtx = paper.getContext("2d", { willReadFrequently: true });
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!paperCtx || !ctx) {
    self.postMessage({ id, done: true });
    return;
  }
  paintLayer(paperCtx, scene, ratio);
  keepLayer(scene, paper);
  const palette = paletteOf(scene);
  const small = PIXEL_SIZES.map((size) => {
    const copy = new OffscreenCanvas(1, 1);
    paintSmall(copy, scene, size);
    return copy.transferToImageBitmap();
  });
  ctx.drawImage(paper, 0, 0);
  // Its memory goes now, not whenever this scene is collected.
  paper.width = paper.height = 0;
  const tree = canvas.transferToImageBitmap();
  self.postMessage({ id, tree, small, palette, done: true }, { transfer: [tree, ...small] });
};
