import type { Branch, Layout } from "../scripts/bonsai";
import { clamp, random } from "../scripts/math";
import { hash, noise, smooth } from "./noise";
import type { Scene } from "./scene";
import { css, mix, type RGB } from "./sky";

// The tree the later stages draw. It follows the same walk as the
// characters, smoothed, with each limb as thick as the leaves it carries, so
// it holds up at full resolution.

export const cellX = (l: Layout, c: number) => l.x + (c + 0.5) * l.cw;
export const cellY = (l: Layout, r: number) => l.y + (r + 0.5) * l.ch;

// Each ramp runs from dark to light.
export const BARK: RGB[] = [[38, 28, 22], [70, 51, 39], [104, 78, 58], [142, 110, 82], [182, 148, 112]];
export const LEAF: RGB[] = [[28, 45, 32], [50, 78, 48], [82, 116, 68], [126, 158, 92], [182, 206, 138]];
export const BLOSSOM: RGB[] = [[120, 56, 86], [190, 98, 132], [232, 152, 177], [246, 196, 210], [255, 236, 241]];
export const GLAZE: RGB[] = [[40, 47, 66], [74, 86, 114], [114, 128, 160], [156, 170, 200], [206, 216, 234]];
export const MOSS: RGB[] = [[38, 48, 28], [66, 82, 42], [100, 120, 62], [146, 164, 94]];

// Reads a ramp at t, from 0 (its darkest) to 1 (its lightest).
export function ramp(stops: RGB[], t: number): RGB {
  const x = clamp(t) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return mix(stops[i], stops[i + 1], x - i);
}

// A point along a limb in CSS pixels, its depth for the 3D stage, and its
// radius.
export type Joint = { x: number; y: number; z: number; r: number };
export type Limb = { kind: Branch["kind"]; joints: Joint[]; parent: number; at: number };
// `cover` is how much of the canopy sits above it: 0 on top, 1 deep inside.
export type Leaf = { x: number; y: number; z: number; blossom: boolean; cover: number; seed: number };
export type Pot = {
  top: number; // the rim
  bottom: number; // the body's base
  foot: number; // the feet's base
  left: number;
  right: number;
  base: number; // the body's half width at its base
  center: number;
};
// `soil` is where the trunk meets the soil; `roots` spread out from it.
export type Skeleton = { limbs: Limb[]; leaves: Leaf[]; pot: Pot; soil: Joint; roots: Joint[][] };

// Gaussian smoothing along a limb, `sigma` in joints. The walk steps a row
// at a time, and rows are twice as tall as columns, so its zigzags are sharp
// once drawn smooth. Mirroring both ends keeps where the limb starts and ends
// and the way it heads. Joints before `from` stay where they are.
function smoothen(points: number[][], sigma: number, from = 1) {
  const n = points.length;
  if (n < 3 || n - from < 1) return;
  const reach = Math.ceil(sigma * 2.5);
  const before = points.map((p) => [...p]);
  const at = (j: number, d: number) => {
    if (j < 0) return 2 * before[0][d] - before[Math.min(n - 1, -j)][d];
    if (j >= n) return 2 * before[n - 1][d] - before[Math.max(0, 2 * (n - 1) - j)][d];
    return before[j][d];
  };
  for (let i = Math.max(1, from); i < n; i++) {
    for (let d = 0; d < 3; d++) {
      let sum = 0;
      let weight = 0;
      for (let j = i - reach; j <= i + reach; j++) {
        const w = Math.exp(-((j - i) ** 2) / (2 * sigma * sigma));
        sum += w * at(j, d);
        weight += w;
      }
      points[i][d] = sum / weight;
    }
  }
}

// A second trunk grows out of the first. Pulls its lower part in, so the two
// share one trunk and then fork, rather than climb side by side.
function merge(points: number[][], parent: number[][], at: number, share: number) {
  const span = Math.max(2, points.length * share);
  for (let k = 1; k < points.length && k < span; k++) {
    const w = smooth(0, 1, 1 - k / span);
    const q = parent[Math.min(parent.length - 1, at + k)];
    for (let d = 0; d < 3; d++) points[k][d] += (q[d] - points[k][d]) * w;
  }
}

// Keeps a limb moving away from where it starts, by at least `step` a joint:
// a walk that doubles back reads as a knot once it is smooth.
function straighten(points: number[][], step: number) {
  const n = points.length;
  const [x0, y0] = points[0];
  const length = Math.hypot(points[n - 1][0] - x0, points[n - 1][1] - y0);
  if (n < 3 || length < step * 3) return;
  const ux = (points[n - 1][0] - x0) / length;
  const uy = (points[n - 1][1] - y0) / length;
  let reach = 0;
  for (let k = 1; k < n; k++) {
    const p = points[k];
    const along = (p[0] - x0) * ux + (p[1] - y0) * uy;
    reach = Math.max(along, reach + step);
    p[0] += (reach - along) * ux;
    p[1] += (reach - along) * uy;
  }
}

// Runs a limb inside its parent while the two stay close, so they read as one
// thicker limb until it peels away. Returns the limb's first joint off the
// parent, and the parent's joint where it leaves.
function bundle(points: number[][], parent: number[][], at: number, reach: number): [number, number] {
  let m = at;
  for (let k = 1; k < points.length; k++) {
    const p = points[k];
    let best = Infinity;
    let near = m;
    for (let j = m; j < parent.length; j++) {
      const d = Math.hypot(p[0] - parent[j][0], p[1] - parent[j][1]);
      if (d < best) [best, near] = [d, j];
    }
    if (best > reach || near === parent.length - 1) return [k, m];
    m = near;
    points[k] = [...parent[m]];
  }
  return [points.length, m];
}

// Keeps a limb on its own side of another, so the two never cross: shoots
// stay above or below each other (axis 1), trunks left or right (axis 0).
// The side is where the limb first stands beside the other, from joint
// `from - 1` on.
function separate(points: number[][], other: number[][], from: number, gap: number, axis: 0 | 1) {
  const a = 1 - axis;
  // The other limb's level where it passes the point, the nearest if it
  // passes more than once.
  const level = (p: number[]) => {
    let best: number | undefined;
    for (let i = 0; i < other.length - 1; i++) {
      const [u, v] = [other[i], other[i + 1]];
      if (Math.abs(v[a] - u[a]) < 1e-6 || p[a] < Math.min(u[a], v[a]) || p[a] > Math.max(u[a], v[a])) continue;
      const at = u[axis] + ((p[a] - u[a]) / (v[a] - u[a])) * (v[axis] - u[axis]);
      if (best === undefined || Math.abs(at - p[axis]) < Math.abs(best - p[axis])) best = at;
    }
    return best;
  };
  let side = 0;
  for (let k = from - 1; k < points.length; k++) {
    const p = points[k];
    const at = level(p);
    if (at === undefined) continue;
    side ||= p[axis] < at ? -1 : 1;
    if (k >= from && (p[axis] - at) * side < gap) p[axis] = at + side * gap;
  }
}

// How far each kind of limb is smoothed, in joints: the long limbs most, the
// twigs at the tips least.
const SMOOTHING: Record<Branch["kind"], number> = { trunk: 2.5, left: 2.5, right: 2.5, dying: 1.2, dead: 0.7 };

export function buildSkeleton(l: Layout, seed: number): Skeleton {
  const { tree, cw, ch } = l;
  const branches = tree.branches;

  // Each branch leans in or out of the picture from where it leaves its
  // parent, a depth the 2D picture only hints at.
  const depths: number[][] = [];
  branches.forEach((b, i) => {
    const start = b.parent < 0 ? 0 : (depths[b.parent][b.at] ?? 0);
    const lean = (hash(i, 1) - 0.5) * 2 * (b.kind === "trunk" ? 0.25 : 1);
    const zs = [start];
    for (let k = 1; k < b.points.length; k++) {
      const dx = Math.abs(b.points[k].c - b.points[k - 1].c);
      zs.push(zs[k - 1] + lean * (dx + 0.6) * cw * 1.1 * (0.5 + 0.5 * hash(i, k)));
    }
    depths.push(zs);
  });

  // Each limb's path, and where it comes free of its parent: its own joint
  // and the parent's.
  const paths: number[][][] = [];
  const peels = branches.map(() => ({ joint: 0, at: 0 }));
  branches.forEach((b, i) => {
    const points = b.points.map((p, k) => [cellX(l, p.c), cellY(l, p.r), depths[i][k]]);
    const parent = paths[b.parent];
    let free = 1;
    if (parent) {
      // Move with the parent, which is straightened and smoothed already.
      const shift = parent[b.at].map((v, d) => v - points[0][d]);
      for (const p of points) for (let d = 0; d < 3; d++) p[d] += shift[d];
    }
    straighten(points, cw * 0.35);
    // Shoots reach out from the trunk and never turn back toward it.
    if (b.kind === "left" || b.kind === "right") {
      const out = b.kind === "left" ? -1 : 1;
      for (let k = 1; k < points.length; k++) {
        points[k][0] = out * Math.max(out * points[k][0], out * points[k - 1][0] + cw * 0.2);
      }
    }
    if (parent && b.kind === "trunk") merge(points, parent, b.at, 0.5);
    if (parent) {
      const [k, m] = bundle(points, parent, b.at, cw * 1.6);
      peels[i] = { joint: k - 1, at: m };
      free = k;
    }
    // Shoots and trunks that head the same way stay clear of each other,
    // before smoothing and again after it, which can pull them back.
    const apart = () => {
      if (b.kind === "dying" || b.kind === "dead" || free >= points.length) return;
      for (let j = 0; j < i; j++) {
        if (branches[j].kind !== b.kind) continue;
        const other = j === b.parent ? paths[j].slice(peels[i].at) : paths[j];
        separate(points, other, free, cw * (b.kind === "trunk" ? 2.4 : 1.8), b.kind === "trunk" ? 0 : 1);
      }
    };
    apart();
    smoothen(points, SMOOTHING[b.kind], free);
    apart();
    smoothen(points, 1, free);
    paths.push(points);
  });

  // How many leaves each point holds up, its own and every branch's beyond
  // it. A limb's cross-section grows with that count, as a real tree's does.
  const load = branches.map((b) => b.points.map(() => 0));
  for (const op of tree.ops) if (op.leaf) load[op.branch][op.step] += 1;
  for (let i = branches.length - 1; i >= 0; i--) {
    const w = load[i];
    for (let k = w.length - 2; k >= 0; k--) w[k] += w[k + 1];
    const b = branches[i];
    if (b.parent >= 0) load[b.parent][peels[i].at] += w[0];
  }
  const total = Math.max(1, load[0][0]);
  const twig = cw * 0.07;
  const trunk = cw * 1.15;

  const limbs: Limb[] = branches.map((b, i): Limb => {
    const radii = load[i].map((w) => twig + (trunk - twig) * Math.sqrt(w / total));
    // Ease the steps where branches leave, and never thicken toward the tip.
    for (let pass = 0; pass < 3; pass++) {
      for (let k = 1; k < radii.length - 1; k++) radii[k] = (radii[k - 1] + radii[k] * 2 + radii[k + 1]) / 4;
    }
    const peel = peels[i];
    if (b.parent >= 0) {
      const widest = load[b.parent][peel.at];
      const parent = twig + (trunk - twig) * Math.sqrt(widest / total);
      for (let k = 0; k <= peel.joint; k++) radii[k] = Math.min(radii[k], parent * 0.9);
    }
    for (let k = 1; k < radii.length; k++) radii[k] = Math.min(radii[k], radii[k - 1]);
    return { kind: b.kind, parent: b.parent, at: b.at, joints: paths[i].map(([x, y, z], k) => ({ x, y, z, r: radii[k] })) };
  });

  const key = (c: number, r: number) => (r + 2048) * 8192 + c + 4096;
  const leafy = tree.ops.filter((op) => op.leaf);
  const cells = new Set(leafy.map((op) => key(op.c, op.r)));
  const leaves = leafy.map((op): Leaf => {
    const j = limbs[op.branch].joints[op.step];
    let above = 0;
    for (let dr = 1; dr <= 3; dr++) {
      for (let dc = -2; dc <= 2; dc++) if (cells.has(key(op.c + dc, op.r - dr))) above++;
    }
    return { x: j.x, y: j.y, z: j.z, blossom: op.blossom, cover: clamp(above / 7), seed: Math.floor(hash(op.c, op.r, op.step) * 1e9) };
  });

  // Draw each limb from where it leaves its parent to its last leaf: bare
  // wood past it reads as a stray line at this size.
  limbs.forEach((limb, i) => {
    const last = load[i].findLastIndex((w) => w > 0);
    limb.joints = limb.joints.slice(peels[i].joint, last + 1);
  });

  // cbonsai's pot: the rim on row 1, the body down to row 3, feet on row 4.
  const pot: Pot = {
    top: l.y + 1.72 * ch,
    bottom: l.y + 3.85 * ch,
    foot: l.y + 4.55 * ch,
    left: cellX(l, -15) - cw * 0.35,
    right: cellX(l, 15) + cw * 0.35,
    base: cellX(l, 13) - cellX(l, 0) + cw * 0.2,
    center: cellX(l, 0),
  };
  const first = limbs[0].joints[0];
  const soil = { x: first.x, y: pot.top - ch * 0.12, z: 0, r: first.r * 1.7 };

  // Surface roots, spreading around the trunk across the moss.
  const rand = random(seed ^ 0x2007);
  const roots = Array.from({ length: 5 }, (_, k): Joint[] => {
    const angle = Math.PI * (0.1 + 0.4 * k + 0.25 * rand());
    const reach = cw * (2.2 + rand() * 3.2);
    const [dx, dz] = [Math.cos(angle) * reach, Math.sin(angle) * reach * 0.5];
    const sink = ch * (0.04 + rand() * 0.08);
    return [
      { x: soil.x + dx * 0.05, y: soil.y - 1, z: dz * 0.05, r: soil.r * (0.35 + rand() * 0.15) },
      { x: soil.x + dx * 0.45, y: soil.y + sink * 0.3, z: dz * 0.45, r: soil.r * 0.18 },
      { x: soil.x + dx, y: soil.y + sink + ch * 0.1, z: dz, r: 0.4 },
    ];
  });
  return { limbs, leaves, pot, soil, roots };
}

// Catmull-Rom through the joints, a point every `spacing` pixels, so strokes
// curve rather than kink.
export function resample(joints: Joint[], spacing: number): Joint[] {
  const out: Joint[] = [joints[0]];
  for (let i = 0; i < joints.length - 1; i++) {
    const p0 = joints[Math.max(0, i - 1)];
    const p1 = joints[i];
    const p2 = joints[i + 1];
    const p3 = joints[Math.min(joints.length - 1, i + 2)];
    const steps = Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z) / spacing);
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const at = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      out.push({
        x: at(p0.x, p1.x, p2.x, p3.x),
        y: at(p0.y, p1.y, p2.y, p3.y),
        z: at(p0.z, p1.z, p2.z, p3.z),
        r: p1.r + (p2.r - p1.r) * t,
      });
    }
  }
  return out;
}

type Light = { x: number; y: number; tint: RGB };

// Where the light comes from, as a unit vector on screen, and its color.
function lightOf(s: Painted): Light {
  const { pot } = s.skeleton;
  const dx = s.body.x - pot.center;
  const dy = s.body.y - (pot.top - s.layout.ch * 12);
  const d = Math.hypot(dx, dy) || 1;
  return { x: dx / d, y: dy / d, tint: mix([255, 251, 244], [190, 196, 232], s.night) };
}

const lit = (c: RGB, light: Light, alpha = 1) =>
  css([(c[0] * light.tint[0]) / 255, (c[1] * light.tint[1]) / 255, (c[2] * light.tint[2]) / 255], alpha);

// The pale glaze would glow under the moon, so it reads a shade darker at
// night.
const glazeOf = (s: Painted, light: Light) => (t: number, alpha = 1) => lit(ramp(GLAZE, t - 0.22 * s.night), light, alpha);

// What the painters need of the scene: plain data, so a worker can have it.
export type Painted = Pick<Scene, "width" | "height" | "layout" | "skeleton" | "body" | "night" | "seed">;
export type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// The tree, pot and all, painted once per scene at the screen's pixel
// ratio. A worker usually paints it ahead (see `keepLayer`); otherwise it's
// painted here the first time it's needed.
const layers = new WeakMap<Scene, CanvasImageSource>();

// The pixel stage's sizes (see pixelsAt), which a worker makes copies at.
export const PIXEL_SIZES = [2, 3, 4, 5, 6, 7, 8];

// A worker's tree comes on the GPU, where the page draws it whole, with its
// copies at PIXEL_SIZES in memory, where the pixel stage reads them back.
// Either way, nothing is copied between the two on the page's thread.
export function keepLayer(s: Scene, layer: CanvasImageSource, small: ImageBitmap[] = []) {
  layers.set(s, layer);
  if (small.length) smalls.set(s, new Map(small.map((copy, i) => [PIXEL_SIZES[i], copy])));
}

// Frees a scene's tree pictures once it's been replaced, rather than
// whenever they're collected.
export function forgetLayer(s: Scene) {
  const layer = layers.get(s);
  if (layer instanceof ImageBitmap) layer.close();
  for (const copy of smalls.get(s)?.values() ?? []) if (copy instanceof ImageBitmap) copy.close();
  layers.delete(s);
  smalls.delete(s);
}

export function paintTree(ctx: Context2D, s: Scene) {
  let layer = layers.get(s);
  if (!layer) {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(s.width * ratio);
    canvas.height = Math.round(s.height * ratio);
    const layerCtx = canvas.getContext("2d");
    if (layerCtx) paintLayer(layerCtx, s, ratio);
    layer = canvas;
    layers.set(s, layer);
  }
  ctx.drawImage(layer, 0, 0, s.width, s.height);
}

// The pixel stage draws the tree small every frame onto a canvas it reads
// back. A copy at each size, made once from the full one, makes that a
// plain copy rather than a scaling down of the whole tree from the GPU.
const smalls = new WeakMap<Scene, Map<number, HTMLCanvasElement | ImageBitmap>>();

export function paintTreeAt(ctx: CanvasRenderingContext2D, s: Scene, size: number) {
  let sizes = smalls.get(s);
  if (!sizes) smalls.set(s, (sizes = new Map()));
  let small = sizes.get(size);
  if (!small) {
    const copy = document.createElement("canvas");
    paintSmall(copy, s, size);
    sizes.set(size, (small = copy));
  }
  ctx.drawImage(small, 0, 0, small.width * size, small.height * size);
}

// The tree onto `canvas`, `size` pixels to one, kept in memory for reading
// back.
export function paintSmall(canvas: HTMLCanvasElement | OffscreenCanvas, s: Scene, size: number) {
  canvas.width = Math.ceil(s.width / size);
  canvas.height = Math.ceil(s.height / size);
  const ctx =
    typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas
      ? canvas.getContext("2d", { willReadFrequently: true })
      : (canvas as HTMLCanvasElement).getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  ctx.imageSmoothingQuality = "high";
  ctx.setTransform(1 / size, 0, 0, 1 / size, 0, 0);
  paintTree(ctx, s);
}

export function paintLayer(ctx: Context2D, s: Painted, ratio: number) {
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const light = lightOf(s);
  paintPot(ctx, s, light);
  paintMoss(ctx, s, light);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, s.width, s.skeleton.pot.top);
  ctx.clip();
  paintWood(ctx, s, light);
  ctx.restore();
  paintRim(ctx, s, light);
  paintFoliage(ctx, s, light);
}

function paintPot(ctx: Context2D, s: Painted, light: Light) {
  const { pot } = s.skeleton;
  const { cw, ch } = s.layout;
  const glaze = glazeOf(s, light);

  // The shadow it casts on the ground.
  const width = pot.right - pot.left;
  ctx.save();
  ctx.translate(pot.center, pot.foot);
  ctx.scale(1, 0.09);
  const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, width * 0.62);
  shadow.addColorStop(0, "rgb(0 0 0 / 0.55)");
  shadow.addColorStop(0.6, "rgb(0 0 0 / 0.25)");
  shadow.addColorStop(1, "rgb(0 0 0 / 0)");
  ctx.fillStyle = shadow;
  ctx.fillRect(-width, -width, width * 2, width * 2);
  ctx.restore();

  // Two feet.
  for (const side of [-1, 1]) {
    const x = pot.center + side * (pot.base - cw * 1.6);
    const feet = ctx.createLinearGradient(0, pot.bottom, 0, pot.foot);
    feet.addColorStop(0, glaze(0.12));
    feet.addColorStop(1, glaze(0.28));
    ctx.fillStyle = feet;
    ctx.beginPath();
    ctx.moveTo(x - cw * 1.35, pot.bottom - 2);
    ctx.lineTo(x + cw * 1.35, pot.bottom - 2);
    ctx.lineTo(x + cw * 1.05, pot.foot);
    ctx.quadraticCurveTo(x, pot.foot - ch * 0.12, x - cw * 1.05, pot.foot);
    ctx.closePath();
    ctx.fill();
  }

  // The body: tapered sides, rounded at the base.
  const rim = ch * 0.3;
  const top = pot.top + rim * 0.6;
  const inset = cw * 0.45;
  const body = new Path2D();
  body.moveTo(pot.left + inset, top);
  body.lineTo(pot.right - inset, top);
  body.lineTo(pot.center + pot.base + cw * 0.3, pot.bottom - ch * 0.3);
  body.quadraticCurveTo(pot.center + pot.base, pot.bottom, pot.center + pot.base - cw * 0.7, pot.bottom);
  body.lineTo(pot.center - pot.base + cw * 0.7, pot.bottom);
  body.quadraticCurveTo(pot.center - pot.base, pot.bottom, pot.center - pot.base - cw * 0.3, pot.bottom - ch * 0.3);
  body.closePath();

  const fill = ctx.createLinearGradient(0, top, 0, pot.bottom);
  fill.addColorStop(0, glaze(0.62));
  fill.addColorStop(0.45, glaze(0.5));
  fill.addColorStop(1, glaze(0.24));
  ctx.fillStyle = fill;
  ctx.fill(body);

  ctx.save();
  ctx.clip(body);
  // Lighter toward the light, darker away from it.
  const side = ctx.createLinearGradient(pot.left, 0, pot.right, 0);
  const near = light.x < 0 ? 0 : 1;
  side.addColorStop(near, "rgb(255 255 255 / 0.12)");
  side.addColorStop(0.5, "rgb(255 255 255 / 0)");
  side.addColorStop(1 - near, "rgb(0 0 0 / 0.28)");
  ctx.fillStyle = side;
  ctx.fillRect(pot.left, top, width, pot.bottom - top);
  // The glaze's soft reflection of the light.
  const sheenX = pot.center + light.x * width * 0.3;
  const sheen = ctx.createLinearGradient(sheenX - cw * 2.5, 0, sheenX + cw * 2.5, 0);
  sheen.addColorStop(0, "rgb(255 255 255 / 0)");
  sheen.addColorStop(0.5, glaze(1, 0.22));
  sheen.addColorStop(1, "rgb(255 255 255 / 0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(sheenX - cw * 2.5, top, cw * 5, pot.bottom - top);
  // The rim's shadow on the body, and a line cut around it.
  const under = ctx.createLinearGradient(0, top, 0, top + ch * 0.35);
  under.addColorStop(0, "rgb(0 0 0 / 0.35)");
  under.addColorStop(1, "rgb(0 0 0 / 0)");
  ctx.fillStyle = under;
  ctx.fillRect(pot.left, top, width, ch * 0.35);
  const groove = top + ch * 0.62;
  ctx.fillStyle = glaze(0.1, 0.55);
  ctx.fillRect(pot.left, groove, width, 1);
  ctx.fillStyle = glaze(0.95, 0.35);
  ctx.fillRect(pot.left, groove + 1, width, 1);
  // Kiln speckle.
  const rand = random(s.seed ^ 0x9077);
  for (let i = 0; i < 260; i++) {
    const x = pot.left + rand() * width;
    const y = top + rand() * (pot.bottom - top);
    ctx.fillStyle = rand() < 0.5 ? glaze(0.05, 0.35) : glaze(0.95, 0.3);
    ctx.fillRect(x, y, 0.6 + rand() * 0.9, 0.6 + rand() * 0.9);
  }
  // The unglazed foot ring.
  ctx.fillStyle = lit([62, 50, 42], light, 0.9);
  ctx.fillRect(pot.left, pot.bottom - ch * 0.14, width, ch * 0.14);
  ctx.restore();
}

// The lip, drawn over the trunk's base so the tree stands inside the pot.
function paintRim(ctx: Context2D, s: Painted, light: Light) {
  const { pot } = s.skeleton;
  const { ch } = s.layout;
  const rim = ch * 0.3;
  const glaze = glazeOf(s, light);
  const y = pot.top - rim * 0.4;
  const lip = ctx.createLinearGradient(0, y, 0, y + rim);
  lip.addColorStop(0, glaze(0.92));
  lip.addColorStop(0.35, glaze(0.66));
  lip.addColorStop(1, glaze(0.32));
  ctx.fillStyle = lip;
  ctx.beginPath();
  ctx.roundRect(pot.left, y, pot.right - pot.left, rim, rim * 0.35);
  ctx.fill();
  ctx.fillStyle = glaze(1, 0.7);
  ctx.fillRect(pot.left + rim * 0.3, y, pot.right - pot.left - rim * 0.6, 1);
}

// A mound of moss around the trunk, and the soil at its edges.
function paintMoss(ctx: Context2D, s: Painted, light: Light) {
  const { pot, soil } = s.skeleton;
  const { cw, ch } = s.layout;
  const half = cw * 8;
  const rise = ch * 0.42;
  const base = pot.top;
  const height = (x: number) => rise * Math.max(0, 1 - ((x - soil.x) / half) ** 2);
  ctx.fillStyle = lit(BARK[0], light);
  ctx.fillRect(pot.left + cw, base - ch * 0.08, pot.right - pot.left - cw * 2, ch * 0.1);
  ctx.fillStyle = lit(ramp(MOSS, 0.3), light);
  ctx.beginPath();
  ctx.moveTo(soil.x - half, base);
  for (let x = soil.x - half; x <= soil.x + half; x += 2) ctx.lineTo(x, base - height(x));
  ctx.closePath();
  ctx.fill();
  const rand = random(s.seed ^ 0x3055);
  for (let i = 0; i < 420; i++) {
    const x = soil.x + (rand() * 2 - 1) * half;
    const y = base - rand() * height(x);
    const toward = ((x - soil.x) / half) * light.x;
    const t = 0.25 + 0.5 * ((base - y) / rise) + 0.25 * toward + 0.25 * (rand() - 0.5);
    ctx.fillStyle = lit(ramp(MOSS, t), light);
    ctx.beginPath();
    ctx.arc(x, y, 0.5 + rand() * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Branches as tapered strokes: a dark edge, then lighter bands shifted
// toward the light, then the bark's fissures.
function paintWood(ctx: Context2D, s: Painted, light: Light) {
  const { limbs, soil, roots } = s.skeleton;
  // Roots first, so the trunk covers where they start.
  const strokes = [
    ...roots.map((root) => resample(root, 2)),
    ...limbs.filter((limb) => limb.joints.length > 1).map((limb, i) => resample(i === 0 ? [soil, ...limb.joints] : limb.joints, 2)),
  ];

  const passes: [number, number, number][] = [
    // ramp, width and shift toward the light, in radii
    [0.04, 1, 0],
    [0.3, 0.8, 0.18],
    [0.52, 0.52, 0.38],
    [0.8, 0.2, 0.62],
  ];
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [tone, width, shift] of passes) {
    // Grouped by width, so each width is one stroke call.
    const paths = new Map<number, Path2D>();
    for (const stroke of strokes) {
      for (let i = 1; i < stroke.length; i++) {
        const a = stroke[i - 1];
        const b = stroke[i];
        const w = Math.round((a.r + b.r) * width * 4) / 4;
        if (w < (shift > 0 ? 0.8 : 0.25)) continue;
        let path = paths.get(w);
        if (!path) paths.set(w, (path = new Path2D()));
        path.moveTo(a.x + light.x * a.r * shift, a.y + light.y * a.r * shift);
        path.lineTo(b.x + light.x * b.r * shift, b.y + light.y * b.r * shift);
      }
    }
    ctx.strokeStyle = lit(ramp(BARK, tone), light);
    for (const [w, path] of paths) {
      ctx.lineWidth = w;
      ctx.stroke(path);
    }
  }

  // Fissures along the thicker wood, broken where the noise dips.
  ctx.strokeStyle = lit(BARK[0], light, 0.55);
  for (const [n, stroke] of strokes.entries()) {
    for (const lane of [-0.55, -0.15, 0.3, 0.62]) {
      ctx.beginPath();
      let drawing = false;
      for (let i = 1; i < stroke.length - 1; i++) {
        const p = stroke[i];
        if (p.r < 2.4 || noise(i * 0.09, lane * 9, n) < -0.08) {
          drawing = false;
          continue;
        }
        const tx = stroke[i + 1].x - stroke[i - 1].x;
        const ty = stroke[i + 1].y - stroke[i - 1].y;
        const d = Math.hypot(tx, ty) || 1;
        const offset = p.r * (lane + 0.12 * noise(i * 0.2, lane * 5, n + 7));
        const x = p.x - (ty / d) * offset;
        const y = p.y + (tx / d) * offset;
        if (drawing) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        drawing = true;
      }
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }
}

// The canopy, the way it's painted by hand: a back layer of leaves in shadow,
// then leaves and blossoms in front, shaded by where they face and how deep
// in the canopy they sit, then specks of light along the top.
function paintFoliage(ctx: Context2D, s: Painted, light: Light) {
  const { leaves } = s.skeleton;
  const { cw } = s.layout;
  const depth = cw * 110;

  const leafShape = (x: number, y: number, angle: number, length: number, color: string) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(-length, 0);
    ctx.quadraticCurveTo(0, -length * 0.6, length, 0);
    ctx.quadraticCurveTo(0, length * 0.6, -length, 0);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  };
  const flower = (x: number, y: number, radius: number, turn: number, t: number) => {
    ctx.beginPath();
    for (let p = 0; p < 5; p++) {
      const a = turn + (p * Math.PI * 2) / 5;
      const px = x + Math.cos(a) * radius * 0.5;
      const py = y + Math.sin(a) * radius * 0.5;
      ctx.moveTo(px + Math.cos(a) * radius * 0.55, py + Math.sin(a) * radius * 0.55);
      ctx.ellipse(px, py, radius * 0.55, radius * 0.42, a, 0, Math.PI * 2);
    }
    ctx.fillStyle = lit(ramp(BLOSSOM, t), light);
    ctx.fill();
    if (radius < 1.6) return;
    ctx.fillStyle = lit(ramp(BLOSSOM, t - 0.28), light);
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = lit([248, 214, 150], light);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.5, radius * 0.12), 0, Math.PI * 2);
    ctx.fill();
  };

  // Soft shade where the canopy is thick.
  for (const leaf of leaves) {
    const shade = ctx.createRadialGradient(leaf.x, leaf.y + cw * 0.3, 0, leaf.x, leaf.y + cw * 0.3, cw * 1.3);
    shade.addColorStop(0, lit(LEAF[0], light, 0.35));
    shade.addColorStop(1, lit(LEAF[0], light, 0));
    ctx.fillStyle = shade;
    ctx.fillRect(leaf.x - cw * 1.3, leaf.y - cw, cw * 2.6, cw * 2.6);
  }

  const order = [...leaves].sort((a, b) => b.cover - a.cover || a.z - b.z);
  for (const back of [true, false]) {
    for (const leaf of order) {
      const rand = random(leaf.seed + (back ? 1 : 2));
      const spread = cw * (back ? 1.05 : 0.95);
      // Lighter toward the light and on top, darker deep inside and far back.
      const tone = (ox: number, oy: number) =>
        (back ? 0.12 : 0.5) +
        (0.3 * (ox * light.x + oy * light.y)) / spread -
        (back ? 0.1 : 0.32) * leaf.cover +
        leaf.z / depth +
        0.16 * (rand() - 0.5);
      const scatter = () => {
        const angle = rand() * Math.PI * 2;
        const d = Math.sqrt(rand()) * spread;
        return [Math.cos(angle) * d, Math.sin(angle) * d * 0.78];
      };

      const greens = leaf.blossom ? (back ? 6 : 3) : back ? 10 : 12;
      for (let k = 0; k < greens; k++) {
        const [ox, oy] = scatter();
        leafShape(leaf.x + ox, leaf.y + oy, rand() * Math.PI * 2, cw * (0.26 + 0.12 * rand()), lit(ramp(LEAF, tone(ox, oy)), light));
      }
      if (!leaf.blossom) continue;
      for (let k = 0; k < (back ? 4 : 7); k++) {
        const [ox, oy] = scatter();
        flower(leaf.x + ox, leaf.y + oy, cw * (0.24 + 0.1 * rand()), rand() * Math.PI * 2, tone(ox, oy) + (back ? 0.25 : 0.15));
      }
    }
  }

  for (const leaf of leaves) {
    if (leaf.cover > 0.25) continue;
    const rand = random(leaf.seed ^ 0x51);
    for (let k = 0; k < 3; k++) {
      ctx.fillStyle = lit(ramp(leaf.blossom ? BLOSSOM : LEAF, 1), light, 0.85);
      ctx.beginPath();
      ctx.arc(
        leaf.x + light.x * cw * 0.55 + (rand() - 0.5) * cw * 0.9,
        leaf.y + light.y * cw * 0.45 + (rand() - 0.5) * cw * 0.5,
        0.5 + rand() * 0.6,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }
}
