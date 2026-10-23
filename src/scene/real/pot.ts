import * as THREE from "three";
import { random } from "../../scripts/canvas";
import { color, framing, shell, type Ring } from "../depth";
import { noise } from "../noise";
import type { Scene } from "../scene";
import { mix } from "../sky";
import { GLAZE, ramp } from "../tree";
import { BUMP, patch } from "./glsl";

// The pot: stoneware under a glossy glaze that pooled and ran as it fired,
// crazed with fine cracks and flecked with iron, its feet bare clay. In it,
// bonsai soil, grains of fired clay, pumice and lava, and a cushion of moss
// round the trunk.

export type Pot = {
  group: THREE.Group;
  soilY: number; // the soil's surface
  inside: (x: number, z: number) => boolean; // over the soil
  dispose: () => void;
};

export function createPot(s: Scene): Pot {
  const { width: W, height: H, layout: l, skeleton } = s;
  const { cw, ch } = l;
  const { pot } = skeleton;
  const { at } = framing(s);
  const rand = random(s.seed ^ 0x9077);
  const group = new THREE.Group();
  const disposables: { dispose: () => void }[] = [];
  const own = <T extends { dispose: () => void }>(item: T) => {
    disposables.push(item);
    return item;
  };

  const width = pot.right - pot.left;
  const deep = width * 0.42;
  const rim = ch * 0.3;
  const lipTop = pot.top - rim * 0.4;
  const bodyTop = lipTop + rim;
  const baseWidth = pot.base * 2;
  const x0 = pot.center - W / 2;
  const ring = (screenY: number, w: number, radius = deep * 0.14): Ring => ({
    y: H / 2 - screenY,
    width: w,
    depth: w * (deep / width),
    radius,
  });

  const dark = color(ramp(GLAZE, 0.2 - 0.1 * s.night));
  const light = color(mix(ramp(GLAZE, 0.62), [214, 206, 188], 0.25));
  const glaze = own(
    patch(new THREE.MeshPhysicalMaterial({ roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.07 }), "glaze", {
      uniforms: {
        uPot: { value: new THREE.Vector3(x0, H / 2 - lipTop, 0) },
        uDark: { value: new THREE.Vector3(dark.r, dark.g, dark.b) },
        uLight: { value: new THREE.Vector3(light.r, light.g, light.b) },
        uHeight: { value: pot.bottom - lipTop },
      },
      fragmentHead: /* glsl */ `
        uniform vec3 uPot;
        uniform vec3 uDark;
        uniform vec3 uLight;
        uniform float uHeight;
        ${BUMP}
        float crackle(vec3 q) {
          vec3 id;
          vec2 c = cells(q * 0.085, id);
          return 1.0 - smoothstep(0.0, 0.04, c.y - c.x);
        }
        float bareAt(vec3 q) { return 1.0 - smoothstep(-uHeight + 1.0, -uHeight + 3.5, q.y); }
        float glazeHeight(vec3 q) { return -crackle(q) * 0.25 + fbm(q * 0.35, 2) * 0.12; }`,
      color: /* glsl */ `
        vec3 q = vWorld - uPot;
        float fromRim = clamp(-q.y / uHeight, 0.0, 1.0);
        // Two glazes over each other, breaking light where the top one thins.
        float tone = fbm(q * 0.022, 4);
        vec3 glazeColor = mix(uDark, uLight, smoothstep(0.35, 0.68, tone));
        // Runs from the rim, pooling dark where they stopped.
        float run = fbm(vec2((q.x + q.z) * 0.075, q.y * 0.01), 4);
        float runs = smoothstep(0.5, 0.75, run) * (1.0 - fromRim * 0.8);
        glazeColor = mix(glazeColor, uDark * 0.55, runs * 0.55);
        glazeColor = mix(glazeColor, uLight * 1.1, smoothstep(0.85, 1.0, 1.0 - fromRim) * 0.35);
        // Iron flecks, and the crazing.
        vec3 sid;
        vec2 sp = cells(q * 0.55, sid);
        glazeColor = mix(glazeColor, vec3(0.06, 0.035, 0.025), (1.0 - smoothstep(0.06, 0.14, sp.x)) * step(0.82, hash13(sid)) * 0.85);
        glazeColor *= 1.0 - 0.16 * crackle(q);
        // The feet and foot ring, bare stoneware.
        float bare = bareAt(q);
        vec3 clay = vec3(0.2, 0.135, 0.095) * (0.75 + 0.5 * fbm(q * 0.25, 3));
        diffuseColor.rgb = mix(glazeColor, clay, bare);`,
      roughness: "roughnessFactor = mix(0.26 + 0.1 * crackle(vWorld - uPot), 0.92, bareAt(vWorld - uPot));",
      normalMap: /* glsl */ `
        {
          vec3 q = vWorld - uPot;
          vec3 qx = q + dFdx(vWorld);
          vec3 qy = q + dFdy(vWorld);
          normal = bumped(normal, glazeHeight(q), glazeHeight(qx), glazeHeight(qy));
        }`,
      lit: "material.clearcoat *= 1.0 - bareAt(vWorld - uPot);",
    }),
  );

  // The lip rolls over; the body tapers to its base.
  const shapes = [
    shell(
      [
        ring(lipTop, width - 2, deep * 0.16),
        ring(lipTop + rim * 0.12, width + 0.5, deep * 0.16),
        ring(lipTop + rim * 0.45, width + 1.5, deep * 0.16),
        ring(bodyTop - rim * 0.1, width + 0.5, deep * 0.16),
        ring(bodyTop, width - 2, deep * 0.16),
      ],
      14,
    ),
    shell(
      [
        ring(bodyTop, width - cw * 0.9),
        ring(pot.bottom - ch * 0.3, baseWidth + cw * 0.6),
        ring(pot.bottom - ch * 0.08, baseWidth - cw * 0.4),
        ring(pot.bottom, baseWidth - cw * 1.4),
      ],
      14,
    ),
  ];
  for (const geometry of shapes) {
    const mesh = new THREE.Mesh(own(geometry), glaze);
    mesh.position.x = x0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  const footDepth = ((baseWidth * deep) / width) * 0.7;
  const foot = own(
    shell(
      [
        { y: H / 2 - (pot.bottom - 2), width: cw * 2.6, depth: footDepth, radius: cw * 0.3 },
        { y: H / 2 - (pot.foot - 1.5), width: cw * 2.2, depth: footDepth - cw * 0.4, radius: cw * 0.3 },
        { y: H / 2 - pot.foot, width: cw * 2.05, depth: footDepth - cw * 0.55, radius: cw * 0.3 },
      ],
      10,
    ),
  );
  for (const side of [-1, 1]) {
    const mesh = new THREE.Mesh(foot, glaze);
    mesh.position.x = x0 + side * (pot.base - cw * 1.6);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Soil, inside the rim.
  const soilY = H / 2 - lipTop + 0.6;
  const soilWidth = width - cw * 0.9;
  const soilDepth = soilWidth * (deep / width);
  const corner = deep * 0.12;
  const outline = new THREE.Shape();
  const hw = soilWidth / 2;
  const hd = soilDepth / 2;
  outline.moveTo(-hw + corner, -hd);
  outline.lineTo(hw - corner, -hd);
  outline.quadraticCurveTo(hw, -hd, hw, -hd + corner);
  outline.lineTo(hw, hd - corner);
  outline.quadraticCurveTo(hw, hd, hw - corner, hd);
  outline.lineTo(-hw + corner, hd);
  outline.quadraticCurveTo(-hw, hd, -hw, hd - corner);
  outline.lineTo(-hw, -hd + corner);
  outline.quadraticCurveTo(-hw, -hd, -hw + corner, -hd);
  const soilGeometry = own(new THREE.ShapeGeometry(outline, 8).rotateX(-Math.PI / 2));
  const soilMaterial = own(
    patch(new THREE.MeshStandardMaterial({ roughness: 0.95 }), "soil", {
      fragmentHead: /* glsl */ `${BUMP}
        float grain(vec2 p, out vec2 id) {
          vec2 c = cells(p * 0.42, id);
          return 1.0 - smoothstep(0.2, 0.6, c.x);
        }
        float soilHeight(vec2 p) {
          vec2 id;
          return grain(p, id) * (0.6 + 0.6 * hash12(id));
        }`,
      color: /* glsl */ `
        vec2 p = vWorld.xz;
        vec2 id;
        float g = grain(p, id);
        float kind = hash12(id);
        vec3 grit = kind < 0.55 ? vec3(0.3, 0.15, 0.07) : kind < 0.82 ? vec3(0.36, 0.34, 0.3) : vec3(0.06, 0.05, 0.045);
        grit *= 0.7 + 0.6 * hash12(id + 7.0);
        vec3 soil = mix(vec3(0.025, 0.018, 0.013), grit, g);
        float moss = smoothstep(0.56, 0.7, fbm(p * 0.045, 4));
        soil = mix(soil, vec3(0.05, 0.09, 0.02) * (0.7 + 0.6 * fbm(p * 0.7, 3)), moss);
        diffuseColor.rgb = soil;`,
      normalMap: /* glsl */ `
        {
          vec3 px = vWorld + dFdx(vWorld);
          vec3 py = vWorld + dFdy(vWorld);
          normal = bumped(normal, soilHeight(vWorld.xz), soilHeight(px.xz), soilHeight(py.xz));
        }`,
    }),
  );
  const soil = new THREE.Mesh(soilGeometry, soilMaterial);
  soil.position.set(x0, soilY, 0);
  soil.receiveShadow = true;
  group.add(soil);

  // Grains lying loose on top.
  const grainGeometry = own(new THREE.IcosahedronGeometry(1, 1));
  const grains = new THREE.InstancedMesh(grainGeometry, own(patch(new THREE.MeshStandardMaterial({ roughness: 0.92 }), "grain", {})), 900);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const moundX = at(skeleton.soil.x, lipTop).x;
  const moundHalf = cw * 8;
  for (let i = 0; i < grains.count; i++) {
    let x = 0;
    let z = 0;
    // Not under the moss.
    for (let tries = 0; tries < 8; tries++) {
      x = x0 + (rand() - 0.5) * (soilWidth - 4);
      z = (rand() - 0.5) * (soilDepth - 4);
      if (((x - moundX) / moundHalf) ** 2 + (z / (deep * 0.36)) ** 2 > 1.05) break;
    }
    const size = 0.8 + 1.3 * rand();
    e.set(rand() * 6, rand() * 6, rand() * 6);
    grains.setMatrixAt(i, m.compose(v.set(x, soilY + size * 0.35, z), q.setFromEuler(e), sc.set(size, size * 0.8, size)));
    const kind = rand();
    grains.setColorAt(i, color(kind < 0.55 ? [150, 92, 56] : kind < 0.82 ? [170, 166, 154] : [40, 36, 34]).multiplyScalar(0.7 + 0.5 * rand()));
  }
  grains.receiveShadow = true;
  group.add(grains);
  disposables.push(grains);

  // Moss: a lumpy cushion round the trunk, and shells over it whose fibres
  // thin toward the top, so its edge is soft.
  const mound = own(new THREE.SphereGeometry(1, 128, 28, 0, Math.PI * 2, 0, Math.PI / 2));
  const mp = mound.getAttribute("position");
  const center = at(skeleton.soil.x, lipTop);
  for (let i = 0; i < mp.count; i++) {
    const x = mp.getX(i);
    const y = mp.getY(i);
    const z = mp.getZ(i);
    const n = noise(x * 9, z * 9, 2.3) * 0.25 + noise(x * 23, z * 23, 5.1) * 0.08;
    mp.setXYZ(i, center.x + x * moundHalf, soilY - 0.5 + y * (1 + n) * ch * 0.32, z * deep * 0.36);
  }
  mound.computeVertexNormals();
  const mossColor = /* glsl */ `
    {
      vec3 p = vWorld;
      vec3 id;
      vec2 c = cells(p * 0.16, id);
      float clump = 1.0 - smoothstep(0.3, 0.9, c.x);
      float tone = fbm(p * 0.5, 3);
      vec3 moss = mix(vec3(0.03, 0.06, 0.012), vec3(0.16, 0.22, 0.04), clump * 0.6 + tone * 0.4);
      moss = mix(moss, vec3(0.24, 0.24, 0.06), smoothstep(0.7, 0.9, hash13(id)) * 0.5);
      diffuseColor.rgb = moss * (0.6 + 0.4 * vLayer);
    }`;
  const mossHooks = {
    vertexHead: "varying float vLayer;",
    fragmentHead: `varying float vLayer;\n${BUMP}`,
    color: mossColor,
  };
  const mossMaterial = own(
    patch(new THREE.MeshStandardMaterial({ roughness: 0.95 }), "moss", {
      ...mossHooks,
      position: "vLayer = 0.0;",
      normalMap: /* glsl */ `
        {
          vec3 px = vWorld + dFdx(vWorld);
          vec3 py = vWorld + dFdy(vWorld);
          normal = bumped(normal, fbm(vWorld * 0.9, 3) * 0.8, fbm(px * 0.9, 3) * 0.8, fbm(py * 0.9, 3) * 0.8);
        }`,
    }),
  );
  const moss = new THREE.Mesh(mound, mossMaterial);
  moss.receiveShadow = true;
  group.add(moss);
  const SHELLS = 6;
  const shellMaterial = own(
    patch(new THREE.MeshStandardMaterial({ roughness: 0.95, alphaTest: 0.5, alphaToCoverage: true }), "moss-shell", {
      ...mossHooks,
      position: `vLayer = float(gl_InstanceID + 1) / ${SHELLS.toFixed(1)};\ntransformed += normal * vLayer * 2.2;`,
      clip: "",
      color: /* glsl */ `
        ${mossColor}
        float fibre = vnoise(vWorld * 1.7) * 0.7 + vnoise(vWorld * 4.1) * 0.3;
        float keep = fibre - (0.25 + 0.6 * vLayer);
        diffuseColor.a = 0.5 + 0.5 * keep / max(fwidth(keep), 1e-4);`,
    }),
  );
  const shells = new THREE.InstancedMesh(mound, shellMaterial, SHELLS);
  for (let i = 0; i < SHELLS; i++) shells.setMatrixAt(i, new THREE.Matrix4());
  shells.receiveShadow = true;
  shells.frustumCulled = false;
  group.add(shells);
  disposables.push(shells);

  const inside = (x: number, z: number) => Math.abs(x - x0) < soilWidth / 2 && Math.abs(z) < soilDepth / 2;
  return {
    group,
    soilY,
    inside,
    dispose() {
      for (const item of disposables) item.dispose();
    },
  };
}
