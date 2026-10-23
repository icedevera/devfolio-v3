import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { clamp, random } from "../../scripts/canvas";
import { framing } from "../depth";
import { noise, smooth } from "../noise";
import type { Scene } from "../scene";
import { resample } from "../tree";
import { BUMP, CANDLE, NOISE, patch } from "./glsl";

// A candle lantern on the boulder beside the pot, on the side away from the
// sun or moon: aged bronze and glass round a candle, lit from dusk. Its flame
// flickers and wavers, and its light comes through the panes, barred by the
// posts, onto the pot and up into the tree.

export type Lantern = {
  group: THREE.Group; // for the scene
  glow: THREE.Group; // the flame, drawn as light after the scene
  tick: (t: number) => void;
  dispose: () => void;
};

type Options = {
  restAt: (x: number, z: number) => number; // the ground
  away: THREE.Vector3; // toward the sun or moon, which it stands across the pot from
  // Shared with the scene's other light drawn after it.
  overlay: {
    uTime: THREE.IUniform<number>;
    uSize: THREE.IUniform<THREE.Vector2>;
    tDepth: THREE.IUniform<THREE.Texture | null>;
    uExposure: THREE.IUniform<number>;
  };
};

// Its shape, in its own height. The panes run between the base and the roof,
// framed by corner posts, rails and a bar down the middle of each side.
const HALF = 0.26; // to the posts' outer faces
const POST = 0.034;
const BAR = 0.012;
const BOTTOM = 0.1; // the base's top
const TOP = 0.64; // the roof's underside
const LOW_RAIL = 0.03;
const HIGH_RAIL = 0.04;
const CANDLE_RADIUS = 0.068;
const CANDLE_TALL = 0.15;
const FLAME_TALL = 0.11;
// The roof, from the eaves up: half widths and heights over TOP.
const ROOF: [number, number][] = [
  [0.262, 0],
  [0.345, 0.012],
  [0.36, 0.028],
  [0.335, 0.04],
  [0.255, 0.075],
  [0.175, 0.115],
  [0.11, 0.16],
  [0.072, 0.2],
  [0.058, 0.222],
  [0.058, 0.24],
  [0, 0.246],
];

export function createLantern(s: Scene, o: Options): Lantern {
  const { width: W, height: H, layout: l, skeleton } = s;
  const { pot } = skeleton;
  const { distance: D, eye, at, lens } = framing(s);
  const rand = random(s.seed ^ 0x1a47);
  const disposables: { dispose: () => void }[] = [];
  const own = <T extends { dispose: () => void }>(item: T) => {
    disposables.push(item);
    return item;
  };

  // The pot, as pot.ts shapes it, and the lantern's height beside it.
  const width = pot.right - pot.left;
  const deep = width * 0.42;
  const x0 = pot.center - W / 2;
  const L = clamp((pot.foot - pot.top) * 1.8, l.ch * 4, l.ch * 9);

  // Where it stands: clear of every limb and sprig of leaves and, seen from
  // where the camera starts, inside the picture and clear of the page's
  // words. As near the pot as that allows, on the side away from the sun or
  // moon if it can; failing that, in front of a corner of the pot.
  // The limbs are sampled as closely as plant.ts builds them.
  const solid = [
    ...skeleton.limbs.flatMap((limb) => (limb.joints.length < 2 ? limb.joints : resample(limb.joints, 3)).map((j) => ({ p: at(j.x, j.y, j.z), r: j.r }))),
    ...skeleton.leaves.map((leaf) => ({ p: at(leaf.x, leaf.y, leaf.z), r: l.cw * 3.5 })),
  ];
  const eaves = ROOF[2][0] * L;
  const reach = eaves * Math.SQRT2; // to the roof's corners
  const room = (x: number, z: number) => {
    const y = o.restAt(x, z);
    let least = Infinity;
    for (const { p, r } of solid) {
      if (p.y - r > y + L * 1.05 || p.y + r < y) continue;
      least = Math.min(least, Math.hypot(p.x - x, p.z - z) - r - reach);
    }
    return least;
  };
  // Where it shows in the picture as the camera swings through its orbit,
  // seen from either end of the swing and the middle.
  const camera = new THREE.PerspectiveCamera();
  lens(camera, 4, D * 12);
  const corner = new THREE.Vector3();
  const framed = (x: number, z: number) => {
    const y = o.restAt(x, z);
    const pad = l.cw;
    for (const swing of [-0.4, 0, 0.4]) {
      camera.position.set(Math.sin(swing) * D, eye, Math.cos(swing) * D);
      camera.lookAt(0, eye, 0);
      camera.updateMatrixWorld();
      let [left, right, top, bottom] = [Infinity, -Infinity, Infinity, -Infinity];
      for (const dx of [-reach, reach]) {
        for (const dz of [-reach, reach]) {
          for (const dy of [0, L * 1.05]) {
            corner.set(x + dx, y + dy, z + dz).project(camera);
            const u = ((corner.x + 1) / 2) * W;
            const v = ((1 - corner.y) / 2) * H;
            [left, right, top, bottom] = [Math.min(left, u), Math.max(right, u), Math.min(top, v), Math.max(bottom, v)];
          }
        }
      }
      if (left < pad || right > W - pad || top < pad || bottom > H) return false;
      if (s.words.some((w) => left < w.right + pad && right > w.left - pad && top < w.bottom + pad && bottom > w.top - pad)) return false;
    }
    return true;
  };
  const side = Math.sign(-o.away.x) || 1;
  const spots: { x: number; z: number }[] = [];
  for (const way of [side, -side]) {
    for (const gap of [0.2, 0.5, 0.9, 1.4]) {
      for (const ahead of [0.3, 0.6, 0]) spots.push({ x: x0 + way * (width / 2 + eaves + gap * L), z: deep * ahead });
    }
  }
  for (const way of [side, -side]) {
    for (const along of [0.38, 0.2]) spots.push({ x: x0 + way * width * along, z: deep / 2 + eaves + 0.15 * L });
  }
  // Clear of the tree comes first: in the picture if it can be, and if it
  // can't be clear anywhere, there's no lantern.
  const turn = (rand() - 0.5) * 0.7;
  const scored = spots.map((p) => ({ ...p, room: room(p.x, p.z), framed: framed(p.x, p.z) }));
  const roomiest = (list: typeof scored) => list.reduce<(typeof scored)[number] | undefined>((best, p) => (!best || p.room > best.room ? p : best), undefined);
  const found = scored.find((p) => p.framed && p.room > L * 0.1) ?? roomiest(scored.filter((p) => p.framed && p.room > 0)) ?? roomiest(scored.filter((p) => p.room > 0));
  const spot = found ?? scored[0];
  // Level, and sunk a little where the rock rises under it, so it never
  // floats: the ground is read under its turned corners and sides.
  const foot = 0.31 * L;
  const [c, sn] = [Math.cos(turn), Math.sin(turn)];
  const under = [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]].map(([u, v]) =>
    o.restAt(spot.x + (u * c + v * sn) * foot, spot.z + (-u * sn + v * c) * foot),
  );
  const ground = Math.min(...under) - 0.6;

  const group = new THREE.Group();
  group.position.set(spot.x, ground, spot.z);
  group.rotation.y = turn;
  group.scale.setScalar(L);

  // The candle's light, shared with every patched material.
  const flameBase = new THREE.Vector3(spot.x, ground + (BOTTOM + CANDLE_TALL - 0.004) * L, spot.z);
  CANDLE.uFlameSize.value = 0.02 * L;
  CANDLE.uLanternAt.value.set(spot.x, spot.z, Math.cos(turn), Math.sin(turn));
  CANDLE.uPanes.value.set(HALF * L, ground + (BOTTOM + LOW_RAIL) * L, ground + (TOP - HIGH_RAIL) * L, POST * L);
  CANDLE.uHollow.value.set(ground + BOTTOM * L, ground + TOP * L);
  CANDLE.uEaves.value.set(ground + (TOP + 0.006) * L, ROOF[2][0] * L);
  CANDLE.uBar.value = BAR * L;
  // Inside the body where it's narrowest, just above its rounded foot, and
  // in from its rounded corners.
  const inner = (pot.base * 2 - l.cw * 0.4) / 2 - deep * 0.14 * 0.3;
  CANDLE.uPotLow.value.set(x0 - inner, H / 2 - (pot.bottom - l.ch * 0.08), -inner * (deep / width));
  CANDLE.uPotHigh.value.set(x0 + inner, H / 2 - pot.top, inner * (deep / width));
  CANDLE.uFlameAt.value.copy(flameBase);

  // Lit from dusk. By day, or with no room for it, the scene has no candle
  // light at all, so nothing pays for one.
  const lit = found ? smooth(4, -3, s.sky.elevation) : 0;
  const glow = { value: 0 }; // how bright the flame is now
  const unit = { value: 1 / L };

  // Aged bronze: tarnished dark where it's handled least, green in patches,
  // faintly hammered, and sooted over the flame.
  const metal = own(
    patch(new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.4 }), "lantern-metal", {
      uniforms: { uUnit: unit },
      fragmentHead: /* glsl */ `${BUMP}
        uniform float uUnit;
        float greened;
        float grime;
        float hammered(vec3 p) {
          return 0.35 * vnoise(p * uUnit * 90.0);
        }`,
      color: /* glsl */ `
        {
          vec3 q = vWorld * uUnit;
          grime = fbm(q * 7.0, 4);
          greened = smoothstep(0.58, 0.78, fbm(q * 13.0 + 4.0, 3)) * smoothstep(0.35, 0.6, grime);
          diffuseColor.rgb = mix(vec3(0.33, 0.2, 0.09), vec3(0.05, 0.04, 0.03), smoothstep(0.3, 0.7, grime) * 0.9);
          float over = (vWorld.y - uFlameAt.y) * uUnit;
          float above = 1.0 - smoothstep(0.0, 0.17, length(vWorld.xz - uFlameAt.xz) * uUnit);
          diffuseColor.rgb *= 1.0 - 0.9 * above * step(0.15, over) * step(over, 0.45);
        }`,
      roughness: "roughnessFactor = mix(0.28, 0.62, smoothstep(0.3, 0.7, grime));",
      normalMap: /* glsl */ `
        {
          vec3 px = vWorld + dFdx(vWorld);
          vec3 py = vWorld + dFdy(vWorld);
          normal = bumped(normal, hammered(vWorld), hammered(px), hammered(py));
        }`,
      lit: /* glsl */ `
        material.diffuseContribution = mix(material.diffuseContribution, vec3(0.16, 0.33, 0.27), greened);
        material.specularColorBlended = mix(material.specularColorBlended, vec3(0.04), greened);
        material.roughness = mix(material.roughness, 0.85, greened);`,
    }),
  );

  // Glass reflects, the more the more it's seen edge on, and lets the rest
  // through: drawn as its reflection over what's behind, dimmed as much as it
  // reflects. Dusty, sooted at the top, and lit a little by the flame.
  const glass = own(
    patch(new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.04, transparent: true, depthWrite: false, side: THREE.DoubleSide }), "lantern-glass", {
      uniforms: { uUnit: unit, uGlow: glow },
      layered: true,
      fragmentHead: /* glsl */ `
        uniform float uUnit;
        uniform float uGlow;
        float dust;`,
      color: "dust = fbm(vWorld * uUnit * 30.0, 3);",
      roughness: "roughnessFactor = mix(0.03, 0.25, smoothstep(0.5, 0.8, dust));",
      emissive: /* glsl */ `
        {
          float d = length(vWorld - uFlameAt) * uUnit;
          totalEmissiveRadiance += vec3(1.0, 0.5, 0.18) * uGlow * (0.02 + 0.05 * dust) / (1.0 + d * d * 40.0);
        }`,
      lit: /* glsl */ `
        {
          float facing = saturate(dot(normal, normalize(vViewPosition)));
          float soot = smoothstep(uPanes.z - 0.14 / uUnit, uPanes.z, vWorld.y) * (0.35 + 0.4 * dust);
          diffuseColor.a = saturate(0.04 + 0.96 * pow(1.0 - facing, 5.0) + soot + 0.04 * dust);
        }`,
    }),
  );
  glass.blending = THREE.CustomBlending;
  glass.blendSrc = THREE.OneFactor;
  glass.blendDst = THREE.OneMinusSrcAlphaFactor;

  // Wax glows round the flame, the light coming through it.
  const waxTop = { value: ground + (BOTTOM + CANDLE_TALL) * L };
  const wax = own(
    patch(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.8, 0.72, 0.58), roughness: 0.45 }), "lantern-wax", {
      uniforms: { uUnit: unit, uGlow: glow, uWaxTop: waxTop },
      fragmentHead: "uniform float uUnit;\nuniform float uGlow;\nuniform float uWaxTop;",
      emissive: /* glsl */ `
        {
          float below = max(0.0, uWaxTop - vWorld.y) * uUnit;
          totalEmissiveRadiance += vec3(1.0, 0.52, 0.2) * uGlow * 0.5 * exp(-below * 30.0);
        }`,
      through: new THREE.Vector3(0.9, 0.55, 0.3),
    }),
  );
  // The wick, charred, its tip an ember.
  const wickTop = { value: ground + (BOTTOM + CANDLE_TALL + 0.017) * L };
  const char = own(
    patch(new THREE.MeshStandardMaterial({ color: 0x0b0806, roughness: 0.9 }), "lantern-wick", {
      uniforms: { uUnit: unit, uGlow: glow, uWickTop: wickTop },
      fragmentHead: "uniform float uUnit;\nuniform float uGlow;\nuniform float uWickTop;",
      emissive: "totalEmissiveRadiance += vec3(1.0, 0.3, 0.06) * uGlow * 3.0 * smoothstep(uWickTop - 0.012 / uUnit, uWickTop, vWorld.y);",
    }),
  );

  // The frame: base, posts, rails, bars, a plate under the roof, the roof,
  // and the finial with its ring.
  const flat = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);
  const block = (w: number, h: number, d: number, x: number, y: number, z: number, round = 0) =>
    flat(round > 0 ? new RoundedBoxGeometry(w, h, d, 2, round) : new THREE.BoxGeometry(w, h, d)).translate(x, y, z);
  const inset = HALF - POST / 2;
  const tall = TOP - BOTTOM;
  const parts = [
    block(0.62, 0.07, 0.62, 0, 0.035, 0, 0.012),
    block(0.56, 0.032, 0.56, 0, 0.086, 0, 0.006),
    block(2 * HALF, 0.008, 2 * HALF, 0, TOP - 0.004, 0),
    roof(TOP),
    flat(new THREE.SphereGeometry(0.028, 16, 12)).translate(0, TOP + 0.268, 0),
    flat(new THREE.TorusGeometry(0.055, 0.0075, 8, 32)).translate(0, TOP + 0.35, 0),
  ];
  for (const [u, v] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) parts.push(block(POST, tall, POST, u * inset, BOTTOM + tall / 2, v * inset));
  for (const [y, h] of [[BOTTOM + LOW_RAIL / 2, LOW_RAIL], [TOP - HIGH_RAIL / 2, HIGH_RAIL]]) {
    for (const v of [1, -1]) {
      parts.push(block(2 * HALF, h, POST, 0, y, v * inset));
      parts.push(block(POST, h, 2 * HALF, v * inset, y, 0));
    }
  }
  const barTall = tall - LOW_RAIL - HIGH_RAIL;
  const barY = BOTTOM + LOW_RAIL + barTall / 2;
  for (const v of [1, -1]) {
    parts.push(block(BAR, barTall, POST * 0.5, 0, barY, v * inset));
    parts.push(block(POST * 0.5, barTall, BAR, v * inset, barY, 0));
  }
  const frame = new THREE.Mesh(own(mergeGeometries(parts)), metal);
  for (const part of parts) part.dispose();
  frame.castShadow = true;
  frame.receiveShadow = true;

  // The panes, between the posts' middles.
  const paneGeometry = (turnBy: number) => new THREE.PlaneGeometry(2 * inset, barTall).rotateY(turnBy).translate(Math.sin(turnBy) * inset, barY, Math.cos(turnBy) * inset);
  const panes = [0, Math.PI / 2, Math.PI, -Math.PI / 2].map(paneGeometry);
  const glazing = new THREE.Mesh(own(mergeGeometries(panes)), glass);
  for (const pane of panes) pane.dispose();

  // The candle, burnt down a little: a pool melted in its top, and wax run
  // down its side.
  const body = flat(
    new THREE.LatheGeometry(
      [[0, 0], [CANDLE_RADIUS, 0], [CANDLE_RADIUS + 0.001, 0.004], [CANDLE_RADIUS + 0.001, CANDLE_TALL - 0.008], [CANDLE_RADIUS - 0.002, CANDLE_TALL],
        [CANDLE_RADIUS - 0.008, CANDLE_TALL - 0.001], [CANDLE_RADIUS * 0.7, CANDLE_TALL - 0.007], [0.02, CANDLE_TALL - 0.011], [0, CANDLE_TALL - 0.012]].map(([r, y]) => new THREE.Vector2(r, y)),
      28,
    ),
  ).translate(0, BOTTOM, 0);
  const runs = [body];
  for (let i = 0; i < 4; i++) {
    const a = rand() * Math.PI * 2;
    const long = 0.025 + 0.04 * rand();
    runs.push(flat(new THREE.CapsuleGeometry(0.006 + 0.003 * rand(), long, 4, 8)).translate(Math.cos(a) * CANDLE_RADIUS, BOTTOM + CANDLE_TALL - 0.004 - long / 2, Math.sin(a) * CANDLE_RADIUS));
  }
  const candle = new THREE.Mesh(own(mergeGeometries(runs)), wax);
  for (const run of runs) run.dispose();
  candle.castShadow = true;
  candle.receiveShadow = true;
  const wick = new THREE.Mesh(
    own(new THREE.CylinderGeometry(0.0035, 0.0045, 0.03, 6).translate(0, 0.015, 0).rotateZ(0.22).translate(0, BOTTOM + CANDLE_TALL - 0.012, 0)),
    char,
  );
  if (found) group.add(frame, glazing, candle, wick);

  // The candle's light, a little warmer than the flame looks.
  // It reaches ten times the lantern's height; past that, surfaces skip it.
  const light = lit > 0 ? new THREE.PointLight(new THREE.Color(1, 0.62, 0.34), 0, 10 * L, 2) : undefined;
  const whole = new THREE.Group();
  whole.add(group);
  if (light) whole.add(light);

  // The flame: a teardrop facing the camera, round about its upright, that
  // wavers and leans; a bright body, a dim heart round the wick, blue at the
  // root, and a faint orange edge. Light, added after the scene, behind
  // whatever its depth puts in front of it.
  const sway = new THREE.Vector2();
  const flameUniforms = {
    ...o.overlay,
    uGlow: glow,
    uBase: { value: flameBase.clone() },
    uSway: { value: sway },
    uTall: { value: FLAME_TALL * L },
    uWide: { value: 0.026 * L },
  };
  const quad = own(new THREE.BufferGeometry());
  quad.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  const flameMaterial = own(
    new THREE.ShaderMaterial({
      uniforms: flameUniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform vec3 uBase;
        uniform vec2 uSway;
        uniform float uTall;
        uniform float uWide;
        varying vec2 vQ;
        void main() {
          vec3 toward = cameraPosition - uBase;
          vec3 across = normalize(vec3(toward.z, 0.0, -toward.x));
          vQ = vec2(position.x * 2.2, position.y * 1.3 - 0.12);
          float up = max(vQ.y, 0.0);
          vec3 p = uBase + across * vQ.x * uWide + vec3(0.0, vQ.y * uTall, 0.0) + vec3(uSway.x, 0.0, uSway.y) * up * up;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${NOISE}
        uniform float uTime;
        uniform float uGlow;
        uniform float uExposure;
        uniform vec2 uSize;
        uniform sampler2D tDepth;
        varying vec2 vQ;
        void main() {
          if (uGlow <= 0.0 || gl_FragCoord.z > texture(tDepth, gl_FragCoord.xy / uSize).x) discard;
          float y = vQ.y;
          float x = vQ.x - (vnoise(vec2(y * 2.5 - uTime * 6.0, uTime * 1.3)) - 0.5) * 0.9 * y * y;
          float wide = 0.26;
          float r = y < wide ? sqrt(max(0.0, 1.0 - pow((wide - y) / (wide + 0.06), 2.0))) : pow(max(0.0, (1.0 - y) / (1.0 - wide)), 1.25);
          float d = abs(x) / max(r, 1e-3);
          float body = (1.0 - smoothstep(0.55, 1.0, d)) * smoothstep(-0.06, 0.04, y) * (1.0 - smoothstep(0.92, 1.05, y));
          float edge = (1.0 - smoothstep(0.8, 1.6, d)) * smoothstep(-0.08, 0.1, y) * (1.0 - smoothstep(0.85, 1.15, y));
          float heart = 1.0 - 0.75 * exp(-(x * x * 6.0 + (y - 0.14) * (y - 0.14) * 60.0));
          float root = smoothstep(0.3, 0.0, y) * smoothstep(0.35, 0.95, d) * (1.0 - smoothstep(0.95, 1.2, d));
          vec3 color = vec3(1.0, 0.78, 0.42) * body * heart * mix(1.0, 0.55, smoothstep(0.55, 1.0, y)) * 30.0
            + vec3(1.0, 0.4, 0.1) * edge * 2.5
            + vec3(0.15, 0.3, 1.0) * root * 3.0;
          gl_FragColor = vec4(color * uGlow * uExposure, 1.0);
        }`,
    }),
  );
  const flame = new THREE.Mesh(quad, flameMaterial);

  // And the air right round it, lit: a faint glow, hidden where something
  // stands in front of the flame. The lens adds the rest.
  const disc = own(new THREE.BufferGeometry());
  disc.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  disc.setIndex([0, 1, 2, 0, 2, 3]);
  const haloMaterial = own(
    new THREE.ShaderMaterial({
      uniforms: { ...o.overlay, uGlow: glow, uMiddle: CANDLE.uFlameAt, uRadius: { value: 0.2 * L } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform vec3 uMiddle;
        uniform float uRadius;
        varying vec2 vQ;
        varying vec4 vMiddle;
        void main() {
          vec4 view = viewMatrix * vec4(uMiddle, 1.0);
          vMiddle = projectionMatrix * view;
          vQ = position.xy;
          view.xy += position.xy * uRadius;
          gl_Position = projectionMatrix * view;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uGlow;
        uniform float uExposure;
        uniform vec2 uSize;
        uniform sampler2D tDepth;
        varying vec2 vQ;
        varying vec4 vMiddle;
        void main() {
          float depth = vMiddle.z / vMiddle.w * 0.5 + 0.5;
          if (uGlow <= 0.0 || depth > texture(tDepth, gl_FragCoord.xy / uSize).x) discard;
          float r2 = dot(vQ, vQ);
          float halo = (exp(-r2 * 9.0) * 0.5 + exp(-r2 * 3.0) * 0.12) * (1.0 - smoothstep(0.7, 1.0, r2));
          gl_FragColor = vec4(vec3(1.0, 0.55, 0.22) * halo * uGlow * uExposure * 0.5, 1.0);
        }`,
    }),
  );
  const halo = new THREE.Mesh(disc, haloMaterial);
  const sized = (r: THREE.WebGLRenderer) => {
    const target = r.getRenderTarget();
    if (target) o.overlay.uSize.value.set(target.width, target.height);
  };
  for (const mesh of [flame, halo]) {
    mesh.frustumCulled = false;
    mesh.onBeforeRender = sized;
  }
  const glowing = new THREE.Group();
  if (light) glowing.add(halo, flame);

  // A flame flickers, now and then gutters, and leans as the air in the
  // lantern stirs. Its light moves with it.
  const middle = new THREE.Vector3();
  const strength = 4.5 * L * L;
  return {
    group: whole,
    glow: glowing,
    tick(t) {
      const flicker = clamp(
        0.86 + 0.1 * noise(t * 1.9, 0.3) + 0.06 * noise(t * 6.1, 1.7) + 0.03 * noise(t * 13.3, 2.9) - 0.25 * smooth(0.45, 0.8, noise(t * 0.37, 4.1)),
        0.3,
        1.2,
      );
      glow.value = lit * flicker;
      sway.set(noise(t * 0.8, 5.3), noise(t * 0.7, 8.1)).multiplyScalar(0.25 * FLAME_TALL * L);
      flameUniforms.uTall.value = FLAME_TALL * L * (0.8 + 0.25 * flicker);
      middle.set(flameBase.x + sway.x * 0.4, flameBase.y + 0.45 * flameUniforms.uTall.value, flameBase.z + sway.y * 0.4);
      CANDLE.uFlameAt.value.copy(middle);
      if (!light) return;
      light.position.copy(middle);
      light.intensity = strength * glow.value;
    },
    dispose() {
      for (const item of disposables) item.dispose();
      light?.dispose();
    },
  };
}

// A square roof, from a profile of half widths and heights: each side ruled
// between its hips, smooth up the profile and sharp at the hips.
function roof(base: number) {
  const positions: number[] = [];
  const normals: number[] = [];
  const bend = ROOF.map((_, j) => {
    const [h0, y0] = ROOF[Math.max(0, j - 1)];
    const [h1, y1] = ROOF[Math.min(ROOF.length - 1, j + 1)];
    const length = Math.hypot(h1 - h0, y1 - y0);
    return [(y1 - y0) / length, -(h1 - h0) / length];
  });
  for (const [nx, nz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    const [tx, tz] = [-nz, nx];
    const corner = (j: number, k: number) => {
      const [h, y] = ROOF[j];
      return [nx * h + tx * h * k, base + y, nz * h + tz * h * k];
    };
    const normal = (j: number) => [nx * bend[j][0], bend[j][1], nz * bend[j][0]];
    for (let j = 0; j < ROOF.length - 1; j++) {
      // Two triangles, wound to face out.
      for (const [a, b, c] of [[[j, -1], [j + 1, 1], [j, 1]], [[j, -1], [j + 1, -1], [j + 1, 1]]] as [number, number][][]) {
        for (const [jj, k] of [a, b, c]) {
          positions.push(...corner(jj, k));
          normals.push(...normal(jj));
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(new Array((positions.length / 3) * 2).fill(0), 2));
  return geometry;
}
