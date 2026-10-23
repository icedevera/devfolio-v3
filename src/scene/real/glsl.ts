import * as THREE from "three";

// GLSL the realistic stage's materials share: noise, surfaces bumped by a
// height worked out per pixel, the wind, and light shining through leaves
// and petals.

export const NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec2 hash22(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
// Smooth value noise in [0, 1].
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1.0, 0.0, 0.0)), u.x), mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), u.x), mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), u.x), u.y),
    u.z);
}
// Layered noise in [0, 1].
float fbm(vec2 p, int octaves) {
  float sum = 0.0;
  float amplitude = 0.5;
  float total = 0.0;
  for (int i = 0; i < octaves; i++) {
    sum += amplitude * vnoise(p);
    total += amplitude;
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.31;
    amplitude *= 0.5;
  }
  return sum / total;
}
float fbm(vec3 p, int octaves) {
  float sum = 0.0;
  float amplitude = 0.5;
  float total = 0.0;
  for (int i = 0; i < octaves; i++) {
    sum += amplitude * vnoise(p);
    total += amplitude;
    p = p * 2.03 + vec3(7.31, 3.17, 5.71);
    amplitude *= 0.5;
  }
  return sum / total;
}
// Distances to the nearest and second-nearest of points scattered one to a
// cell, and the nearest one's cell, for a random value per cell.
vec2 cells(vec2 p, out vec2 id) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 d = vec2(8.0);
  id = i;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 r = o + hash22(i + o) - f;
      float l = dot(r, r);
      if (l < d.x) {
        d = vec2(l, d.x);
        id = i + o;
      } else if (l < d.y) d.y = l;
    }
  }
  return sqrt(d);
}
vec2 cells(vec3 p, out vec3 id) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec2 d = vec2(8.0);
  id = i;
  for (int z = -1; z <= 1; z++) {
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec3 o = vec3(float(x), float(y), float(z));
        vec3 r = o + hash33(i + o) - f;
        float l = dot(r, r);
        if (l < d.x) {
          d = vec2(l, d.x);
          id = i + o;
        } else if (l < d.y) d.y = l;
      }
    }
  }
  return sqrt(d);
}
`;

// A normal bent by a height in world units, given at the surface and one
// pixel to the right and one up: Mikkelsen's bump mapping, with the
// derivatives taken by hand so fine detail stays crisp.
export const BUMP = /* glsl */ `
vec3 bumped(vec3 n, float h, float hx, float hy) {
  vec3 dpdx = dFdx(-vViewPosition);
  vec3 dpdy = dFdy(-vViewPosition);
  vec3 r1 = cross(dpdy, n);
  vec3 r2 = cross(n, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * ((hx - h) * r1 + (hy - h) * r2);
  return normalize(abs(det) * n - grad);
}
`;

// The wind: the tree sways from the roots, most at its crown, in slow gusts.
export const WIND = /* glsl */ `
uniform float uTime;
uniform float uWind;
uniform vec3 uRoot;
uniform float uCrown;
vec3 sway(vec3 p) {
  float h = max(0.0, (p.y - uRoot.y) / uCrown);
  float gust = 0.55 + 0.45 * sin(uTime * 0.31 + p.x * 0.0013);
  float s = 0.7 * sin(uTime * 1.3 + (p.x + p.z) * 0.004) + 0.3 * sin(uTime * 2.9 + p.y * 0.011);
  return vec3(1.0, 0.15, 0.45) * (s * gust * h * h * uWind);
}
`;

// Thin things lit from behind glow with the light coming through them, most
// when the light is straight beyond them. The light's color here already
// carries the shadow, so leaves deep in the canopy stay dark.
const THROUGH = /* glsl */ `
uniform vec3 uThrough;
void RE_Direct_Through(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
  RE_Direct_Physical(directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
  float back = saturate(dot(-geometryNormal, directLight.direction));
  float beyond = pow(saturate(dot(-geometryViewDir, directLight.direction)), 6.0);
  reflectedLight.directDiffuse += directLight.color * material.diffuseColor * uThrough * back * (0.3 + 1.0 * beyond);
}
#undef RE_Direct
#define RE_Direct RE_Direct_Through
`;

// The lantern's candle is the scene's only point light. What of it gets past
// the lantern's posts, bars, roof and base, and past the pot, is worked out
// for each point lit, by the line from the flame: no shadow map, and soft as
// the flame is wide. Every patched material shares these, by reference; the
// lantern sets them.
export const CANDLE = {
  uFlameAt: { value: new THREE.Vector3() }, // the flame's middle
  uFlameSize: { value: 1 }, // its radius
  uLanternAt: { value: new THREE.Vector4(0, 0, 1, 0) }, // its middle (x, z), and cos, sin of its turn
  uPanes: { value: new THREE.Vector4() }, // half width at the posts, the panes' bottom and top, the posts' width
  uHollow: { value: new THREE.Vector2() }, // the inside's floor and ceiling
  uEaves: { value: new THREE.Vector2() }, // the roof's underside past the panes, and how far out it reaches
  uBar: { value: 0 }, // the width of the bar down the middle of each side
  // A box inside the pot, which its tapering sides never come within.
  uPotLow: { value: new THREE.Vector3() },
  uPotHigh: { value: new THREE.Vector3() },
};

const CANDLE_LIGHT = /* glsl */ `
uniform vec3 uFlameAt;
uniform float uFlameSize;
uniform vec4 uLanternAt;
uniform vec4 uPanes;
uniform vec2 uHollow;
uniform vec2 uEaves;
uniform float uBar;
uniform vec3 uPotLow;
uniform vec3 uPotHigh;
vec3 lanternSpace(vec3 p) {
  vec2 d = p.xz - uLanternAt.xy;
  return vec3(d.x * uLanternAt.z - d.y * uLanternAt.w, p.y, d.x * uLanternAt.w + d.y * uLanternAt.z);
}
float candleReaches(vec3 world) {
  float seen = 1.0;
  vec3 f = lanternSpace(uFlameAt);
  vec3 x = lanternSpace(world);
  vec3 d = x - f;
  float a = uPanes.x;
  // Where the line crosses the lantern's sides, if it does before the point.
  vec2 s = vec2(d.x < 0.0 ? -1.0 : 1.0, d.z < 0.0 ? -1.0 : 1.0);
  vec2 t2 = (s * a - f.xz) / (s * max(abs(d.xz), vec2(1e-4)));
  float t = min(t2.x, t2.y);
  if (t >= 1.0) {
    // Within its sides: lit inside, not over its roof or under its base.
    seen = step(uHollow.x - 0.5, x.y) * step(x.y, uHollow.y + 0.5);
  } else {
    // Edges blur by the flame's size, the more the further past them.
    vec3 e = f + d * t;
    float w = uFlameSize * (1.0 - t) + 0.3;
    float across = abs(t2.x < t2.y ? e.z : e.x);
    float pane = smoothstep(uPanes.y - w, uPanes.y + w, e.y) * (1.0 - smoothstep(uPanes.z - w, uPanes.z + w, e.y));
    float posts = 1.0 - smoothstep(a - uPanes.w - w, a - uPanes.w + w, across);
    float bar = smoothstep(uBar * 0.5 - w, uBar * 0.5 + w, across);
    seen = pane * posts * bar * 0.92;
    // Out through the glass and up, it can still meet the eaves.
    float te = d.y > 0.0 ? (uEaves.x - f.y) / d.y : 2.0;
    if (te > t && te < 1.0) {
      vec3 g = f + d * te;
      float we = uFlameSize * (1.0 - te) + 0.3;
      seen *= smoothstep(uEaves.y - we, uEaves.y + we, max(abs(g.x), abs(g.z)));
    }
  }
  // The pot, as a box inside it: the longer the line's way through, the
  // darker.
  d = world - uFlameAt;
  vec3 way = vec3(d.x < 0.0 ? -1.0 : 1.0, d.y < 0.0 ? -1.0 : 1.0, d.z < 0.0 ? -1.0 : 1.0);
  vec3 reciprocal = 1.0 / (way * max(abs(d), vec3(1e-4)));
  vec3 t0 = (uPotLow - uFlameAt) * reciprocal;
  vec3 t1 = (uPotHigh - uFlameAt) * reciprocal;
  vec3 near = min(t0, t1);
  vec3 far = max(t0, t1);
  float through = (min(min(far.x, far.y), min(far.z, 1.0)) - max(max(near.x, near.y), max(near.z, 0.0))) * length(d);
  return seen * (1.0 - smoothstep(0.0, uFlameSize * 3.0, through));
}
`;

const POINT_LIGHT = "getPointLightInfo( pointLight, geometryPosition, directLight );";
const LIGHTS = THREE.ShaderChunk.lights_fragment_begin.replace(POINT_LIGHT, `${POINT_LIGHT}\n\t\tif ( directLight.visible ) directLight.color *= candleReaches( vWorld );`);
if (LIGHTS === THREE.ShaderChunk.lights_fragment_begin) throw new Error("three.js's point light code has changed");

// The scene is drawn into a multisampled target and averaged where an edge
// crosses a pixel. Averaged as light, a sky thirty times brighter than a leaf
// swallows the leaf's edge, and a backlit canopy turns to mist; averaged
// squeezed, each sample counts more evenly. The first pass after unsqueezes.
export const SQUEEZE = /* glsl */ `gl_FragColor.rgb /= 1.0 + max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b));`;
// A layer added over what's behind (blended One, OneMinusSrcAlpha) squeezes
// as its color would at its alpha's coverage, so the sum stays under one.
const SQUEEZE_LAYER = /* glsl */ `gl_FragColor.rgb /= 1.0 + max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b)) / max(gl_FragColor.a, 1e-3);`;

export type Hooks = {
  uniforms?: Record<string, THREE.IUniform>;
  vertexHead?: string; // declarations
  normal?: string; // may set `objectNormal`
  position?: string; // may move `transformed`, in the object's space
  vertexEnd?: string; // after `vWorld`, the world position, is set
  fragmentHead?: string;
  color?: string; // may change `diffuseColor`, using `vWorld`
  clip?: string; // may discard, after the alpha test
  roughness?: string; // may change `roughnessFactor`
  normalMap?: string; // may change `normal`, in view space
  lit?: string; // may change `material`
  emissive?: string; // may change `totalEmissiveRadiance`
  through?: THREE.Vector3; // light through it, by color
  layered?: boolean; // added over what's behind, its alpha the coverage
};

// Adds code to a built-in material. Every patched material gets `vWorld`,
// and the uniforms it is given, shared by reference.
export function patch<M extends THREE.Material>(material: M, name: string, hooks: Hooks): M {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, CANDLE, hooks.uniforms);
    if (hooks.through) shader.uniforms.uThrough = { value: hooks.through };
    const head = `#include <common>\n${NOISE}\nvarying vec3 vWorld;\n`;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `${head}${hooks.vertexHead ?? ""}`)
      .replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>\n${hooks.normal ?? ""}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${hooks.position ?? ""}`)
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
        vec4 realWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          realWorld = instanceMatrix * realWorld;
        #endif
        vWorld = (modelMatrix * realWorld).xyz;
        ${hooks.vertexEnd ?? ""}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `${head}${CANDLE_LIGHT}${hooks.fragmentHead ?? ""}`)
      .replace("#include <lights_fragment_begin>", LIGHTS)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${hooks.color ?? ""}`)
      .replace("#include <alphatest_fragment>", `#include <alphatest_fragment>\n${hooks.clip ?? ""}`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${hooks.roughness ?? ""}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${hooks.normalMap ?? ""}`)
      .replace("#include <lights_physical_fragment>", `#include <lights_physical_fragment>\n${hooks.lit ?? ""}`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n${hooks.emissive ?? ""}`)
      .replace("#include <dithering_fragment>", `#include <dithering_fragment>\n${hooks.layered ? SQUEEZE_LAYER : SQUEEZE}`);
    if (hooks.through) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <lights_physical_pars_fragment>",
        `#include <lights_physical_pars_fragment>\n${THROUGH}`,
      );
    }
  };
  material.customProgramCacheKey = () => name;
  return material;
}
