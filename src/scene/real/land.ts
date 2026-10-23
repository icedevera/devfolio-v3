import * as THREE from "three";
import { random } from "../../scripts/canvas";
import { hillRings } from "../depth";
import { fbm, noise, smooth } from "../noise";
import type { Scene } from "../scene";
import { BUMP, patch } from "./glsl";
import { pause, slicer } from "../slices";

// The land: the bonsai stands on a flat boulder at the top of a grassy hill,
// which falls away to a valley; round it the picture's hills rise again,
// wooded, as far as the haze. The eye is a hand's breadth above the boulder,
// so the hillside's grass is always below it.

export type Land = {
  group: THREE.Group;
  restAt: (x: number, z: number) => number; // where something dropped would lie: on the boulder, or the hill
  heightAt: (x: number, z: number) => number;
  uniforms: { uTime: THREE.IUniform<number>; uGrassWind: THREE.IUniform<number> };
  dispose: () => void;
};

type Options = { distance: number; groundY: number; center: number; reach: number; grass: number };

// three's computeVertexNormals, a stretch at a time: each face's normal,
// weighted by its area, summed at its corners, then made unit length.
async function normals(p: Float32Array, index: Uint32Array, slice: () => Promise<void>) {
  const n = new Float32Array(p.length);
  for (let f = 0; f < index.length; f += 3) {
    const a = index[f] * 3;
    const b = index[f + 1] * 3;
    const c = index[f + 2] * 3;
    const cbx = p[c] - p[b];
    const cby = p[c + 1] - p[b + 1];
    const cbz = p[c + 2] - p[b + 2];
    const abx = p[a] - p[b];
    const aby = p[a + 1] - p[b + 1];
    const abz = p[a + 2] - p[b + 2];
    const x = cby * abz - cbz * aby;
    const y = cbz * abx - cbx * abz;
    const z = cbx * aby - cby * abx;
    n[a] += x;
    n[a + 1] += y;
    n[a + 2] += z;
    n[b] += x;
    n[b + 1] += y;
    n[b + 2] += z;
    n[c] += x;
    n[c + 1] += y;
    n[c + 2] += z;
    if (f % 6144 === 0) await slice();
  }
  for (let i = 0; i < n.length; i += 3) {
    const scale = 1 / (Math.sqrt(n[i] * n[i] + n[i + 1] * n[i + 1] + n[i + 2] * n[i + 2]) || 1);
    n[i] *= scale;
    n[i + 1] *= scale;
    n[i + 2] *= scale;
  }
  return n;
}

export async function createLand(s: Scene, o: Options): Promise<Land> {
  const { distance: D, groundY, center } = o;
  const rand = random(s.seed ^ 0x1a4d);
  const group = new THREE.Group();
  const disposables: { dispose: () => void }[] = [];
  const own = <T extends { dispose: () => void }>(item: T) => {
    disposables.push(item);
    return item;
  };
  const uniforms = { uTime: { value: 0 }, uGrassWind: { value: 0.6 } };

  // The boulder's flat top, `rock` from the pot; past it the hill falls
  // `drop` to the valley floor.
  const rock = Math.max(o.reach * 0.75, D * 0.36);
  const drop = D * 0.42;
  const floor = groundY - drop;
  const rings = hillRings(s);
  const seed = s.seed % 997;
  // Where woods grow, from 0 to 1.
  const forest = (x: number, z: number) => smooth(0.02, 0.22, fbm(x / 2200, z / 2200, seed, 4));

  // The summit: under the boulder, then the hillside down to the floor,
  // rolling a little.
  const hillside = (x: number, z: number) => {
    const fall = smooth(rock * 0.92, rock + D * 0.8, Math.hypot(x - center, z));
    return groundY - 24 - (drop - 24) * fall + fall * D * 0.035 * fbm(x / 900, z / 900, seed + 3, 3);
  };
  // The higher of two heights, rounded where they meet.
  const smax = (a: number, b: number, k: number) => {
    const h = Math.max(k - Math.abs(a - b), 0) / k;
    return Math.max(a, b) + h * h * k * 0.25;
  };
  // Each ring's crest round the circle, worked out once.
  const slice = slicer();
  const ANGLES = 1024;
  const crests = rings.map(() => new Float32Array(ANGLES + 1));
  for (const [k, ring] of rings.entries()) {
    for (let i = 0; i <= ANGLES; i++) {
      crests[k][i] = groundY + ring.height(-Math.PI + (i / ANGLES) * Math.PI * 2);
      if ((i & 15) === 15) await slice();
    }
  }
  const heightAt = (x: number, z: number) => {
    let y = hillside(x, z);
    const r = Math.hypot(x, z);
    const u = ((Math.atan2(x, -z) + Math.PI) / (Math.PI * 2)) * ANGLES;
    const i = Math.min(ANGLES - 1, Math.floor(u));
    rings.forEach((ring, k) => {
      const inner = ring.R * 0.32;
      const outer = ring.R * 0.5;
      const t = r < ring.R ? smooth(ring.R - inner, ring.R, r) : smooth(ring.R + outer, ring.R, r);
      if (t <= 0) return;
      // Each ring of hills rises from the floor to the picture's ridge.
      const crest = crests[k][i] + (crests[k][i + 1] - crests[k][i]) * (u - i);
      const lumpy = 1 + 0.06 * noise(x / 700, z / 700, seed + 5) * (1 - t);
      y = smax(y, floor + (crest - floor) * Math.pow(t, 1.25) * lumpy, 80);
    });
    return y;
  };

  // The terrain: a disc of rings round the tree, finer near it.
  const RADII = 180;
  const reachOut = D * 7;
  const positions = new Float32Array((RADII + 1) * ANGLES * 3);
  const woods = new Float32Array((RADII + 1) * ANGLES);
  for (let j = 0; j <= RADII; j++) {
    const r = reachOut * Math.pow(j / RADII, 1.8);
    for (let i = 0; i < ANGLES; i++) {
      const a = (i / ANGLES) * Math.PI * 2;
      const x = Math.sin(a) * r;
      const z = -Math.cos(a) * r;
      const k = j * ANGLES + i;
      positions[k * 3] = x;
      positions[k * 3 + 1] = heightAt(x, z);
      positions[k * 3 + 2] = z;
      // Woods on the hills, not on the hilltop by the tree.
      woods[k] = forest(x, z) * smooth(D * 1.3, D * 1.9, r);
    }
    await slice();
  }
  const indices = new Uint32Array(RADII * ANGLES * 6);
  for (let j = 0; j < RADII; j++) {
    for (let i = 0; i < ANGLES; i++) {
      const a = j * ANGLES + i;
      const b = j * ANGLES + ((i + 1) % ANGLES);
      const quad = a * 6;
      indices[quad] = a;
      indices[quad + 1] = b;
      indices[quad + 2] = a + ANGLES;
      indices[quad + 3] = b;
      indices[quad + 4] = b + ANGLES;
      indices[quad + 5] = a + ANGLES;
    }
    await slice();
  }
  const terrainGeometry = own(new THREE.BufferGeometry());
  terrainGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  terrainGeometry.setAttribute("aForest", new THREE.BufferAttribute(woods, 1));
  terrainGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
  terrainGeometry.setAttribute("normal", new THREE.BufferAttribute(await normals(positions, indices, slice), 3));
  await pause();

  const terrainMaterial = own(
    patch(new THREE.MeshStandardMaterial({ roughness: 0.95 }), "terrain", {
      uniforms: { uFloor: { value: floor }, uNear: { value: D * 1.6 } },
      vertexHead: "attribute float aForest;\nvarying float vForest;",
      position: "vForest = aForest;",
      fragmentHead: `varying float vForest;\nuniform float uFloor;\nuniform float uNear;\n${BUMP}`,
      color: /* glsl */ `
        vec3 up = inverseTransformDirection(normalize(vNormal), viewMatrix);
        vec2 p = vWorld.xz;
        float tone = fbm(p * 0.004, 4);
        vec3 meadow = mix(vec3(0.07, 0.11, 0.03), vec3(0.17, 0.21, 0.06), tone);
        meadow = mix(meadow, vec3(0.3, 0.26, 0.12), smoothstep(0.55, 0.72, fbm(p * 0.0012 + 3.0, 4)) * 0.7);
        float canopy = fbm(p * 0.03, 4);
        vec3 woods = mix(vec3(0.012, 0.03, 0.012), vec3(0.05, 0.08, 0.03), canopy);
        vec3 ground = mix(meadow, woods, smoothstep(0.35, 0.65, vForest + (canopy - 0.5) * 0.4));
        float steep = 1.0 - smoothstep(0.6, 0.82, up.y);
        ground = mix(ground, vec3(0.2, 0.19, 0.17) * (0.7 + 0.6 * tone), steep * 0.8);
        // Under the hillside's grass, dark earth among the roots.
        float near = 1.0 - smoothstep(uNear * 0.7, uNear, length(vWorld.xz));
        ground = mix(ground, vec3(0.035, 0.045, 0.018), near * 0.75);
        diffuseColor.rgb = ground;`,
      normalMap: /* glsl */ `
        {
          vec3 p = vWorld;
          vec3 px = p + dFdx(vWorld);
          vec3 py = p + dFdy(vWorld);
          float k = 0.012;
          normal = bumped(normal, fbm(p.xz * k, 3) * 16.0, fbm(px.xz * k, 3) * 16.0, fbm(py.xz * k, 3) * 16.0);
        }`,
    }),
  );
  const terrain = new THREE.Mesh(terrainGeometry, terrainMaterial);
  terrain.receiveShadow = true;
  group.add(terrain);

  // The boulder's top: level under the pot, gently rolling further out.
  const crest = (x: number, z: number) => {
    const r = Math.hypot(x, z);
    return (6 * noise(x / 160, z / 160, seed + 11) + 2.5 * noise(x / 45, z / 45, seed + 13)) * smooth(rock * 0.4, rock * 0.85, r);
  };

  // The boulder: a squashed, lumpy stone, sliced flat on top.
  const boulderGeometry = own(new THREE.SphereGeometry(1, 160, 64));
  const bp = boulderGeometry.getAttribute("position");
  const tall = 70;
  for (let i = 0; i < bp.count; i++) {
    if ((i & 511) === 0) await slice();
    const x = bp.getX(i);
    const y = bp.getY(i);
    const z = bp.getZ(i);
    const a = Math.atan2(z, x);
    const lump = 1 + 0.13 * noise(Math.cos(a) * 1.7, Math.sin(a) * 1.7, seed + 9) + 0.04 * noise(x * 6, y * 6, z * 6);
    const px = x * rock * 1.12 * lump;
    const pz = z * rock * 0.92 * lump;
    let py = (y * 0.5 - 0.5) * tall * 2 + tall * 0.55;
    // Flat on top, and worn: the edge rolls off, the top barely undulates.
    py = Math.min(py, crest(px, pz));
    bp.setXYZ(i, px + center, groundY + py, pz);
  }
  boulderGeometry.computeVertexNormals();
  const stone = own(
    patch(new THREE.MeshStandardMaterial({ roughness: 0.82 }), "stone", {
      fragmentHead: /* glsl */ `${BUMP}
        // Weathered stone, split here and there by wandering cracks.
        float crackAt(vec3 p) {
          vec3 id;
          vec3 warp = vec3(vnoise(p * 0.004), vnoise(p * 0.004 + 5.0), vnoise(p * 0.004 + 9.0)) - 0.5;
          vec2 c = cells(p * 0.01 + warp * 1.4, id);
          return (1.0 - smoothstep(0.0, 0.04, c.y - c.x)) * smoothstep(0.45, 0.62, vnoise(p * 0.006 + 2.0));
        }
        float stoneHeight(vec3 p) {
          return fbm(p * 0.05, 4) * 6.0 + fbm(p * 0.6, 3) * 0.8 - crackAt(p) * 3.0;
        }`,
      color: /* glsl */ `
        vec3 up = inverseTransformDirection(normalize(vNormal), viewMatrix);
        vec3 p = vWorld;
        // Granite: a grey grain of dark and pale crystals.
        float crystal = vnoise(p * 0.45);
        vec3 rockColor = vec3(0.34, 0.31, 0.28) * (0.8 + 0.4 * fbm(p * 0.01, 4));
        // Broad patches, darker where water lies, paler where it dries.
        rockColor *= 0.72 + 0.56 * fbm(p * 0.0035 + 7.0, 3);
        rockColor = mix(rockColor, vec3(0.08, 0.075, 0.07), step(0.78, crystal) * 0.8);
        rockColor = mix(rockColor, vec3(0.55, 0.53, 0.5), step(crystal, 0.12) * 0.6);
        // Rain streaks down the sides.
        float streak = fbm(vec2(p.x * 0.05 + p.z * 0.05, p.y * 0.004), 3);
        rockColor *= 1.0 - 0.35 * smoothstep(0.5, 0.75, streak) * (1.0 - up.y);
        // Lichen: pale green rosettes, the odd orange one, where rain sits.
        vec3 lid;
        vec2 colony = cells(p * 0.018, lid);
        float patchy = (1.0 - smoothstep(0.3, 0.42, colony.x + 0.12 * fbm(p * 0.08, 3))) * step(0.3, hash13(lid));
        vec3 lichen = hash13(lid + 3.0) > 0.85 ? vec3(0.55, 0.3, 0.08) : vec3(0.44, 0.47, 0.36);
        rockColor = mix(rockColor, lichen * (0.8 + 0.3 * fbm(p * 0.3, 2)), patchy * 0.85);
        // The cracks, dark, and moss in them.
        float crack = crackAt(p);
        rockColor *= 1.0 - 0.55 * crack;
        rockColor = mix(rockColor, vec3(0.05, 0.08, 0.02), crack * smoothstep(0.35, 0.6, fbm(p * 0.03, 3)) * max(up.y, 0.0));
        // Moss where the stone meets the hill.
        float low = 1.0 - smoothstep(${(groundY - 70).toFixed(1)}, ${(groundY - 30).toFixed(1)}, p.y);
        float moss = low * smoothstep(0.35, 0.6, fbm(p * 0.02, 4) + 0.3 * up.y);
        rockColor = mix(rockColor, vec3(0.06, 0.1, 0.02) * (0.7 + 0.6 * fbm(p * 0.4, 3)), moss);
        diffuseColor.rgb = rockColor;`,
      normalMap: /* glsl */ `
        {
          vec3 p = vWorld;
          vec3 px = p + dFdx(vWorld);
          vec3 py = p + dFdy(vWorld);
          normal = bumped(normal, stoneHeight(p), stoneHeight(px), stoneHeight(py));
        }`,
    }),
  );
  const boulder = new THREE.Mesh(boulderGeometry, stone);
  boulder.castShadow = true;
  boulder.receiveShadow = true;
  group.add(boulder);

  // A few stones on the hillside.
  const pebbleGeometry = own(new THREE.IcosahedronGeometry(1, 3));
  const pp = pebbleGeometry.getAttribute("position");
  for (let i = 0; i < pp.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pp, i);
    v.multiplyScalar(1 + 0.22 * noise(v.x * 1.8, v.y * 1.8, v.z * 1.8 + 4));
    pp.setXYZ(i, v.x, v.y * 0.6, v.z);
  }
  pebbleGeometry.computeVertexNormals();
  const stones = new THREE.InstancedMesh(pebbleGeometry, stone, 70);
  const matrix = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  for (let i = 0; i < stones.count; i++) {
    const a = rand() * Math.PI * 2;
    const r = rock * 1.05 + D * 0.9 * rand() ** 1.5;
    const x = center + Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const size = 8 + 40 * rand() ** 3;
    e.set(rand() * 0.6, rand() * Math.PI * 2, rand() * 0.6);
    matrix.compose(v.set(x, heightAt(x, z) + size * 0.15, z), q.setFromEuler(e), sc.set(size * (1 + rand()), size, size * (1 + rand())));
    stones.setMatrixAt(i, matrix);
  }
  stones.castShadow = true;
  stones.receiveShadow = true;
  group.add(stones);

  await pause();

  // Grass: blades in tufts on the hillside, thick near the boulder, thinner
  // further down, leaning and swaying in the wind.
  const blade = own(new THREE.InstancedBufferGeometry());
  const levels = 5;
  const bladePositions: number[] = [];
  for (let k = 0; k < levels; k++) bladePositions.push(-0.5, k / levels, 0, 0.5, k / levels, 0);
  bladePositions.push(0, 1, 0);
  const bladeIndex: number[] = [];
  for (let k = 0; k < levels - 1; k++) {
    const a = k * 2;
    bladeIndex.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  bladeIndex.push((levels - 1) * 2, (levels - 1) * 2 + 1, levels * 2);
  blade.setAttribute("position", new THREE.Float32BufferAttribute(bladePositions, 3));
  blade.setAttribute("normal", new THREE.Float32BufferAttribute(bladePositions.map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
  blade.setIndex(bladeIndex);
  const roots = new Float32Array(o.grass * 4);
  const looks = new Float32Array(o.grass * 4);
  let placed = 0;
  while (placed < o.grass) {
    await slice();
    const a = rand() * Math.PI * 2;
    const r = rock * 0.98 + (D * 1.45 - rock) * rand() ** 1.7;
    const cx = center + Math.cos(a) * r;
    const cz = Math.sin(a) * r;
    const far = smooth(D * 0.7, D * 1.5, r);
    const tuft = 3 + Math.floor(rand() * 6);
    const dry = rand() < 0.2 ? 0.6 + 0.4 * rand() : rand() * 0.4;
    for (let k = 0; k < tuft && placed < o.grass; k++, placed++) {
      const x = cx + (rand() - 0.5) * 9;
      const z = cz + (rand() - 0.5) * 9;
      roots.set([x, hillside(x, z) - 1, z, rand() * Math.PI * 2], placed * 4);
      looks.set([(20 + 30 * rand()) * (1 + 0.5 * far), (2 + 1.6 * rand()) * (1 + 1.6 * far), 0.1 + 0.4 * rand(), Math.min(1, dry + 0.15 * rand())], placed * 4);
    }
  }
  blade.setAttribute("aRoot", new THREE.InstancedBufferAttribute(roots, 4));
  blade.setAttribute("aBlade", new THREE.InstancedBufferAttribute(looks, 4));
  blade.instanceCount = o.grass;
  const grassMaterial = own(
    patch(new THREE.MeshStandardMaterial({ roughness: 0.55, side: THREE.DoubleSide }), "grass", {
      uniforms,
      through: new THREE.Vector3(0.9, 1.05, 0.4),
      vertexHead: /* glsl */ `
        attribute vec4 aRoot;
        attribute vec4 aBlade;
        uniform float uTime;
        uniform float uGrassWind;
        varying vec2 vBlade;`,
      normal: /* glsl */ `
        vec3 bladePos;
        {
          float t = position.y;
          vec2 windDir = normalize(vec2(1.0, 0.35));
          float gust = vnoise(aRoot.xz * 0.0011 - windDir * uTime * 0.45);
          float lean = aBlade.z + uGrassWind * (0.12 + 0.5 * gust) + 0.05 * sin(uTime * 2.6 + aRoot.w * 7.0);
          vec3 facing = vec3(cos(aRoot.w), 0.0, sin(aRoot.w));
          vec3 bend = normalize(mix(facing, vec3(windDir.x, 0.0, windDir.y), clamp(uGrassWind * gust, 0.0, 0.8)));
          vec3 across = normalize(cross(vec3(0.0, 1.0, 0.0), facing));
          float h = aBlade.x;
          vec3 spine = vec3(0.0, h * t * (1.0 - 0.35 * lean * t), 0.0) + bend * (h * lean * t * t);
          vec3 tangent = normalize(vec3(0.0, h * (1.0 - 0.7 * lean * t), 0.0) + bend * (2.0 * h * lean * t));
          float w = aBlade.y * (1.0 - pow(t, 1.4));
          bladePos = aRoot.xyz + spine + across * position.x * w;
          objectNormal = normalize(mix(normalize(cross(across, tangent)), vec3(0.0, 1.0, 0.0), 0.35));
          vBlade = vec2(t, aBlade.w);
        }`,
      position: "transformed = bladePos;",
      fragmentHead: "varying vec2 vBlade;",
      color: /* glsl */ `
        float t = vBlade.x;
        vec3 base = vec3(0.02, 0.03, 0.01);
        vec3 mid = mix(vec3(0.07, 0.14, 0.03), vec3(0.2, 0.2, 0.07), vBlade.y);
        vec3 tip = mix(vec3(0.2, 0.28, 0.08), vec3(0.42, 0.36, 0.16), vBlade.y);
        diffuseColor.rgb = t < 0.45 ? mix(base, mid, t / 0.45) : mix(mid, tip, (t - 0.45) / 0.55);`,
    }),
  );
  const grass = new THREE.Mesh(blade, grassMaterial);
  grass.frustumCulled = false;
  grass.receiveShadow = true;
  group.add(grass);

  await pause();

  // Woods on the hills: lumpy crowns crowded where the woods are, sized so
  // they read alike near and far.
  const crowns: THREE.Matrix4[] = [];
  const tints: THREE.Color[] = [];
  for (const ring of rings) {
    for (let n = 0; n < 9000; n++) {
      if ((n & 255) === 0) await slice();
      const a = rand() * Math.PI * 2 - Math.PI;
      const r = ring.R * (0.7 + 0.45 * rand());
      const x = Math.sin(a) * r;
      const z = -Math.cos(a) * r;
      if (forest(x, z) < 0.45 + 0.4 * rand()) continue;
      const size = (6 + 8 * rand()) * ((r + D) / (D * 3));
      e.set(0, rand() * Math.PI, 0);
      crowns.push(new THREE.Matrix4().compose(v.set(x, heightAt(x, z) + size * 0.7, z), q.setFromEuler(e), sc.set(size, size * (1.1 + 0.6 * rand()), size)));
      tints.push(new THREE.Color().setRGB(0.025 + 0.03 * rand(), 0.05 + 0.04 * rand(), 0.018 + 0.015 * rand()));
    }
  }
  const crownGeometry = own(new THREE.IcosahedronGeometry(1, 1));
  const cp = crownGeometry.getAttribute("position");
  for (let i = 0; i < cp.count; i++) {
    v.fromBufferAttribute(cp, i);
    v.multiplyScalar(1 + 0.3 * noise(v.x * 2.1, v.y * 2.1, v.z * 2.1 + 3));
    cp.setXYZ(i, v.x, v.y, v.z);
  }
  crownGeometry.computeVertexNormals();
  const crownMaterial = own(
    patch(new THREE.MeshStandardMaterial({ roughness: 0.9 }), "crowns", {
      fragmentHead: BUMP,
      color: "diffuseColor.rgb *= 0.55 + 0.9 * vnoise(vWorld * 0.35);",
      normalMap: /* glsl */ `
        {
          vec3 px = vWorld + dFdx(vWorld);
          vec3 py = vWorld + dFdy(vWorld);
          normal = bumped(normal, vnoise(vWorld * 0.35) * 3.0, vnoise(px * 0.35) * 3.0, vnoise(py * 0.35) * 3.0);
        }`,
    }),
  );
  const woods3d = new THREE.InstancedMesh(crownGeometry, crownMaterial, Math.max(1, crowns.length));
  crowns.forEach((m, i) => {
    woods3d.setMatrixAt(i, m);
    woods3d.setColorAt(i, tints[i]);
  });
  woods3d.count = crowns.length;
  group.add(woods3d);

  return {
    group,
    restAt: (x, z) => {
      const from = Math.hypot(x - center, z);
      return from < rock * 0.9 ? groundY + crest(x - center, z) : heightAt(x, z);
    },
    heightAt,
    uniforms,
    dispose() {
      for (const item of disposables) item.dispose();
      stones.dispose();
      woods3d.dispose();
    },
  };
}
