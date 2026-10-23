import type { Bounds, Layout } from "../scripts/bonsai";
import { clamp, random } from "../scripts/math";
import { fbm, hash, noise, smooth } from "./noise";
import { css, mix, type Palette, type RGB, type Sky } from "./sky";
import { buildSkeleton, type Context2D, type Skeleton } from "./tree";

// The landscape behind the tree, and a painter that draws it smoothly. The
// pixel stage paints it small and coarsens the colors; the 2D stage paints it
// at full size.

export const SOIL: RGB = [22, 20, 17];
const MOONLIGHT: RGB = [239, 232, 214];

// How far along each part of the scene is, from 0 (absent) to 1.
export type Reveal = {
  horizon: number;
  body: number; // the sun or moon, and the stars with it
  far: number; // the far mountains
  near: number; // the nearer hills
  clouds: number;
  sky: number; // the sky's color, and the ground's
  birds: number; // birds by day, fireflies at night
  mist: number;
  rays: number; // sunbeams
};

type Star = { x: number; y: number; glow: number; rate: number; phase: number };
// A picture painted once: a canvas on the page, an offscreen one in a worker.
export type Picture = HTMLCanvasElement | OffscreenCanvas;
type Cloud = { x: number; y: number; w: number; speed: number; sprite: Picture | undefined };
// What the moon, the Milky Way and the clouds are painted from, and what
// they come to: plain data, so a worker can paint them (see `skyPixels`).
export type SkyRecipe = {
  moon?: [radius: number, phase: number, seed: number];
  galaxy?: [width: number, horizon: number, seed: number];
  clouds: [w: number, seed: number, palette: Palette, side: number][];
};
export type SkyPixels = { moon?: ImageData; galaxy?: ImageData; clouds: (ImageData | undefined)[] };
export type Ridge = "back" | "far" | "near";

export type Scene = {
  width: number;
  height: number;
  layout: Layout;
  skeleton: Skeleton;
  horizon: number; // in CSS pixels from the top
  sky: Sky;
  night: number; // 0 by day, 1 at night
  body: { x: number; y: number; radius: number };
  ridge: (x: number, which: Ridge) => number; // height above the horizon
  stars: Star[];
  clouds: Cloud[];
  moon: Picture | undefined; // the lit disc, drawn once
  galaxy: Picture | undefined; // the Milky Way, at night
  // The moon, Milky Way and clouds are painted the first time they're
  // drawn, unless a worker painted them first and they were adopted.
  recipe: SkyRecipe;
  adopt: (pixels: SkyPixels) => void;
  words: Bounds[]; // where the page's words sit, which clouds keep clear of
  seed: number;
};

export function buildScene(layout: Layout, width: number, height: number, sky: Sky, seed: number, words: Bounds[] = []): Scene {
  const rand = random(seed ^ 0x5eed);
  // The pot stands on the horizon.
  const horizon = layout.y + 2.6 * layout.ch;
  const room = Math.max(horizon, 1);
  const unit = Math.max(width, 600);
  const exact = (x: number, which: Ridge) => {
    const u = x / unit;
    if (which === "back") {
      const peaks = 1 - Math.abs(noise(u * 2.2, 9.4, seed % 89));
      return room * clamp(0.18 + 0.22 * peaks ** 3 + 0.05 * fbm(u * 6, 1.1, seed % 41, 4), 0.06, 0.5);
    }
    if (which === "far") {
      const peaks = 1 - Math.abs(noise(u * 3.1, 1.7, seed % 101));
      return room * clamp(0.13 + 0.17 * peaks ** 2 + 0.06 * fbm(u * 7, 3.3, seed % 53, 3), 0.04, 0.42);
    }
    return room * clamp(0.06 + 0.06 * fbm(u * 4.4, 5.1, seed % 37, 4) + 0.03 * noise(u * 13, 8.2), 0.02, 0.2);
  };

  // Painting asks every frame, so heights are kept per pixel column as
  // they're first asked for, and read between columns in a straight line.
  const columns = Math.ceil(width) + 2;
  const heights: Record<Ridge, Float64Array> = {
    back: new Float64Array(columns).fill(NaN),
    far: new Float64Array(columns).fill(NaN),
    near: new Float64Array(columns).fill(NaN),
  };
  const column = (i: number, which: Ridge) => {
    const known = heights[which];
    if (Number.isNaN(known[i])) known[i] = exact(i, which);
    return known[i];
  };
  const ridge = (x: number, which: Ridge) => {
    const i = Math.floor(x);
    if (i < 0 || i + 1 >= columns) return exact(x, which);
    const a = column(i, which);
    return a + (column(i + 1, which) - a) * (x - i);
  };

  // The sun or moon crosses from east (left) to west (right).
  const p = sky.progress;
  const lift = Math.sin(Math.PI * clamp(p, 0, 1));
  const top = height * 0.15;
  const radius = clamp(Math.min(width, height) * 0.065, 20, 64);
  const body = {
    x: width * (0.16 + 0.68 * clamp(p, -0.05, 1.05)),
    y: horizon - (horizon - top) * lift + (p < 0 || p > 1 ? radius : 0),
    radius,
  };

  const stars = Array.from({ length: Math.round((width * horizon) / 4200) }, () => ({
    x: rand() * width,
    y: rand() * horizon * 0.92,
    glow: rand() ** 3,
    rate: 0.6 + 1.8 * rand(),
    phase: rand() * Math.PI * 2,
  }));
  const night = smooth(-2, -12, sky.elevation);
  const recipe: SkyRecipe = {
    moon: sky.body === "moon" ? [radius, sky.phase, seed] : undefined,
    galaxy: night > 0.2 ? [width, horizon, seed] : undefined,
    clouds: [],
  };
  // Painted once each, here or in a worker; `null` until then.
  let moon: Picture | undefined | null = null;
  let galaxy: Picture | undefined | null = null;
  const sprites: (Picture | undefined | null)[] = [];
  const clouds: Cloud[] = Array.from({ length: 5 }, (_, i) => {
    const x = rand() * width;
    const w = unit * (0.1 + 0.14 * rand());
    const side = clamp(((body.x - x) / width) * 2, -1, 1);
    recipe.clouds.push([w, seed % 1000 + i * 17, sky.palette, side]);
    sprites.push(null);
    return {
      x,
      y: horizon * (0.1 + 0.4 * rand()),
      w,
      speed: 3 + 5 * rand(),
      get sprite() {
        if (sprites[i] === null) sprites[i] = shown(cloudPixels(...recipe.clouds[i]));
        return sprites[i] ?? undefined;
      },
    };
  });

  return {
    width,
    height,
    layout,
    skeleton: buildSkeleton(layout, seed),
    horizon,
    sky,
    night,
    body,
    ridge,
    stars,
    clouds,
    words,
    get moon() {
      if (moon === null) moon = recipe.moon && shown(moonPixels(...recipe.moon));
      return moon;
    },
    get galaxy() {
      if (galaxy === null) galaxy = recipe.galaxy && shown(galaxyPixels(...recipe.galaxy));
      return galaxy;
    },
    recipe,
    adopt(pixels) {
      if (moon === null) moon = pixels.moon && shown(pixels.moon);
      if (galaxy === null) galaxy = pixels.galaxy && shown(pixels.galaxy);
      pixels.clouds.forEach((image, i) => {
        if (sprites[i] === null) sprites[i] = image && shown(image);
      });
    },
    seed,
  };
}

export function skyPixels(r: SkyRecipe): SkyPixels {
  return {
    moon: r.moon && moonPixels(...r.moon),
    galaxy: r.galaxy && galaxyPixels(...r.galaxy),
    clouds: r.clouds.map((c) => cloudPixels(...c)),
  };
}

// Kept in memory rather than on the GPU: the pixel stage paints them into a
// canvas it reads back, and copying them out of the GPU stalls the page.
const shown = (image: ImageData): Picture => {
  if (typeof document === "undefined") {
    const canvas = new OffscreenCanvas(image.width, image.height);
    canvas.getContext("2d", { willReadFrequently: true })?.putImageData(image, 0, 0);
    return canvas;
  }
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext("2d", { willReadFrequently: true })?.putImageData(image, 0, 0);
  return canvas;
};

// The moon lit for its phase, with seas, drawn pixel by pixel once.
function moonPixels(radius: number, phase: number, seed: number) {
  const size = Math.ceil(radius * 2) + 2;
  const image = new ImageData(size, size);
  // Where the sun lights it from: behind it at new moon, behind us at full.
  const angle = phase * 2 * Math.PI;
  const light = [Math.sin(angle), 0, -Math.cos(angle)];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const nx = (i + 0.5 - size / 2) / radius;
      const ny = (j + 0.5 - size / 2) / radius;
      const d = nx * nx + ny * ny;
      if (d > 1) continue;
      const nz = Math.sqrt(1 - d);
      const facing = nx * light[0] + ny * light[1] + nz * light[2];
      const albedo = 0.78 - 0.3 * smooth(0.05, 0.4, fbm(nx * 2.2 + 3, ny * 2.2, seed % 13, 3));
      const lit = smooth(-0.04, 0.12, facing) * albedo;
      const k = (j * size + i) * 4;
      const edge = smooth(1, 0.94, d);
      image.data[k] = MOONLIGHT[0] * lit + 30 * (1 - lit);
      image.data[k + 1] = MOONLIGHT[1] * lit + 34 * (1 - lit);
      image.data[k + 2] = MOONLIGHT[2] * lit + 52 * (1 - lit);
      image.data[k + 3] = 255 * edge;
    }
  }
  return image;
}

// A cloud drawn once from noise, at half resolution: a flat base and a
// billowing top, lit from above and from the sun's side.
function cloudPixels(w: number, seed: number, p: Palette, side: number) {
  const sw = Math.ceil(w / 2);
  const sh = Math.ceil(w * 0.2);
  const image = new ImageData(sw, sh);
  for (let j = 0; j < sh; j++) {
    for (let i = 0; i < sw; i++) {
      const u = ((i + 0.5) / sw) * 2 - 1;
      const v = ((j + 0.5) / sh) * 2 - 1;
      const shape = 1 - u * u - (v > 0.25 ? ((v - 0.25) / 0.75) ** 2 * 3 : 0) - (v < 0 ? v * v * 1.1 : 0);
      const n = fbm(u * 2.6 + seed, v * 1.2, seed * 0.13, 5);
      // Thinned toward every edge, so no cloud is cut off by its canvas.
      const edge = clamp(Math.min(1 - Math.abs(u), 1 - Math.abs(v)) * 5);
      const density = clamp((shape * 0.8 + n * 0.9 - 0.15) * 2.4) * edge;
      if (density <= 0) continue;
      const c = mix(p.shade, p.lit, clamp(0.6 - 0.45 * v + 0.35 * n + 0.2 * u * side));
      const k = (j * sw + i) * 4;
      image.data[k] = c[0];
      image.data[k + 1] = c[1];
      image.data[k + 2] = c[2];
      image.data[k + 3] = 255 * density;
    }
  }
  return image;
}

// The Milky Way, at quarter resolution: a faint band from high on the left
// down to the horizon on the right, with dark lanes of dust along it.
function galaxyPixels(width: number, horizon: number, seed: number) {
  const gw = Math.ceil(width / 4);
  const gh = Math.ceil(horizon / 4);
  const image = new ImageData(gw, gh);
  const [ax, ay, bx, by] = [gw * 0.12, -gh * 0.1, gw * 0.9, gh * 1.1];
  const length = Math.hypot(bx - ax, by - ay);
  const spread = gh * 0.2;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const d = ((x - ax) * (by - ay) - (y - ay) * (bx - ax)) / length;
      const band = Math.exp(-((d / spread) ** 2));
      if (band < 0.02) continue;
      const n = fbm(x * 0.035, y * 0.035, seed % 97, 4);
      const dust = clamp(fbm(x * 0.07 + 3, y * 0.07, seed % 59, 4) * 2.4) * Math.exp(-((d / (spread * 0.4)) ** 2));
      const glow = band * clamp(0.5 + 0.7 * n) * (1 - 0.85 * dust);
      const c = mix([140, 152, 206], [230, 210, 190], clamp(0.5 + n));
      const k = (y * gw + x) * 4;
      image.data[k] = c[0];
      image.data[k + 1] = c[1];
      image.data[k + 2] = c[2];
      image.data[k + 3] = 255 * 0.24 * glow;
    }
  }
  return image;
}

export type Petal = { x: number; y: number; vx: number; vy: number; phase: number; color: string };

// The plain's colors from the horizon down to the foot of the page.
export const plainStops = (p: Palette): [number, RGB][] => [
  [0, mix(p.land, p.low, 0.32)],
  [0.35, mix(p.land, p.low, 0.08)],
  [1, mix(p.land, SOIL, 0.6)],
];

// Everything behind the tree: sky, light, weather and land.
export function paintBackdrop(ctx: Context2D, s: Scene, v: Reveal, t: number, land = true) {
  const { width: W, height: H, horizon, sky, night } = s;
  const p = sky.palette;
  // CSS pixels per canvas pixel: 1 or less normally, more in the pixel stage.
  const pixel = 1 / ctx.getTransform().a;
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = css(SOIL);
  ctx.fillRect(0, 0, W, H);

  if (v.sky > 0) {
    const gradient = ctx.createLinearGradient(0, 0, 0, horizon);
    gradient.addColorStop(0, css(p.top, v.sky));
    gradient.addColorStop(0.7, css(mix(p.top, p.low, 0.55), v.sky));
    gradient.addColorStop(1, css(p.low, v.sky));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, horizon);
    if (s.galaxy) {
      ctx.globalAlpha = v.sky * night;
      ctx.drawImage(s.galaxy, 0, 0, W, horizon);
      ctx.globalAlpha = 1;
    }
  }

  if (v.body > 0 && night > 0) {
    ctx.fillStyle = "#f4efe2";
    for (const star of s.stars) {
      const twinkle = 0.7 + 0.3 * Math.sin(t * star.rate + star.phase);
      const alpha = v.body * night * (0.25 + 0.75 * star.glow) * twinkle;
      // At least a pixel wide, so stars survive the pixel stage.
      const r = Math.max(pixel, 0.6 + 1.2 * star.glow);
      ctx.globalAlpha = alpha;
      ctx.fillRect(star.x - r / 2, star.y - r / 2, r, r);
      // The brightest glint.
      if (star.glow > 0.8 && pixel < 1.5) {
        const reach = 2 + 4 * star.glow;
        ctx.globalAlpha = alpha * 0.3;
        ctx.fillRect(star.x - reach, star.y - 0.3, reach * 2, 0.6);
        ctx.fillRect(star.x - 0.3, star.y - reach, 0.6, reach * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  // The sun or moon rises into place, and sets behind the horizon.
  const b = s.body;
  const y = b.y + (1 - v.body) * (horizon + b.radius - b.y);
  if (v.body > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, horizon);
    ctx.clip();
    const sun = sky.body === "sun";
    const tint = sun ? p.glow : ([150, 165, 200] as RGB);
    for (const [reach, strength] of sun ? [[9, 0.16], [3.5, 0.4]] : [[3.4, 0.16]]) {
      const glow = ctx.createRadialGradient(b.x, y, b.radius * 0.5, b.x, y, b.radius * reach);
      glow.addColorStop(0, css(tint, strength * v.body));
      glow.addColorStop(1, css(tint, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, horizon);
    }
    if (sun) {
      const r = b.radius * 0.7;
      const disc = ctx.createRadialGradient(b.x, y, 0, b.x, y, r);
      disc.addColorStop(0, css([255, 255, 250], v.body));
      disc.addColorStop(0.75, css(mix(p.sun, [255, 255, 250], 0.5), v.body));
      disc.addColorStop(1, css(p.sun, v.body));
      ctx.fillStyle = disc;
      ctx.beginPath();
      ctx.arc(b.x, y, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (s.moon) {
      ctx.globalAlpha = v.body;
      ctx.drawImage(s.moon, b.x - s.moon.width / 2, y - s.moon.height / 2);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  if (v.rays > 0 && sky.body === "sun" && night < 0.5) {
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 9; i++) {
      const angle = (i / 9) * Math.PI * 2 + t * 0.015;
      const reach = b.radius * (9 + 4 * hash(i, 4));
      const spread = 0.035 + 0.03 * hash(i, 9);
      const beam = ctx.createRadialGradient(b.x, b.y, b.radius, b.x, b.y, reach);
      beam.addColorStop(0, css(p.glow, 0.06 * v.rays * (1 - night)));
      beam.addColorStop(1, css(p.glow, 0));
      ctx.fillStyle = beam;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.arc(b.x, b.y, reach, angle - spread, angle + spread);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  if (v.clouds > 0) {
    ctx.globalAlpha = v.clouds * (1 - 0.55 * night);
    for (const cloud of s.clouds) {
      if (!cloud.sprite) continue;
      const span = W + cloud.w * 2;
      const x = ((((cloud.x + t * cloud.speed) % span) + span) % span) - cloud.w / 2;
      const [left, top, w, h] = [x - cloud.w / 2, cloud.y - cloud.w * 0.2, cloud.w, cloud.w * 0.4];
      // A cloud thins as it drifts behind the words, so they stay legible.
      let behind = 0;
      for (const box of s.words) {
        const across = Math.max(0, Math.min(left + w, box.right) - Math.max(left, box.left));
        const down = Math.max(0, Math.min(top + h, box.bottom) - Math.max(top, box.top));
        behind = Math.max(behind, (across * down) / (w * h));
      }
      ctx.globalAlpha = v.clouds * (1 - 0.55 * night) * (1 - 0.8 * smooth(0, 0.35, behind));
      ctx.drawImage(cloud.sprite, left, top, w, h);
    }
    ctx.globalAlpha = 1;
  }

  // Mist lies in the valleys, between the ranges and over the plain.
  const mist = (from: number, to: number, strength: number) => {
    if (v.mist <= 0) return;
    const drift = Math.sin(t * 0.05) * 0.1;
    const band = ctx.createLinearGradient(0, from, 0, to);
    band.addColorStop(0, css(p.low, 0));
    band.addColorStop(0.65 + drift, css(mix(p.low, p.lit, 0.15), strength * v.mist));
    band.addColorStop(1, css(p.low, strength * 0.4 * v.mist));
    ctx.fillStyle = band;
    ctx.fillRect(0, from, W, to - from);
  };

  if (land) {
    paintRidge(ctx, s, "back", mix(p.land, p.low, 0.74), v.far, pixel);
    paintRidge(ctx, s, "far", mix(p.land, p.low, 0.52), v.far, pixel);
    mist(horizon - s.ridge(W / 2, "far") * 1.2, horizon, 0.34);
    paintRidge(ctx, s, "near", mix(p.land, p.low, 0.22), v.near, pixel);
  }

  if (v.sky > 0) {
    const ground = ctx.createLinearGradient(0, horizon, 0, H);
    for (const [at, c] of plainStops(p)) ground.addColorStop(at, css(c, v.sky));
    ctx.fillStyle = ground;
    ctx.fillRect(0, horizon, W, H - horizon);
  }
  if (land) mist(horizon - s.ridge(W / 2, "near") * 0.8, horizon + 24, 0.22);

  if (v.horizon > 0 && v.sky < 1) {
    ctx.fillStyle = css(mix(SOIL, [141, 134, 118], 0.8), v.horizon * (1 - v.sky));
    const half = (W / 2) * v.horizon;
    ctx.fillRect(W / 2 - half, horizon, half * 2, 1);
  }

  if (v.birds > 0) paintFlyers(ctx, s, v.birds, t);
}

// A ridge's height above the horizon as painted: the nearest range is
// wooded, with rounded crowns of trees, each its own size.
export function ridgeLine(s: Scene, x: number, which: Ridge) {
  const h = s.ridge(x, which);
  if (which !== "near") return h;
  const grove = clamp(noise(x / 90, 4.4, s.seed % 71) * 1.8 + 0.25);
  const across = (((x % 7) + 7) % 7) / 3.5 - 1;
  return h + grove * (1.5 + 4 * Math.sqrt(1 - across * across) * (0.45 + 0.55 * hash(Math.floor(x / 7), 3)));
}

// A range of hills, hazier at its foot, its ridge line catching the light
// nearest the sun or moon.
// Each ridge's outline, traced once per scene and step.
const outlines = new WeakMap<Scene, Map<string, { top: Path2D; shape: Path2D; peak: number }>>();

function outline(s: Scene, which: Ridge, step: number) {
  const { width: W, horizon } = s;
  let traced = outlines.get(s);
  if (!traced) outlines.set(s, (traced = new Map()));
  const key = `${which} ${step}`;
  const known = traced.get(key);
  if (known) return known;
  const top = new Path2D();
  let peak = 0;
  for (let x = 0; x <= W + step; x += step) {
    const h = ridgeLine(s, x, which);
    peak = Math.max(peak, h);
    if (x === 0) top.moveTo(x, horizon - h);
    else top.lineTo(x, horizon - h);
  }
  const shape = new Path2D(top);
  shape.lineTo(W + step, horizon + 1);
  shape.lineTo(0, horizon + 1);
  shape.closePath();
  const made = { top, shape, peak };
  traced.set(key, made);
  return made;
}

function paintRidge(ctx: Context2D, s: Scene, which: Ridge, color: RGB, alpha: number, pixel: number) {
  if (alpha <= 0) return;
  const { width: W, horizon, body } = s;
  const p = s.sky.palette;
  const { top, shape, peak } = outline(s, which, Math.max(pixel, which === "near" ? 1.5 : 4));
  const fill = ctx.createLinearGradient(0, horizon - peak, 0, horizon);
  fill.addColorStop(0, css(color, alpha));
  fill.addColorStop(1, css(mix(color, p.low, 0.3), alpha));
  ctx.fillStyle = fill;
  ctx.fill(shape);
  const tint = s.sky.body === "sun" ? p.glow : ([150, 165, 200] as RGB);
  const rim = ctx.createLinearGradient(body.x - W * 0.45, 0, body.x + W * 0.45, 0);
  rim.addColorStop(0, css(tint, 0));
  // Coarse pixels would turn the line into a row of bright dots.
  rim.addColorStop(0.5, css(tint, (0.3 * alpha) / Math.max(1, pixel)));
  rim.addColorStop(1, css(tint, 0));
  ctx.strokeStyle = rim;
  ctx.lineWidth = Math.max(pixel, 1);
  ctx.stroke(top);
}

// A few birds cross the sky by day; fireflies drift over the grass at night.
export function paintFlyers(ctx: Context2D, s: Scene, alpha: number, t: number) {
  const { width: W, horizon, night } = s;
  if (night < 0.5) {
    ctx.strokeStyle = css(mix(s.sky.palette.land, SOIL, 0.3), alpha);
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 3; i++) {
      const span = W + 200;
      const x = ((t * (16 + 5 * i) + i * 260) % span) - 100;
      const y = horizon * (0.28 + 0.1 * i) + Math.sin(t * 0.7 + i) * 8;
      const flap = Math.sin(t * 6 + i * 2) * 4;
      const size = 6 + 2 * i;
      ctx.beginPath();
      ctx.moveTo(x - size, y - flap);
      ctx.quadraticCurveTo(x - size / 2, y - 2, x, y);
      ctx.quadraticCurveTo(x + size / 2, y - 2, x + size, y - flap);
      ctx.stroke();
    }
  } else {
    for (let i = 0; i < 14; i++) {
      const x = W * hash(i, 31) + Math.sin(t * 0.3 + i) * 30;
      const y = horizon + 10 + (s.height - horizon) * 0.5 * hash(i, 57) + Math.cos(t * 0.4 + i * 1.7) * 12;
      const blink = Math.max(0, Math.sin(t * (0.8 + hash(i, 3)) + i * 2.3));
      const g = ctx.createRadialGradient(x, y, 0, x, y, 7);
      g.addColorStop(0, `rgb(232 240 150 / ${alpha * blink})`);
      g.addColorStop(1, "rgb(232 240 150 / 0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - 7, y - 7, 14, 14);
    }
  }
}

export function paintPetals(ctx: Context2D, petals: Petal[], size: number) {
  for (const p of petals) {
    const turn = Math.sin(p.phase * 1.3);
    ctx.globalAlpha = 0.9 * clamp(p.y / 60);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, size * (0.25 + 0.2 * Math.abs(turn)), size * 0.18, p.phase, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
