import * as THREE from "three";
import { random } from "../../scripts/canvas";
import { color, framing } from "../depth";
import { noise } from "../noise";
import type { Petal, Scene } from "../scene";
import { mix, type RGB } from "../sky";
import { BLOSSOM, LEAF, ramp, resample, type Joint } from "../tree";
import { BUMP, patch, WIND, type Hooks } from "./glsl";
import { slicer } from "../slices";

// The tree, as a cherry is: bark ringed with lenticels and furrowed where it
// is old, limbs that swell where they meet, and at every leaf of the picture a
// spray of twigs carrying leaves, or blossom, five notched petals round a red
// heart. Leaves and petals let the light through, flutter, and sway with the
// tree.

export type Wind = {
  uTime: THREE.IUniform<number>;
  uWind: THREE.IUniform<number>;
  uFlutter: THREE.IUniform<number>;
  uRoot: THREE.IUniform<THREE.Vector3>;
  uCrown: THREE.IUniform<number>;
};

export type Plant = {
  group: THREE.Group;
  fall: (petals: Petal[]) => void; // places the petals falling now
  dispose: () => void;
};

const PETALS = 64;

// The shapes, as signed distances in the blade's own units: positive inside.
const SHAPES = /* glsl */ `
float leafEdge(vec2 uv) {
  float u = uv.x;
  float v = uv.y - 0.5;
  float stalk = 0.07;
  float k = clamp((u - stalk) / (1.0 - stalk), 0.0, 1.0);
  float half_ = 0.5 * pow(sin(3.14159 * pow(k, 0.8)), 0.85) * (1.0 - 0.25 * k * k);
  half_ *= 1.0 - 0.08 * (1.0 - fract(k * 22.0)) * smoothstep(0.05, 0.25, k);
  half_ = u < stalk ? 0.035 : half_;
  return min(half_ - abs(v), min(u, 1.0 - u));
}
float petalEdge(vec2 uv) {
  if (uv.x > 2.5) return 1.05 - length(vec2(uv.x - 4.0, uv.y));
  float u = uv.x;
  float v = uv.y - 0.5;
  // Narrow at its claw, widest two thirds out, rounding to a notched tip.
  float cap = max(u - 0.72, 0.0) / 0.28;
  float half_ = 0.47 * pow(clamp(u / 0.72, 0.0, 1.0), 0.45) * sqrt(max(0.0, 1.0 - cap * cap));
  float notch = 0.1 * (1.0 - smoothstep(0.0, 0.15, abs(v)));
  return min(half_ - abs(v), 1.0 - notch - u);
}
`;

// Sway and flutter for instanced blades: the blade lifts and twists about
// its stalk, and the whole tree carries it with it.
const FLUTTER = /* glsl */ `
  vLeaf = uv;
  vec3 origin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vSeed = hash13(origin * 0.37);
  float flutter = sin(uTime * (4.0 + 3.0 * vSeed) + vSeed * 40.0) + 0.5 * sin(uTime * (9.0 + 5.0 * vSeed) + vSeed * 11.0);
  transformed.z += flutter * uFlutter * position.x;
  transformed += inverse(mat3(instanceMatrix)) * sway(origin);
`;

export async function createPlant(s: Scene, wind: Wind, restAt: (x: number, z: number) => number): Promise<Plant> {
  const slice = slicer();
  const { layout: l, skeleton } = s;
  const { cw } = l;
  const { distance, at } = framing(s);
  const rand = random(s.seed ^ 0x7ee5);
  const group = new THREE.Group();
  const disposables: { dispose: () => void }[] = [];
  const own = <T extends { dispose: () => void }>(item: T) => {
    disposables.push(item);
    return item;
  };
  const up = new THREE.Vector3(0, 1, 0);
  const unit = () => new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();

  // Wood: every limb, root and twig as a tube, in one mesh.
  const positions: number[] = [];
  const normals: number[] = [];
  const barks: number[] = [];
  const indices: number[] = [];
  const tube = (points: THREE.Vector3[], radii: number[], sides: number, flare: number, gnarl: number) => {
    if (points.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(points);
    const segments = Math.max(2, points.length - 1);
    const frames = curve.computeFrenetFrames(segments, false);
    const first = positions.length / 3;
    const offset = rand() * 50;
    let along = 0;
    let previous = curve.getPointAt(0);
    for (let j = 0; j <= segments; j++) {
      const u = j / segments;
      const middle = curve.getPointAt(u);
      along += middle.distanceTo(previous);
      previous = middle;
      const x = u * (radii.length - 1);
      const k = Math.min(radii.length - 2, Math.floor(x));
      let r = radii[k] + (radii[k + 1] - radii[k]) * (x - k);
      r *= 1 + flare * Math.exp(-along / (radii[0] * 2.2));
      for (let side = 0; side <= sides; side++) {
        const angle = (side / sides) * Math.PI * 2;
        const c = Math.cos(angle);
        const sn = Math.sin(angle);
        const lump = 1 + gnarl * noise(c * 1.4, sn * 1.4, along * 0.035 + offset);
        const n = frames.normals[j].clone().multiplyScalar(c).addScaledVector(frames.binormals[j], sn);
        positions.push(middle.x + r * lump * n.x, middle.y + r * lump * n.y, middle.z + r * lump * n.z);
        normals.push(n.x, n.y, n.z);
        barks.push(c, sn, along, r);
      }
    }
    for (let j = 0; j < segments; j++) {
      for (let side = 0; side < sides; side++) {
        const a = first + j * (sides + 1) + side;
        indices.push(a, a + 1, a + sides + 1, a + 1, a + sides + 2, a + sides + 1);
      }
    }
  };
  // A limb of the picture, its radius shrunk as it comes nearer, as `at`
  // shrinks its place, and tapering a little toward its tip even where no
  // branch leaves it, as wood does.
  const limb = (joints: Joint[], flare: number, gnarl: number) => {
    if (joints.length < 2) return;
    const path = resample(joints, 3);
    const points = path.map((j) => at(j.x, j.y, j.z));
    const last = Math.max(1, path.length - 1);
    tube(points, path.map((j, i) => j.r * ((distance - points[i].z) / distance) * (1 - 0.3 * (i / last) ** 1.2)), 16, flare, gnarl);
  };
  for (const [i, one] of skeleton.limbs.entries()) {
    limb(i === 0 ? [skeleton.soil, ...one.joints] : one.joints, i === 0 ? 0.25 : 0.45, 0.07);
    await slice();
  }
  for (const root of skeleton.roots) {
    limb(root, 0, 0.12);
    await slice();
  }

  // The sprays. Fewer, smaller ones on a tree with many leaves, so a full
  // tree costs no more than a sparse one.
  const hearts = skeleton.leaves.map((leaf) => at(leaf.x, leaf.y, leaf.z));
  const middle = hearts.reduce((sum, h) => sum.add(h), new THREE.Vector3()).divideScalar(Math.max(1, hearts.length));
  const thin = Math.min(1, 700 / Math.max(1, hearts.length));
  const sprays = thin < 0.75 ? 2 : 3;
  const leafMatrices: THREE.Matrix4[] = [];
  const leafColors: THREE.Color[] = [];
  const flowerMatrices: THREE.Matrix4[] = [];
  const flowerColors: THREE.Color[] = [];
  const budMatrices: THREE.Matrix4[] = [];
  const basis = new THREE.Matrix4();
  // A blade's frame: along it, across it, and its face.
  const blade = (origin: THREE.Vector3, along: THREE.Vector3, face: THREE.Vector3, length: number, width: number) => {
    const x = along.clone().normalize();
    const z = face.clone().addScaledVector(x, -face.dot(x)).normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    basis.makeBasis(x.multiplyScalar(length), y.multiplyScalar(width), z.multiplyScalar(length));
    return basis.clone().setPosition(origin);
  };
  const bronze: RGB = [138, 82, 52];
  for (const [n, leaf] of skeleton.leaves.entries()) {
    await slice();
    const heart = hearts[n];
    const out = heart.clone().sub(middle);
    out.y = out.y * 0.6 + out.length() * 0.2;
    out.normalize();
    for (let k = 0; k < sprays; k++) {
      const dir = out.clone().multiplyScalar(0.85).add(unit().multiplyScalar(0.8)).addScaledVector(up, 0.3).normalize();
      const length = cw * (1.3 + 0.9 * rand());
      const base = heart.clone().add(unit().multiplyScalar(cw * 0.3));
      const tip = base.clone().addScaledVector(dir, length).addScaledVector(up, -length * 0.1);
      const bend = base.clone().lerp(tip, 0.5).addScaledVector(up, length * 0.06);
      tube([base, bend, tip], [0.55, 0.4, 0.2], 5, 0, 0);
      const twig = new THREE.QuadraticBezierCurve3(base, bend, tip);
      const across = new THREE.Vector3().crossVectors(dir, Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : up).normalize();
      const over = new THREE.Vector3().crossVectors(dir, across);
      const count = leaf.blossom ? 3 : Math.max(4, Math.round(9 * Math.sqrt(thin)));
      for (let j = 0; j < count; j++) {
        const f = 0.25 + (0.75 * j) / Math.max(1, count - 1);
        const node = twig.getPoint(f);
        const turn = j * 2.4 + rand() * 0.5;
        const side = across.clone().multiplyScalar(Math.cos(turn)).addScaledVector(over, Math.sin(turn));
        const along = dir.clone().multiplyScalar(0.5).addScaledVector(side, 0.85).addScaledVector(up, 0.15);
        const face = up.clone().multiplyScalar(0.8).addScaledVector(out, 0.4).add(unit().multiplyScalar(0.35));
        const size = cw * (1.15 + 0.45 * rand()) * (1.05 - 0.35 * f) * (leaf.blossom ? 0.8 : 1);
        leafMatrices.push(blade(node, along, face, size, size * 0.5));
        let tint = ramp(LEAF, 0.36 + 0.22 * rand() - 0.18 * leaf.cover);
        // New leaves at the tips come in bronze.
        if (f > 0.7 && rand() < 0.45) tint = mix(tint, bronze, 0.45 + 0.3 * rand());
        leafColors.push(color(tint));
      }
      if (!leaf.blossom) continue;
      // Blossom hangs in clusters along the twig, on short stalks.
      for (const f of [0.35, 0.65, 0.95]) {
        const node = twig.getPoint(f);
        const cluster = 2 + Math.floor(rand() * 3);
        for (let c = 0; c < cluster; c++) {
          const reach = out.clone().multiplyScalar(0.5).add(unit()).addScaledVector(up, -0.3).normalize();
          const at3 = node.clone().addScaledVector(reach, cw * (0.35 + 0.3 * rand()));
          const face = reach.clone().multiplyScalar(0.8).addScaledVector(out, 0.4).add(unit().multiplyScalar(0.3)).normalize();
          if (rand() < 0.12) {
            const bud = cw * (0.14 + 0.05 * rand());
            budMatrices.push(blade(at3, face, unit(), bud * 1.4, bud));
            continue;
          }
          const size = cw * (1.0 + 0.3 * rand());
          const roll = new THREE.Vector3().crossVectors(face, unit()).normalize();
          flowerMatrices.push(blade(at3, roll, face, size, size));
          flowerColors.push(color(mix(ramp(BLOSSOM, 0.6 + 0.28 * rand()), [255, 250, 252], 0.15)));
        }
      }
    }
  }

  const woodGeometry = own(new THREE.BufferGeometry());
  woodGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  woodGeometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  woodGeometry.setAttribute("aBark", new THREE.Float32BufferAttribute(barks, 4));
  woodGeometry.setIndex(indices);
  const swayed: Hooks = { uniforms: wind, vertexHead: WIND, position: "transformed += sway(transformed);" };
  const bark = own(
    patch(new THREE.MeshStandardMaterial({ roughness: 0.78 }), "bark", {
      ...swayed,
      vertexHead: `${WIND}\nattribute vec4 aBark;\nvarying vec4 vBark;`,
      position: "vBark = aBark;\ntransformed += sway(transformed);",
      fragmentHead: /* glsl */ `
        varying vec4 vBark;
        uniform vec3 uRoot;
        ${BUMP}
        // Bark round the limb: x and y round it, z along it, in units.
        vec3 barkAt(vec4 b) { return vec3(b.x * b.w, b.y * b.w, b.z); }
        float fissures(vec3 b) { return 1.0 - smoothstep(0.0, 0.11, abs(fbm(vec3(b.xy * 0.22, b.z * 0.05), 4) - 0.5)); }
        // Cherry bark's lenticels: short dashes running round the limb.
        float lenticels(vec3 b) {
          vec3 id;
          vec2 c = cells(vec3(b.xy * 0.2, b.z * 1.1), id);
          return (1.0 - smoothstep(0.12, 0.32, c.x)) * step(0.4, hash13(id));
        }
        float barkHeight(vec3 b, float radius) {
          float old = smoothstep(2.0, 7.0, radius);
          return -fissures(b) * old * 1.3 + lenticels(b) * 0.35 + fbm(b * 0.9, 2) * 0.3;
        }`,
      color: /* glsl */ `
        vec3 b = barkAt(vBark);
        float radius = vBark.w;
        vec3 up = inverseTransformDirection(normalize(vNormal), viewMatrix);
        // Young wood glossy red-brown, old wood greyer and furrowed.
        vec3 young = vec3(0.13, 0.045, 0.03);
        vec3 mature = vec3(0.1, 0.065, 0.05);
        vec3 aged = vec3(0.16, 0.145, 0.13);
        vec3 wood = mix(young, mix(mature, aged, smoothstep(4.0, 11.0, radius)), smoothstep(0.7, 3.0, radius));
        wood *= 0.75 + 0.5 * fbm(b * 0.04, 3);
        float old = smoothstep(2.0, 7.0, radius);
        wood *= 1.0 - 0.65 * fissures(b) * old;
        wood = mix(wood, vec3(0.3, 0.21, 0.15), lenticels(b) * 0.55);
        // Lichen on old wood, moss low on the trunk where rain runs down.
        float lichen = smoothstep(0.58, 0.68, fbm(b * 0.07 + 5.0, 4)) * old;
        wood = mix(wood, vec3(0.42, 0.45, 0.36) * (0.8 + 0.4 * fbm(b * 0.6, 2)), lichen * 0.8);
        float low = 1.0 - smoothstep(uRoot.y + 4.0, uRoot.y + 40.0, vWorld.y);
        float moss = low * smoothstep(0.35, 0.65, fbm(b * 0.15, 3) + up.y * 0.3) * old;
        wood = mix(wood, vec3(0.05, 0.09, 0.02) * (0.7 + 0.6 * fbm(b * 0.8, 2)), moss);
        diffuseColor.rgb = wood;`,
      roughness: "roughnessFactor = mix(0.55, 0.85, smoothstep(0.7, 4.0, vBark.w));",
      normalMap: /* glsl */ `
        {
          vec3 b = barkAt(vBark);
          vec3 bx = b + dFdx(b);
          vec3 by = b + dFdy(b);
          normal = bumped(normal, barkHeight(b, vBark.w), barkHeight(bx, vBark.w), barkHeight(by, vBark.w));
        }`,
    }),
  );
  const wood = new THREE.Mesh(woodGeometry, bark);
  wood.castShadow = true;
  wood.receiveShadow = true;
  wood.customDepthMaterial = own(patch(new THREE.MeshDepthMaterial(), "bark-depth", swayed));
  group.add(wood);

  // Leaves: a blade folded along its midrib and curled a little, its outline
  // cut by the shader.
  const leafGeometry = own(new THREE.PlaneGeometry(1, 1, 4, 2));
  const lp = leafGeometry.getAttribute("position");
  const luv = leafGeometry.getAttribute("uv");
  for (let i = 0; i < lp.count; i++) {
    const x = lp.getX(i) + 0.5;
    const y = lp.getY(i);
    lp.setXYZ(i, x, y, Math.abs(y) * 0.28 - x * x * 0.16);
    luv.setXY(i, x, y + 0.5);
  }
  leafGeometry.computeVertexNormals();
  const instanced: Hooks = {
    uniforms: wind,
    vertexHead: `${WIND}\nuniform float uFlutter;\nvarying vec2 vLeaf;\nvarying float vSeed;`,
    position: FLUTTER,
    fragmentHead: `varying vec2 vLeaf;\nvarying float vSeed;\n${SHAPES}`,
  };
  const leafMaterial = own(
    patch(new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, alphaTest: 0.5, alphaToCoverage: true, roughness: 0.5 }), "leaf", {
      ...instanced,
      through: new THREE.Vector3(0.8, 1.0, 0.35),
      color: /* glsl */ `
        {
          float edge = leafEdge(vLeaf);
          diffuseColor.a = 0.5 + 0.5 * edge / max(fwidth(edge), 1e-4);
          float u = vLeaf.x;
          float v = vLeaf.y - 0.5;
          float k = clamp((u - 0.07) / 0.93, 0.0, 1.0);
          float rib = 1.0 - smoothstep(0.0, 0.02, abs(v));
          float vein = (1.0 - smoothstep(0.0, 0.07, abs(fract(k * 7.0 - abs(v) * 2.4) - 0.5))) * smoothstep(0.02, 0.06, abs(v));
          vec3 leaf = diffuseColor.rgb * (1.0 + 0.3 * rib + 0.12 * vein);
          leaf *= 0.82 + 0.18 * smoothstep(0.0, 0.05, edge);
          float brown = step(0.92, vSeed) * smoothstep(0.55, 1.0, k + 0.25 * fbm(vLeaf * 6.0 + vSeed * 9.0, 2));
          leaf = mix(leaf, vec3(0.22, 0.12, 0.04), brown * 0.8);
          if (!gl_FrontFacing) leaf = mix(leaf, leaf * vec3(1.3, 1.35, 1.1) + 0.015, 0.6);
          diffuseColor.rgb = leaf;
        }`,
      roughness: "roughnessFactor = gl_FrontFacing ? 0.42 : 0.72;",
    }),
  );
  const leafDepth = own(
    patch(new THREE.MeshDepthMaterial(), "leaf-depth", { ...instanced, clip: "if (leafEdge(vLeaf) < 0.0) discard;" }),
  );
  const instances = (geometry: THREE.BufferGeometry, material: THREE.Material, depth: THREE.Material | undefined, matrices: THREE.Matrix4[], colors?: THREE.Color[]) => {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, matrices.length));
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    colors?.forEach((c, i) => mesh.setColorAt(i, c));
    mesh.count = matrices.length;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (depth) mesh.customDepthMaterial = depth;
    mesh.frustumCulled = false;
    group.add(mesh);
    disposables.push(mesh);
    return mesh;
  };
  instances(leafGeometry, leafMaterial, leafDepth, leafMatrices, leafColors);

  // Flowers: five cupped petals round a heart, facing +z.
  const flowerGeometry = own(flowerShape());
  const flowerMaterial = own(
    patch(new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, alphaTest: 0.5, alphaToCoverage: true, roughness: 0.6 }), "flower", {
      ...instanced,
      through: new THREE.Vector3(1.0, 0.8, 0.85),
      color: /* glsl */ `
        {
          float edge = petalEdge(vLeaf);
          diffuseColor.a = 0.5 + 0.5 * edge / max(fwidth(edge), 1e-4);
          vec3 tint = diffuseColor.rgb;
          if (vLeaf.x > 2.5) {
            // The heart: deep red, ringed with stamens tipped in yellow.
            vec2 q = vec2(vLeaf.x - 4.0, vLeaf.y);
            float r = length(q);
            float a = atan(q.y, q.x);
            vec3 heart = mix(vec3(0.42, 0.04, 0.09), tint * vec3(1.0, 0.7, 0.8), smoothstep(0.25, 0.7, r));
            float ring = abs(fract(a * 3.8197) - 0.5);
            float anther = 1.0 - smoothstep(0.1, 0.2, length(vec2(r - 0.78, ring * 0.5)));
            diffuseColor.rgb = mix(heart, vec3(1.0, 0.78, 0.22), anther);
          } else {
            float u = vLeaf.x;
            float v = vLeaf.y - 0.5;
            vec3 petal = mix(tint * vec3(1.0, 0.62, 0.75), mix(tint, vec3(1.0), 0.5), smoothstep(0.05, 0.75, u));
            petal *= 1.0 - 0.07 * (1.0 - smoothstep(0.0, 0.05, abs(fract(v * 7.0 + u * 0.6) - 0.5)));
            petal *= 0.9 + 0.1 * smoothstep(0.0, 0.04, edge);
            diffuseColor.rgb = petal;
          }
        }`,
    }),
  );
  const flowerDepth = own(
    patch(new THREE.MeshDepthMaterial(), "flower-depth", { ...instanced, clip: "if (petalEdge(vLeaf) < 0.0) discard;" }),
  );
  instances(flowerGeometry, flowerMaterial, flowerDepth, flowerMatrices, flowerColors);

  // Buds: closed, deep pink.
  const budGeometry = own(new THREE.SphereGeometry(0.5, 10, 8).translate(0.5, 0, 0));
  const budMaterial = own(patch(new THREE.MeshStandardMaterial({ color: color([196, 70, 104]), roughness: 0.5 }), "bud", { ...instanced, fragmentHead: "" }));
  instances(budGeometry, budMaterial, undefined, budMatrices);

  // Petals: lying on the stone and the soil, and falling.
  const petalGeometry = own(new THREE.PlaneGeometry(1, 1, 2, 1));
  const pp = petalGeometry.getAttribute("position");
  const puv = petalGeometry.getAttribute("uv");
  for (let i = 0; i < pp.count; i++) {
    const x = pp.getX(i) + 0.5;
    const y = pp.getY(i);
    pp.setXYZ(i, x - 0.5, y * 0.75, y * y * 0.35);
    puv.setXY(i, x, y + 0.5);
  }
  petalGeometry.computeVertexNormals();
  const lying: THREE.Matrix4[] = [];
  const lyingColors: THREE.Color[] = [];
  const { pot } = skeleton;
  const potX = pot.center - s.width / 2;
  const spreadX = (pot.right - pot.left) * 0.85;
  for (let i = 0; i < 320; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand());
    const x = potX + Math.cos(a) * r * spreadX;
    const z = Math.sin(a) * r * spreadX * 0.75;
    const size = cw * (0.42 + 0.15 * rand());
    const flat = new THREE.Vector3(0, 1, 0).add(unit().multiplyScalar(0.25));
    lying.push(blade(new THREE.Vector3(x, restAt(x, z) + 0.4, z), new THREE.Vector3(Math.cos(rand() * 7), 0, Math.sin(rand() * 7)), flat, size, size));
    lyingColors.push(color(mix(ramp(BLOSSOM, 0.65 + 0.25 * rand()), [255, 250, 252], 0.2)));
  }
  instances(petalGeometry, flowerMaterial, flowerDepth, lying, lyingColors).castShadow = false;
  // Colored from the start, so its shader is the one compiled ahead.
  const falling = instances(
    petalGeometry,
    flowerMaterial,
    flowerDepth,
    Array.from({ length: PETALS }, () => new THREE.Matrix4()),
    Array.from({ length: PETALS }, () => new THREE.Color(1, 1, 1)),
  );
  falling.count = 0;
  falling.castShadow = false;
  const tint = new THREE.Color();
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();

  return {
    group,
    fall(petals) {
      // Only the petals falling now are drawn: an empty slot's matrix would
      // have no inverse for the flutter.
      const size = cw * 0.5;
      const count = Math.min(PETALS, petals.length);
      for (let i = 0; i < count; i++) {
        const petal = petals[i];
        euler.set(petal.phase, petal.phase * 0.7, petal.phase * 0.3);
        rotation.setFromEuler(euler);
        matrix.compose(at(petal.x, petal.y, (((i * 37) % 64) / 64 - 0.5) * cw * 20), rotation, scale.set(size, size, size));
        falling.setColorAt(i, tint.set(petal.color));
        falling.setMatrixAt(i, matrix);
      }
      falling.count = count;
      falling.instanceMatrix.needsUpdate = true;
      if (falling.instanceColor) falling.instanceColor.needsUpdate = true;
    },
    dispose() {
      for (const item of disposables) item.dispose();
    },
  };
}

// Five petals, cupped, round a small heart, in a unit disc facing +z. The
// petals' uv runs along and across each; the heart's sits at (4, 0), so the
// shader can tell them apart.
function flowerShape() {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const ROWS = 6;
  for (let p = 0; p < 5; p++) {
    const a = (p / 5) * Math.PI * 2;
    const [ux, uy] = [Math.cos(a), Math.sin(a)];
    const [vx, vy] = [-uy, ux];
    const first = positions.length / 3;
    for (let i = 0; i <= ROWS; i++) {
      const along = i / ROWS;
      const r = 0.05 + 0.45 * along;
      for (const side of [-1, 0, 1]) {
        // Cupped: rising toward the tip, and toward each edge.
        const z = 0.2 * along * along + 0.07 * side * side * along + 0.02;
        positions.push(ux * r + vx * 0.24 * side, uy * r + vy * 0.24 * side, z);
        uvs.push(along, (side + 1) / 2);
      }
    }
    for (let i = 0; i < ROWS; i++) {
      for (let k = 0; k < 2; k++) {
        const a0 = first + i * 3 + k;
        indices.push(a0, a0 + 1, a0 + 3, a0 + 1, a0 + 4, a0 + 3);
      }
    }
  }
  const heart = positions.length / 3;
  positions.push(0, 0, 0.04);
  uvs.push(4, 0);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    positions.push(Math.cos(a) * 0.14, Math.sin(a) * 0.14, 0.035);
    uvs.push(4 + Math.cos(a), Math.sin(a));
  }
  for (let k = 0; k < 6; k++) indices.push(heart, heart + 1 + k, heart + 1 + ((k + 1) % 6));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
