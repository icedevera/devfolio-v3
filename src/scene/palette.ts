import { paintBackdrop, SOIL, type Reveal, type Scene } from "./scene";
import { mix, type RGB } from "./sky";
import { paintTree, type Context2D } from "./tree";

const FULL: Reveal = { horizon: 1, body: 1, far: 1, near: 1, clouds: 1, sky: 1, birds: 0, mist: 1, rays: 1 };

// A small canvas to read back: offscreen where there is one, as in a
// worker, else on the page.
function sampler(width: number, height: number): Context2D | null {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext("2d", { willReadFrequently: true });
}

// The scene's own colors, which the pixel stage snaps every pixel to: the
// whole scene painted small, then split into boxes of similar colors
// (median cut), one color per box. The tree counts three times over, so it
// keeps its share of colors against all that sky. Pixels are counted into
// 15-bit color bins, keeping their exact sums, and the cut splits bins.
export function paletteOf(s: Scene, count = 55): RGB[] {
  const scale = Math.min(1, 360 / s.width);
  const sample = { width: Math.ceil(s.width * scale), height: Math.ceil(s.height * scale) };
  const ctx = sampler(sample.width, sample.height);
  if (!ctx) return [SOIL];
  const weight = new Float64Array(32768);
  const sums = new Float64Array(32768 * 3);
  const read = (opaque: boolean, times = 1) => {
    const data = ctx.getImageData(0, 0, sample.width, sample.height).data;
    for (let i = 0; i < data.length; i += 4) {
      if (opaque && data[i + 3] <= 220) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      weight[k] += times;
      sums[k * 3] += r * times;
      sums[k * 3 + 1] += g * times;
      sums[k * 3 + 2] += b * times;
    }
  };
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  paintTree(ctx, s);
  read(true, 2);
  paintBackdrop(ctx, s, FULL, 0);
  paintTree(ctx, s);
  read(false);
  // And the backdrop as the pixels arrive, before the sky has its color, so
  // the glow around the sun or moon keeps its own shades.
  paintBackdrop(ctx, s, { ...FULL, sky: 0, clouds: 0, mist: 0, rays: 0 }, 0);
  read(false);

  // Each bin's mean color.
  const bins: number[] = [];
  const mean = new Float64Array(32768 * 3);
  for (let k = 0; k < 32768; k++) {
    if (weight[k] === 0) continue;
    bins.push(k);
    for (let c = 0; c < 3; c++) mean[k * 3 + c] = sums[k * 3 + c] / weight[k];
  }
  type Box = { bins: number[]; channel: number; spread: number };
  const box = (list: number[]): Box => {
    let channel = 0;
    let spread = -1;
    let total = 0;
    for (const k of list) total += weight[k];
    for (let c = 0; c < 3; c++) {
      let lo = 255;
      let hi = 0;
      for (const k of list) {
        lo = Math.min(lo, mean[k * 3 + c]);
        hi = Math.max(hi, mean[k * 3 + c]);
      }
      if (hi - lo > spread) [channel, spread] = [c, hi - lo];
    }
    return { bins: list, channel, spread: spread * Math.sqrt(total) };
  };
  const boxes = [box(bins)];
  while (boxes.length < count) {
    let widest = 0;
    boxes.forEach((b, i) => {
      if (b.spread > boxes[widest].spread) widest = i;
    });
    const { bins: list, channel, spread } = boxes[widest];
    if (spread <= 0 || list.length < 2) break;
    list.sort((a, b) => mean[a * 3 + channel] - mean[b * 3 + channel]);
    // Split where half the pixels fall either side.
    let half = 0;
    for (const k of list) half += weight[k];
    half /= 2;
    let cut = 0;
    for (let seen = 0; cut < list.length - 1 && seen + weight[list[cut]] <= half; cut++) seen += weight[list[cut]];
    cut = Math.min(Math.max(cut, 1), list.length - 1);
    boxes.splice(widest, 1, box(list.slice(0, cut)), box(list.slice(cut)));
  }
  const average = ({ bins: list }: Box): RGB => {
    const sum = [0, 0, 0];
    let total = 0;
    for (const k of list) {
      total += weight[k];
      for (let c = 0; c < 3; c++) sum[c] += sums[k * 3 + c];
    }
    return [sum[0] / total, sum[1] / total, sum[2] / total];
  };
  // The sun and moon are too small a share of the picture to win a box.
  const p = s.sky.palette;
  const moon: RGB[] = [[244, 240, 228], [222, 216, 200], [196, 192, 182], [164, 160, 152], [130, 128, 126], [96, 98, 108], [64, 68, 84]];
  return [SOIL, ...boxes.map(average), p.sun, mix(p.sun, [255, 255, 250], 0.7), ...moon];
}
