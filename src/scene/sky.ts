import { smooth } from "./noise";

// The sky over the visitor, from their own clock: the sun's height, the
// light it gives, and the moon's phase.

export type RGB = [number, number, number];

export type Palette = {
  top: RGB; // sky overhead
  low: RGB; // sky at the horizon
  glow: RGB; // light around the sun
  sun: RGB;
  lit: RGB; // the sunny side of clouds
  shade: RGB; // their shadow side
  land: RGB; // the nearest silhouettes
};

// By the sun's elevation in degrees, from deep night to midday.
const SKIES: [number, Palette][] = [
  [-18, { top: [4, 5, 13], low: [14, 18, 38], glow: [44, 50, 90], sun: [255, 120, 60], lit: [52, 60, 98], shade: [22, 26, 46], land: [3, 4, 9] }],
  [-9, { top: [6, 8, 24], low: [34, 28, 68], glow: [136, 94, 176], sun: [255, 120, 60], lit: [140, 108, 180], shade: [44, 40, 82], land: [7, 7, 16] }],
  [-3, { top: [10, 10, 36], low: [90, 34, 64], glow: [255, 126, 104], sun: [255, 112, 72], lit: [255, 150, 136], shade: [86, 54, 118], land: [12, 8, 20] }],
  [2, { top: [16, 16, 50], low: [140, 54, 52], glow: [255, 194, 114], sun: [255, 184, 100], lit: [255, 190, 128], shade: [126, 74, 126], land: [14, 9, 22] }],
  [10, { top: [20, 42, 98], low: [176, 122, 96], glow: [255, 234, 186], sun: [255, 242, 204], lit: [255, 238, 212], shade: [160, 146, 172], land: [16, 18, 30] }],
  [30, { top: [14, 58, 132], low: [86, 150, 206], glow: [255, 252, 240], sun: [255, 252, 244], lit: [250, 252, 255], shade: [164, 186, 216], land: [12, 24, 40] }],
];

export const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

export const css = (c: RGB, alpha = 1) =>
  `rgb(${Math.round(c[0])} ${Math.round(c[1])} ${Math.round(c[2])} / ${alpha})`;

function paletteAt(elevation: number): Palette {
  const last = SKIES.length - 1;
  if (elevation <= SKIES[0][0]) return SKIES[0][1];
  if (elevation >= SKIES[last][0]) return SKIES[last][1];
  let i = 0;
  while (SKIES[i + 1][0] < elevation) i++;
  const [e0, a] = SKIES[i];
  const [e1, b] = SKIES[i + 1];
  const t = smooth(e0, e1, elevation);
  return {
    top: mix(a.top, b.top, t),
    low: mix(a.low, b.low, t),
    glow: mix(a.glow, b.glow, t),
    sun: mix(a.sun, b.sun, t),
    lit: mix(a.lit, b.lit, t),
    shade: mix(a.shade, b.shade, t),
    land: mix(a.land, b.land, t),
  };
}

const SYNODIC = 29.530588853; // days
const NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);

export type Sky = {
  palette: Palette;
  elevation: number; // the sun's, in degrees
  // Whichever of the sun or moon is up, by how far across the sky it has
  // come: 0 rising in the east, 1 setting in the west.
  body: "sun" | "moon";
  progress: number;
  phase: number; // the moon's: 0 new, 0.5 full
};

// A plain model rather than real astronomy: the sun rises at six and sets
// at six, and the moon has the night.
export function skyAt(date: Date): Sky {
  const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  const elevation = 60 * Math.sin(((hour - 6) / 24) * 2 * Math.PI);
  const sunUp = elevation > -4;
  const phase = ((((date.getTime() - NEW_MOON) / 864e5) % SYNODIC) + SYNODIC) % SYNODIC / SYNODIC;
  return {
    palette: paletteAt(elevation),
    elevation,
    body: sunUp ? "sun" : "moon",
    progress: sunUp ? (hour - 6) / 12 : (((hour - 18) % 24) + 24) % 24 / 12,
    phase,
  };
}
