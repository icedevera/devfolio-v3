import * as THREE from "three";
import { random } from "../../scripts/canvas";
import { smooth } from "../noise";
import { framing } from "../depth";
import type { Scene } from "../scene";
import { NOISE, SQUEEZE } from "./glsl";

// The sky, worked out as sunlight scattered through the air (Preetham's
// model, as three.js's Sky has it), with clouds, and by night the stars, the
// Milky Way, the moon, and Manila's glow on the horizon. It lights the scene
// too: the sun or moon as the key light, and the whole sky as soft light from
// every side.

const RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];

// How much sunlight comes through the air from a height in the sky, `y` the
// sine of its elevation, per channel.
function extinction(y: number, rayleigh: number, turbidity: number, mie: number) {
  const zenith = Math.acos(Math.max(0, y));
  const air = 1 / (Math.cos(zenith) + 0.15 * Math.pow(93.885 - (zenith * 180) / Math.PI, -1.253));
  return RAYLEIGH.map((r, i) => Math.exp(-(r * rayleigh * 8.4e3 + 0.434 * 0.2 * turbidity * 10e-18 * MIE[i] * mie * 1.25e3) * air));
}

const toward = (azimuth: number, elevation: number) =>
  new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));

const degrees = Math.PI / 180;

const SHADER = {
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uSun;
    uniform vec3 uMoon;
    uniform float uMoonShow;
    uniform float uPhase;
    uniform float uMoonRadius;
    uniform float uSunRadius;
    uniform float uRayleigh;
    uniform float uTurbidity;
    uniform float uMie;
    uniform float uMieG;
    uniform float uTime;
    uniform float uDay;
    uniform float uNight;
    uniform float uTwilight;
    uniform float uCover;
    uniform float uSeed;
    uniform float uDiscs;
    uniform vec3 uCity;
    uniform vec3 uGround; // the land's light, seen from above, for light from below
    varying vec3 vDir;
    ${NOISE}

    const float PI_ = 3.141592653589793;
    const vec3 RAYLEIGH = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);
    const vec3 MIE = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);

    float sunPower(float cosZ) {
      return 1000.0 * max(0.0, 1.0 - exp(-((1.6110731556870734 - acos(clamp(cosZ, -1.0, 1.0))) / 1.5)));
    }
    vec3 betaR() { return RAYLEIGH * uRayleigh; }
    vec3 betaM() { return 0.434 * (0.2 * uTurbidity * 10E-18) * MIE * uMie; }
    vec3 extinction(float y) {
      float zenith = acos(clamp(y, 0.0, 1.0));
      float air = 1.0 / (cos(zenith) + 0.15 * pow(93.885 - zenith * 180.0 / PI_, -1.253));
      return exp(-(betaR() * 8.4E3 + betaM() * 1.25E3) * air);
    }
    // Light scattered toward us along d, from a sun along s.
    vec3 scatter(vec3 d, vec3 s) {
      // The air thickens toward the horizon, but not without end, or the
      // whole horizon burns white.
      vec3 fex = extinction(sqrt(mix(0.0256, 1.0, d.y * d.y)));
      float c = dot(d, s);
      float rPhase = 0.05968310365946075 * (1.0 + pow(c * 0.5 + 0.5, 2.0));
      float g2 = uMieG * uMieG;
      float mPhase = 0.07957747154594767 * (1.0 - g2) / pow(1.0 - 2.0 * uMieG * c + g2, 1.5);
      vec3 ratio = (betaR() * rPhase + betaM() * mPhase) / (betaR() + betaM());
      float e = sunPower(s.y);
      vec3 lin = pow(e * ratio * (1.0 - fex), vec3(1.5));
      lin *= mix(vec3(1.0), pow(e * ratio * fex, vec3(0.5)), clamp(pow(1.0 - s.y, 5.0), 0.0, 1.0));
      return lin * 0.04;
    }

    float cloudShape(vec2 p) {
      vec2 q = p + (vec2(fbm(p * 0.55 + uSeed, 3), fbm(p * 0.55 + uSeed + 11.3, 3)) - 0.5) * 1.6;
      float n = fbm(q + vec2(uTime * 0.006, uTime * 0.002), 6);
      return clamp((n - (1.0 - uCover)) / 0.3, 0.0, 1.0);
    }

    // Stars, each from its own cell of a lattice round the sky; a pixel looks
    // through its cell's neighbors too, so none is cut off at a cell's edge.
    vec3 stars(vec3 d) {
      vec3 sum = vec3(0.0);
      float footprint = length(fwidth(d));
      for (int layer = 0; layer < 3; layer++) {
        float scale = 90.0 * pow(1.9, float(layer));
        vec3 base = floor(d * scale);
        float w = footprint * scale;
        for (int z = -1; z <= 1; z++) {
          for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
              vec3 cell = base + vec3(float(x), float(y), float(z));
              float bright = pow(hash13(cell * 1.31 + 7.0 + float(layer) * 3.1), 24.0 - float(layer) * 4.0) * (3.0 - float(layer)) * 0.12;
              if (bright < 0.002) continue;
              vec3 h = hash33(cell + float(layer) * 17.0);
              float dist = length(normalize(cell + 0.2 + 0.6 * h) - d) * scale;
              float twinkle = 0.7 + 0.3 * sin(uTime * (1.5 + 3.0 * h.x) + h.y * 6.283);
              vec3 tint = mix(vec3(0.82, 0.88, 1.0), vec3(1.0, 0.92, 0.8), h.z);
              sum += tint * bright * twinkle * (1.0 - smoothstep(0.0, 0.09 + w, dist));
            }
          }
        }
      }
      return sum;
    }

    vec3 milkyWay(vec3 d) {
      vec3 n = normalize(vec3(0.42, 0.62, 0.66));
      vec3 core = normalize(vec3(-0.75, 0.32, -0.58));
      float across = dot(d, n) + 0.05 * (fbm(d * 7.0, 3) - 0.5);
      float band = exp(-pow(across / 0.16, 2.0));
      float clumps = fbm(d * 9.0 + 3.0, 5);
      float dust = smoothstep(0.45, 0.68, fbm(d * 14.0 + 9.0, 4)) * exp(-pow(across / 0.05, 2.0));
      float glow = band * (0.35 + 0.9 * clumps * clumps) * (1.0 - 0.75 * dust);
      float heart = exp(-pow(acos(clamp(dot(d, core), -1.0, 1.0)) / 0.7, 2.0));
      return glow * mix(vec3(0.5, 0.56, 0.72), vec3(0.95, 0.78, 0.6), heart) * (0.012 + 0.03 * heart);
    }

    // The moon for its phase: its seas, a few craters, and the earthshine on
    // its dark side.
    vec4 moonDisc(vec3 d) {
      vec3 right = normalize(cross(uMoon, vec3(0.0, 1.0, 0.0)));
      vec3 up = cross(right, uMoon);
      vec2 q = vec2(dot(d, right), dot(d, up)) / uMoonRadius;
      float r = length(q);
      if (dot(d, uMoon) < 0.0 || r > 1.2) return vec4(0.0);
      float w = fwidth(r);
      float edge = 1.0 - smoothstep(1.0 - max(w * 1.5, 1e-4), 1.0, r);
      vec3 n = vec3(q, sqrt(max(0.0, 1.0 - r * r)));
      float angle = uPhase * 6.2831853;
      vec3 light = vec3(sin(angle), 0.0, -cos(angle));
      float facing = dot(n, light);
      float seas = smoothstep(0.45, 0.62, fbm(q * 1.6 + 4.0, 4));
      vec2 id;
      vec2 c = cells(q * 7.0, id);
      float crater = (1.0 - smoothstep(0.2, 0.32, c.x)) * step(0.6, hash12(id)) * 0.25;
      float albedo = (1.0 - 0.42 * seas) * (1.0 - crater) * (0.9 + 0.2 * fbm(q * 12.0, 3));
      float lit = smoothstep(-0.03, 0.08, facing) * mix(1.0, sqrt(max(facing, 0.0)), 0.35);
      vec3 col = vec3(1.0, 0.96, 0.88) * albedo * (lit * 1.6 + 0.012);
      return vec4(col, edge);
    }

    void main() {
      vec3 d = normalize(vDir);
      vec3 view = vec3(d.x, max(d.y, 0.0005), d.z);
      vec3 sky = scatter(view, uSun);
      // After sunset the glow lingers on the horizon where it set.
      vec3 below = normalize(vec3(uSun.x, 0.035, uSun.z));
      sky += scatter(view, below) * uTwilight;
      // A soft ceiling: the model makes the sky round a low sun some thirty
      // times brighter than the land, which a camera would only flare at.
      sky /= 1.0 + sky / 8.0;
      sky += vec3(0.00035, 0.0005, 0.0011) * (1.0 + 2.0 * (1.0 - view.y));
      vec3 fex = extinction(view.y);

      // The sun's disc, darker at its edge.
      float c = dot(d, uSun);
      float disc = smoothstep(cos(uSunRadius), cos(uSunRadius * 0.92), c);
      float limb = sqrt(max(0.0, 1.0 - pow(acos(clamp(c, -1.0, 1.0)) / uSunRadius, 2.0)));
      sky += uDiscs * disc * (0.6 + 0.4 * limb) * min(sunPower(uSun.y) * extinction(uSun.y), vec3(40.0)) * 2.0;

      // By night.
      if (uNight > 0.0) {
        float clear = smoothstep(-0.02, 0.12, d.y);
        // Stars only where they are seen: in the light from the sky they are
        // nothing, and drawn small into the cube they would blur to a glow.
        vec3 night = ((uDiscs > 0.5 ? stars(d) * fex : vec3(0.0)) + milkyWay(d)) * clear * uNight;
        float city = pow(max(0.0, dot((view.xz / max(length(view.xz), 1e-5)), uCity.xz)), 3.0) * exp(-view.y / 0.07);
        night += vec3(1.0, 0.55, 0.26) * city * 0.0022 * uNight;
        if (uMoonShow > 0.0) {
          vec4 moon = moonDisc(d);
          float halo = exp(-acos(clamp(dot(d, uMoon), -1.0, 1.0)) / (uMoonRadius * 3.0));
          night = mix(night, moon.rgb * 1.4, moon.a * uDiscs) + vec3(0.6, 0.66, 0.8) * halo * 0.01 * uMoonShow;
        }
        sky += night;
      }

      // Clouds: a layer over the land, lit from the sun, or the moon by night.
      if (d.y > 0.0 && uCover > 0.0) {
        vec2 p = d.xz / (d.y + 0.07) * 2.0;
        float dens = cloudShape(p);
        if (dens > 0.0) {
          vec3 from = uDay > 0.5 ? uSun : uMoon;
          vec2 step2 = normalize(from.xz + 1e-4) * 0.07;
          float over = cloudShape(p + step2) + 0.7 * cloudShape(p + step2 * 2.5);
          float lit = exp(-over * 1.6);
          float g = 0.6;
          float silver = 0.0795775 * (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * dot(d, from), 1.5);
          vec3 sunlight = sunPower(uSun.y) * extinction(uSun.y) * 0.0045 * uDay
            + vec3(0.5, 0.58, 0.8) * 0.0025 * uMoonShow * (1.0 - uDay);
          vec3 ambient = 0.6 * (scatter(vec3(0.0, 1.0, 0.0), uSun) + scatter(normalize(vec3(d.x, 0.15, d.z)), uSun))
            + vec3(0.0006, 0.0008, 0.0014)
            + vec3(1.0, 0.55, 0.26) * 0.0015 * uNight * pow(max(0.0, dot((view.xz / max(length(view.xz), 1e-5)), uCity.xz)), 2.0);
          float thin = 1.0 - dens;
          vec3 cloud = ambient * (0.55 + 0.45 * thin) + sunlight * lit * (0.65 + 0.35 * thin + silver * thin * 5.0);
          float alpha = (1.0 - exp(-dens * 5.0)) * smoothstep(0.0, 0.12, d.y);
          cloud = mix(sky, cloud, 0.35 + 0.65 * fex);
          sky = mix(sky, cloud, alpha);
        }
      }
      // Below the horizon: haze far off; for light from every side, the land.
      if (d.y < 0.0) sky = uDiscs > 0.5 ? sky * 0.6 : mix(sky * 0.6, uGround, 1.0 - smoothstep(-0.08, 0.0, d.y));
      gl_FragColor = vec4(sky, 1.0);
      // Squeezed as the scene is, though not into the cube of light.
      if (uDiscs > 0.5) { ${SQUEEZE} }
    }`,
};

export type Atmosphere = {
  dome: THREE.Mesh; // add to the scene, and keep it where the camera is
  sun: THREE.Vector3; // toward it, a unit vector
  key: THREE.Vector3; // toward the key light: the sun, or the moon at night
  light: THREE.Color; // the key light, color and strength
  exposure: number;
  environment: THREE.Texture; // the sky as light, for every surface
  haze: THREE.Texture; // the sky round the horizon, for distant land
  day: number;
  tick: (t: number) => void;
  dispose: () => void;
};

export async function createAtmosphere(renderer: THREE.WebGLRenderer, s: Scene, radius: number): Promise<Atmosphere> {
  const rand = random(s.seed ^ 0x51c7);
  const elevation = s.sky.elevation;
  const hour = s.sky.body === "sun" ? 6 + 12 * s.sky.progress : 18 + 12 * s.sky.progress;
  // The sun or moon stands over where the picture has it, at its true
  // height; the sun out of sight goes round from the left, the east, to the
  // right.
  const seen = framing(s).toward2D(s.body.x, s.body.y);
  const across = Math.atan2(seen.x, -seen.z);
  const moonUp = s.sky.body === "moon";
  const sun = toward(moonUp ? ((hour - 6) / 12 - 0.5) * Math.PI : across, elevation * degrees);
  const moon = moonUp ? toward(across, (12 + 42 * Math.sin(Math.PI * Math.min(1, Math.max(0, s.sky.progress)))) * degrees) : new THREE.Vector3(0, -1, 0);

  // Low sun: hazier, redder air. Once it has set, the night air clears.
  const golden = smooth(22, 2, elevation) * smooth(-10, -3, elevation);
  const rayleigh = 1 + 1.6 * golden;
  const turbidity = 2 + 4 * golden;
  const mie = 0.003 + 0.005 * golden;
  const day = smooth(-4, 2, elevation);
  const twilight = smooth(-14, -2, elevation) * (1 - smooth(-2, 4, elevation)) * 0.12;
  const fullness = 1 - Math.abs(s.sky.phase - 0.5) * 2; // 1 at full moon

  const uniforms = {
    uSun: { value: sun },
    uMoon: { value: moon },
    uMoonShow: { value: moonUp ? 1 : 0 },
    uPhase: { value: s.sky.phase },
    uMoonRadius: { value: ((s.body.radius / (s.height / 2 / Math.tan((15 * Math.PI) / 180))) * 0.6) },
    uSunRadius: { value: 0.0065 },
    uRayleigh: { value: rayleigh },
    uTurbidity: { value: turbidity },
    uMie: { value: mie },
    uMieG: { value: 0.8 },
    uTime: { value: 0 },
    uDay: { value: day },
    uNight: { value: s.night },
    uTwilight: { value: twilight },
    uCover: { value: 0.36 + 0.2 * rand() },
    uSeed: { value: rand() * 100 },
    uDiscs: { value: 1 },
    uCity: { value: toward(-2.3, 0) },
    uGround: { value: new THREE.Vector3() },
  };
  const material = new THREE.ShaderMaterial({ ...SHADER, uniforms, side: THREE.BackSide, depthWrite: false, depthTest: false });
  const geometry = new THREE.SphereGeometry(radius, 96, 48);
  const dome = new THREE.Mesh(geometry, material);
  dome.renderOrder = -10;
  dome.frustumCulled = false;

  // The key light: the sun through the air, or the moon, waxing and waning.
  const fex = extinction(sun.y, rayleigh, turbidity, mie);
  const peak = Math.max(...fex);
  const sunUp = smooth(-1.5, 3, elevation);
  const light = new THREE.Color(fex[0] / peak, fex[1] / peak, fex[2] / peak);
  const luminance = 0.2126 * fex[0] + 0.7152 * fex[1] + 0.0722 * fex[2];
  const key = sunUp > 0.05 || !moonUp ? sun : moon;
  if (key === sun) light.multiplyScalar(12 * luminance * sunUp);
  else light.setRGB(0.55, 0.66, 1).multiplyScalar(0.05 + 0.35 * fullness);

  // The land as the key light and the sky light it, for the light it
  // throws back up: grass and earth, under a sky about a third as bright as
  // the sun at midday.
  const skyLight = 0.38 * day * ((light.r + light.g + light.b) / 3) + 0.004;
  const land = light.clone().multiplyScalar(Math.max(0, key.y)).addScalar(skyLight).multiply(new THREE.Color(0.06, 0.075, 0.035)).multiplyScalar(1 / Math.PI);
  uniforms.uGround.value.set(land.r, land.g, land.b);

  // The sky once into a cube, without the sun's disc (the key light is the
  // sun), then blurred for light from every side. These are the first things
  // here the GPU holds, so if making them fails, they're freed before it's
  // passed on.
  const cubeTarget = new THREE.WebGLCubeRenderTarget(256, {
    type: THREE.HalfFloatType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
  });
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envTarget: THREE.WebGLRenderTarget;
  try {
    const cubeCamera = new THREE.CubeCamera(1, radius * 2, cubeTarget);
    const cubeScene = new THREE.Scene();
    cubeScene.add(new THREE.Mesh(geometry, material));
    uniforms.uDiscs.value = 0;
    await renderer.compileAsync(cubeScene, new THREE.PerspectiveCamera());
    cubeCamera.update(renderer, cubeScene);
    uniforms.uDiscs.value = 1;
    await prepare(pmrem, renderer, cubeTarget.width);
    envTarget = pmrem.fromCubemap(cubeTarget.texture);
  } catch (error) {
    for (const item of [cubeTarget, geometry, material]) item.dispose();
    throw error;
  } finally {
    pmrem.dispose();
  }

  // The camera's exposure for the hour, as a photographer would set it:
  // stopped down at midday, opened up as the light goes.
  const stops: [number, number][] = [
    [-14, 4.5],
    [-4, 2.2],
    [2, 1],
    [8, 0.55],
    [25, 0.3],
    [50, 0.26],
  ];
  const above = stops.findIndex(([e]) => e > elevation);
  const k = above < 0 ? stops.length - 2 : Math.max(0, above - 1);
  const [[e0, x0], [e1, x1]] = [stops[k], stops[k + 1]];
  const exposure = Math.exp(THREE.MathUtils.lerp(Math.log(x0), Math.log(x1), THREE.MathUtils.clamp((elevation - e0) / (e1 - e0), 0, 1)));

  return {
    dome,
    sun,
    key,
    light,
    exposure,
    environment: envTarget.texture,
    haze: cubeTarget.texture,
    day,
    tick(t) {
      uniforms.uTime.value = t;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      cubeTarget.dispose();
      envTarget.dispose();
    },
  };
}

// PMREM compiles its blurring shaders the first time it draws with them, and
// the page waits half a second on that. Made here first, they compile in
// parallel instead. This reaches inside three r186's PMREMGenerator; if it
// ever changes shape, the shaders just compile when first drawn, as before.
async function prepare(pmrem: THREE.PMREMGenerator, renderer: THREE.WebGLRenderer, size: number) {
  const inside = pmrem as unknown as {
    _setSize?: (size: number) => void;
    _allocateTargets?: () => THREE.WebGLRenderTarget;
    _cubemapMaterial?: THREE.Material | null;
    _blurMaterial?: THREE.Material | null;
    _ggxMaterial?: THREE.Material | null;
    _lodMeshes?: THREE.Mesh[];
  };
  if (typeof inside._setSize !== "function" || typeof inside._allocateTargets !== "function") return;
  inside._setSize(size);
  inside._allocateTargets().dispose();
  pmrem.compileCubemapShader();
  // Its own planes, as shaders are compiled for what a geometry carries.
  const geometry = inside._lodMeshes?.[0]?.geometry;
  if (!geometry) return;
  const scene = new THREE.Scene();
  for (const material of [inside._cubemapMaterial, inside._blurMaterial, inside._ggxMaterial]) {
    if (material instanceof THREE.Material) scene.add(new THREE.Mesh(geometry, material));
  }
  await renderer.compileAsync(scene, new THREE.OrthographicCamera());
}
