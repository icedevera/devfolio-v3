import { hash } from "./noise";
import type { Reveal, Scene } from "./scene";
import { cellX } from "./tree";
import { css, mix, type RGB } from "./sky";

// The first stage: the landscape in characters, on the tree's own grid.

const RAMP = " .:-=+*#%@";
const FAR: RGB = [74, 80, 98];
const NEAR: RGB = [104, 100, 88];
const HORIZON: RGB = [120, 114, 100];

export type Glyph = { char: string; color: string };

export const cellKey = (c: number, r: number) => (r + 2048) * 8192 + c + 4096;

// Fills `cells` with the backdrop's characters; later layers cover earlier
// ones.
export function asciiBackdrop(cells: Map<number, Glyph>, s: Scene, v: Reveal, t: number) {
  const l = s.layout;
  const { cw, ch } = l;
  const c0 = Math.floor(-l.x / cw) - 1;
  const c1 = Math.ceil((s.width - l.x) / cw);
  const row = (y: number) => Math.floor((y - l.y) / ch);
  const set = (c: number, r: number, char: string, color: string) => cells.set(cellKey(c, r), { char, color });
  const p = s.sky.palette;

  // Stars come out with the moon. Clouds wait for the pixels.
  if (v.body > 0 && s.night > 0.3) {
    for (const star of s.stars) {
      const twinkle = 0.65 + 0.35 * Math.sin(t * star.rate + star.phase);
      const alpha = v.body * s.night * (0.3 + 0.7 * star.glow) * twinkle;
      const char = star.glow > 0.6 ? "*" : star.glow > 0.25 ? "+" : ".";
      set(Math.floor((star.x - l.x) / cw), row(star.y), char, `rgb(240 235 220 / ${alpha})`);
    }
  }

  // The sun or moon rises, and sets behind the horizon.
  const horizonRow = row(s.horizon);
  if (v.body > 0) {
    const b = s.body;
    const by = b.y + (1 - v.body) * (s.horizon + b.radius - b.y);
    const reach = b.radius * 1.8;
    const angle = s.sky.phase * 2 * Math.PI;
    for (let r = row(by - reach); r <= Math.min(row(by + reach), horizonRow - 1); r++) {
      for (let c = Math.floor((b.x - reach - l.x) / cw); c <= Math.ceil((b.x + reach - l.x) / cw); c++) {
        const dx = (cellX(l, c) - b.x) / b.radius;
        const dy = (l.y + (r + 0.5) * ch - by) / b.radius;
        const d = Math.hypot(dx, dy);
        if (d < 1) {
          let k = 1 - d * d * 0.6;
          let color = css(s.sky.body === "sun" ? p.sun : [239, 232, 214]);
          if (s.sky.body === "moon") {
            const nz = Math.sqrt(1 - d * d);
            const facing = dx * Math.sin(angle) - nz * Math.cos(angle);
            k = facing > 0 ? 0.35 + 0.65 * facing : 0.12;
            if (facing <= 0) color = "rgb(120 128 150 / 0.45)";
          }
          set(c, r, RAMP[Math.max(1, Math.round(k * (RAMP.length - 1)))], color);
        } else if (d < 1.8 && hash(c, r, 7) < ((1.8 - d) / 0.8) * 0.5) {
          set(c, r, d < 1.3 ? ":" : ".", css(s.sky.body === "sun" ? p.glow : [150, 165, 200], 0.6 * v.body));
        }
      }
    }
  }

  // The mountains draw themselves in, column by column.
  for (const [which, color, alpha] of [
    ["far", FAR, v.far],
    ["near", NEAR, v.near],
  ] as const) {
    if (alpha <= 0) continue;
    for (let c = c0; c <= c1; c++) {
      if (hash(c, which === "far" ? 11 : 13) > alpha) continue;
      const x = cellX(l, c);
      const top = row(s.horizon - s.ridge(x, which));
      const before = row(s.horizon - s.ridge(x - cw, which));
      const after = row(s.horizon - s.ridge(x + cw, which));
      // Rows count down the screen, so a smaller row is higher.
      const char = after < top && before >= top ? "/" : before < top && after >= top ? "\\" : before > top && after > top ? "^" : "_";
      set(c, top, char, css(color));
      for (let r = top + 1; r < horizonRow; r++) {
        const fill = which === "far" ? 0.12 : 0.22;
        if (hash(c, r, which === "far" ? 3 : 5) < fill) set(c, r, which === "far" ? "." : ":", css(color, 0.55));
      }
    }
  }

  if (v.horizon > 0) {
    const middle = Math.round((s.width / 2 - l.x) / cw);
    const half = ((c1 - c0) / 2) * v.horizon;
    for (let c = c0; c <= c1; c++) {
      if (Math.abs(c - middle) <= half) set(c, horizonRow, "_", css(mix(HORIZON, [22, 20, 17], 0.2)));
    }
  }
}
