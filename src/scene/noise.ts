// Seeded hashing and gradient noise, for the landscape behind the tree.

export function hash(x: number, y: number, z = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const GRADIENTS = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

function corner(ix: number, iy: number, iz: number, x: number, y: number, z: number) {
  const g = GRADIENTS[Math.floor(hash(ix, iy, iz) * 12)];
  return g[0] * x + g[1] * y + g[2] * z;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// Perlin gradient noise, roughly in [-1, 1].
export function noise(x: number, y: number, z = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const u = fade(fx);
  const v = fade(fy);
  const w = fade(fz);
  const c = (dx: number, dy: number, dz: number) =>
    corner(ix + dx, iy + dy, iz + dz, fx - dx, fy - dy, fz - dz);
  return mix(
    mix(mix(c(0, 0, 0), c(1, 0, 0), u), mix(c(0, 1, 0), c(1, 1, 0), u), v),
    mix(mix(c(0, 0, 1), c(1, 0, 1), u), mix(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

// Layered noise, roughly in [-1, 1].
export function fbm(x: number, y: number, z = 0, octaves = 4) {
  let sum = 0;
  let amplitude = 0.5;
  let total = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * noise(x, y, z);
    total += amplitude;
    x *= 2;
    y *= 2;
    z *= 2;
    amplitude *= 0.5;
  }
  return sum / total;
}

export const smooth = (edge0: number, edge1: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
