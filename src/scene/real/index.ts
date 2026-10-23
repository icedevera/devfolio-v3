/*! three.js is MIT-licensed: its license is at /licenses.txt */
import * as THREE from "three";
import { random } from "../../scripts/canvas";
import { compileGently, compileShadows, framing, warm } from "../depth";
import { smooth } from "../noise";
import type { Petal, Scene } from "../scene";
import { createAtmosphere } from "./atmosphere";
import { createLand } from "./land";
import { createLantern } from "./lantern";
import { createPlant, type Wind } from "./plant";
import { createPot } from "./pot";
import { createPost } from "./post";
import { pause } from "../slices";

// The last stage: the same tree on the same hills, as a camera would see
// them. Everything is lit by the sky it stands under, through the air, and
// photographed: exposed for the hour, out of focus far off, on film.

export type Real = {
  // `closer` is how far the camera has come in toward the tree, 0 to 1;
  // `t` the clock the wind and sky move by, in seconds; `alone` whether this
  // is the only stage drawing, so its frame times are its own.
  render: (turn: number, tilt: number, closer: number, petals: Petal[], t: number, alone: boolean) => void;
  // Whether it has dropped all it can to keep up with a slow GPU.
  lean: () => boolean;
  dispose: () => void;
};

type Disposable = { dispose: () => void };


// `hidden` says its canvas isn't showing anything yet, so it may be sized and
// drawn on ahead; otherwise the canvas keeps its last picture until this
// stage's first frame.
export async function createReal(canvas: HTMLCanvasElement, s: Scene, hidden: boolean): Promise<Real> {
  // Everything made is freed in reverse, so the renderer goes last: once
  // disposed it forgets what it holds on the GPU, and nothing after it frees.
  const disposables: Disposable[] = [];
  const release = () => {
    for (const item of disposables.reverse()) item.dispose();
    disposables.length = 0;
  };
  // A context lost partway leaves three waiting forever on shaders that
  // can't finish compiling. Releasing the renderer ends that wait, the build
  // refuses to compile more (see build), and it fails.
  let lost = false;
  const lose = () => {
    lost = true;
    release();
  };
  canvas.addEventListener("webglcontextlost", lose);
  try {
    const real = await build(canvas, s, hidden, disposables, release);
    if (lost) throw new Error("The WebGL context was lost while building");
    return real;
  } catch (error) {
    release();
    throw error;
  } finally {
    canvas.removeEventListener("webglcontextlost", lose);
  }
}

async function build(canvas: HTMLCanvasElement, s: Scene, hidden: boolean, disposables: Disposable[], release: () => void): Promise<Real> {
  const { width: W, height: H, layout: l, skeleton } = s;
  const { pot } = skeleton;
  const { distance: D, eye, at, lens } = framing(s);
  const coarse = matchMedia("(pointer: coarse)").matches;
  const rand = random(s.seed ^ 0x4ea1);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
  // The canvas keeps its context for the next build, so leave it as found.
  disposables.push({
    dispose() {
      renderer.resetState();
      renderer.dispose();
    },
  });
  // Shader compiler notes are for development; visitors' consoles stay quiet.
  renderer.debug.checkShaderErrors = import.meta.env.DEV;
  // Compiling on a lost context would wait forever, so it fails instead.
  const compileAsync = renderer.compileAsync.bind(renderer);
  renderer.compileAsync = (scene, camera, target) =>
    renderer.getContext().isContextLost() ? Promise.reject(new Error("The WebGL context was lost")) : compileAsync(scene, camera, target);
  // Sizing the canvas clears it, so it's sized just before something is
  // drawn on it.
  const ratio = Math.min(devicePixelRatio || 1, 2);
  let fitted = false;
  const fit = () => {
    if (fitted) return;
    fitted = true;
    renderer.setDrawingBufferSize(W, H, ratio);
  };
  renderer.setClearColor(0x000000, 1);
  // Everything renders into linear targets and the film pass encodes for the
  // screen itself, so shaders compiled ahead match the ones drawn with.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  const scene = new THREE.Scene();

  const atmosphere = await createAtmosphere(renderer, s, D * 10);
  disposables.push(atmosphere);
  scene.add(atmosphere.dome);
  scene.environment = atmosphere.environment;
  // By night, a little more of the sky's own light in the shade, as eyes
  // adjusted to the dark would see it.
  scene.environmentIntensity = 1 + 0.8 * s.night;
  await pause();

  // The tree's reach round the pot, and its crown.
  const groundY = H / 2 - pot.foot;
  const center = pot.center - W / 2;
  const root = at(skeleton.soil.x, skeleton.soil.y);
  const hearts = skeleton.leaves.map((leaf) => at(leaf.x, leaf.y, leaf.z));
  const reach = Math.max(l.cw * 12, ...hearts.map((h) => Math.hypot(h.x - center, h.z)));
  const crown = Math.max(l.ch * 6, ...hearts.map((h) => h.y - root.y));
  const middle = hearts.reduce((sum, h) => sum.add(h), new THREE.Vector3()).divideScalar(Math.max(1, hearts.length));

  const land = await createLand(s, { distance: D, groundY, center, reach, grass: coarse ? 28000 : 80000 });
  disposables.push(land);
  scene.add(land.group);
  await pause();
  const vessel = createPot(s);
  disposables.push(vessel);
  scene.add(vessel.group);

  // A light breeze, some days more than others.
  const breeze = 0.6 + 0.8 * rand();
  const wind: Wind = {
    uTime: land.uniforms.uTime,
    uWind: { value: 2.2 * breeze },
    uFlutter: { value: 0.07 * breeze },
    uRoot: { value: root },
    uCrown: { value: crown },
  };
  land.uniforms.uGrassWind.value = 0.4 + 0.5 * breeze;
  const restAt = (x: number, z: number) => (vessel.inside(x, z) ? vessel.soilY : land.restAt(x, z));
  const plant = await createPlant(s, wind, restAt);
  disposables.push(plant);
  scene.add(plant.group);
  await pause();

  // The sun, or the moon, and the shadows it casts round the tree.
  const key = new THREE.DirectionalLight(atmosphere.light, 1);
  const aim = new THREE.Vector3(center, groundY + crown * 0.3, 0);
  key.position.copy(aim).addScaledVector(atmosphere.key, D * 1.5);
  key.target.position.copy(aim);
  key.castShadow = true;
  key.shadow.mapSize.setScalar(coarse ? 2048 : 4096);
  const box = Math.max(reach * 1.35, D * 0.46);
  Object.assign(key.shadow.camera, { left: -box, right: box, top: box, bottom: -box, near: D * 0.3, far: D * 3 });
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.5;
  key.shadow.radius = 2;
  scene.add(key, key.target);
  disposables.push(key);

  // Motes in the sunlight by day; fireflies by night. They're added as light
  // after the scene, where its depth shows them.
  const night = atmosphere.day < 0.5;
  const MOTES = night ? 70 : 500;
  const motePositions = new Float32Array(MOTES * 3);
  const moteSeeds = new Float32Array(MOTES);
  for (let i = 0; i < MOTES; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * reach * (night ? 2.2 : 1.4);
    motePositions.set([center + Math.cos(a) * r, groundY + 4 + rand() * crown * (night ? 0.8 : 1.3), Math.sin(a) * r * 0.8], i * 3);
    moteSeeds[i] = rand();
  }
  const moteGeometry = new THREE.BufferGeometry();
  moteGeometry.setAttribute("position", new THREE.BufferAttribute(motePositions, 3));
  moteGeometry.setAttribute("aSeed", new THREE.BufferAttribute(moteSeeds, 1));
  const moteUniforms = {
    uTime: land.uniforms.uTime,
    uSun: { value: atmosphere.sun },
    uLight: { value: atmosphere.light },
    uNight: { value: night ? 1 : 0 },
    uViewport: { value: H },
    uSize: { value: new THREE.Vector2(W, H) },
    uExposure: { value: atmosphere.exposure },
    tDepth: { value: null as THREE.Texture | null },
  };
  const moteMaterial = new THREE.ShaderMaterial({
    uniforms: moteUniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      uniform float uNight;
      uniform float uViewport;
      varying float vGlow;
      varying vec3 vToward;
      void main() {
        float t = uTime * (0.15 + 0.2 * aSeed) + aSeed * 60.0;
        vec3 drift = vec3(sin(t * 1.3), sin(t * 0.9 + 2.0) * 0.6, cos(t * 1.1)) * mix(14.0, 40.0, uNight);
        vec4 world = modelMatrix * vec4(position + drift, 1.0);
        vec4 view = viewMatrix * world;
        gl_Position = projectionMatrix * view;
        vToward = normalize(world.xyz - cameraPosition);
        // Fireflies glow a while, then rest.
        float blink = smoothstep(0.55, 0.85, sin(uTime * (0.7 + 0.6 * aSeed) + aSeed * 40.0));
        vGlow = mix(0.6 + 0.4 * sin(uTime * 3.0 + aSeed * 9.0), blink, uNight);
        float size = mix(0.25 + 0.3 * aSeed, 1.6, uNight);
        gl_PointSize = clamp(size * projectionMatrix[1][1] * uViewport * 0.5 / -view.z, 1.5, 24.0);
        // None right in front of the lens.
        vGlow *= smoothstep(20.0, 60.0, -view.z);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun;
      uniform vec3 uLight;
      uniform float uNight;
      uniform vec2 uSize;
      uniform float uExposure;
      uniform sampler2D tDepth;
      varying float vGlow;
      varying vec3 vToward;
      void main() {
        if (gl_FragCoord.z > texture(tDepth, gl_FragCoord.xy / uSize).x) discard;
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float disc = exp(-r * r * 4.0) * (1.0 - smoothstep(0.8, 1.0, r));
        // Dust shows against the light, as it scatters it forward.
        float forward = 0.0796 * 0.36 / pow(1.64 - 1.6 * dot(vToward, uSun), 1.5);
        vec3 dust = mix(uLight, vec3(dot(uLight, vec3(0.33))), 0.6) * forward * 0.02;
        vec3 fly = vec3(0.75, 1.0, 0.3) * 6.0;
        gl_FragColor = vec4(mix(dust, fly, uNight) * disc * vGlow * uExposure, 1.0);
      }`,
  });
  const motes = new THREE.Points(moteGeometry, moteMaterial);
  motes.frustumCulled = false;
  motes.onBeforeRender = (r) => {
    const target = r.getRenderTarget();
    if (!target) return;
    moteUniforms.uViewport.value = target.height;
    moteUniforms.uSize.value.set(target.width, target.height);
  };
  const overlay = new THREE.Scene();
  overlay.add(motes);
  disposables.push(moteGeometry, moteMaterial);

  // A candle lantern beside the pot, lit from dusk.
  const lantern = createLantern(s, {
    restAt: land.restAt,
    away: atmosphere.key,
    overlay: { uTime: land.uniforms.uTime, uSize: moteUniforms.uSize, tDepth: moteUniforms.tDepth, uExposure: moteUniforms.uExposure },
  });
  disposables.push(lantern);
  scene.add(lantern.group);
  overlay.add(lantern.glow);
  await pause();

  const camera = new THREE.PerspectiveCamera();
  lens(camera, 4, D * 12);
  // Ambient occlusion only near the tree, where it shows.
  const clip = new THREE.Box3(new THREE.Vector3(center - box, groundY - 140, -box), new THREE.Vector3(center + box, groundY + crown * 1.3, box));
  const post = createPost(
    renderer,
    atmosphere.haze,
    { clear: D * 1.3, thickness: D * (night ? 5 : 3), floor: groundY - D * 0.42, scale: D * 0.45, sunLight: atmosphere.light },
    clip,
    overlay,
    W,
    H,
    ratio,
  );
  disposables.push(post);
  moteUniforms.tDepth.value = post.depth;

  // The camera's white balance: a daylight sky's blue taken out of the
  // shade, the warmth of a low sun and the blue of the moon left in.
  const golden = smooth(20, 4, s.sky.elevation);
  const balance = new THREE.Color(1, 1, 1).lerp(new THREE.Color(1.06, 1, 0.86), atmosphere.day * (1 - golden));

  // Draws the shadows now and then, as the wind barely moves them.
  let frames = 0;
  let last = performance.now();
  const target = new THREE.Vector3();
  const look = new THREE.Vector3(0, eye, 0);
  const canopy = new THREE.Vector3(middle.x * 0.7 + center * 0.3, middle.y * 0.6 + root.y * 0.4, middle.z * 0.5);
  const place = (turn: number, tilt: number, closer: number) => {
    // Nearer, the camera looks into the canopy.
    const far = D / (1 + 1.6 * closer);
    target.copy(look).lerp(canopy, smooth(0, 1, closer));
    camera.position.set(target.x + Math.sin(turn) * far, target.y + Math.sin(tilt) * far, target.z + Math.cos(turn) * Math.cos(tilt) * far);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    atmosphere.dome.position.copy(camera.position);
  };

  place(0, 0, 0);
  renderer.shadowMap.needsUpdate = true;
  await compileGently(renderer, scene, camera);
  await compileShadows(renderer, scene, camera, disposables);
  await compileGently(renderer, overlay, camera);
  await post.compile();
  // Not if the context was lost meanwhile: the page has given its canvas up.
  if (hidden && !renderer.getContext().isContextLost()) fit();
  await warm(renderer, scene, camera, { draw: hidden });

  return {
    render(turn, tilt, closer, petals, t, alone) {
      fit();
      const now = performance.now();
      if (alone) post.pace((now - last) / 1000);
      last = now;
      land.uniforms.uTime.value = t;
      atmosphere.tick(t);
      lantern.tick(t);
      plant.fall(petals);
      place(turn, tilt, closer);
      // A slow GPU gets coarser shadows, drawn less often. The new map is
      // drawn at once: nothing can be drawn with none.
      if (post.lean() && key.shadow.mapSize.x > 1024) {
        key.shadow.mapSize.setScalar(1024);
        key.shadow.map?.dispose();
        key.shadow.map = null;
        frames = 0;
      }
      renderer.shadowMap.needsUpdate = frames++ % (post.lean() ? 4 : 2) === 0;
      post.render(scene, camera, {
        exposure: atmosphere.exposure,
        sun: atmosphere.sun,
        shafts: atmosphere.day * 0.3,
        focus: camera.position.distanceTo(target),
        aperture: 0.2 + 0.7 * closer,
        time: t,
        balance,
      });
    },
    lean: post.lean,
    dispose: release,
  };
}
