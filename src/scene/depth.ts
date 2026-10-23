/*! three.js is MIT-licensed: its license is at /licenses.txt */
import * as THREE from "three";
import { random } from "../scripts/canvas";
import { hash, noise, smooth } from "./noise";
import { css } from "./sky";
import { plainStops, ridgeLine, type Petal, type Ridge, type Scene } from "./scene";
import { pause, slicer } from "./slices";
import { mix, type RGB } from "./sky";
import { BARK, BLOSSOM, GLAZE, LEAF, MOSS, ramp, resample, type Joint } from "./tree";

// The last stage: the same tree, pot and hills in 3D, in a whole world the
// camera can turn all the way round. At first the camera sees exactly the 2D
// picture, with the scene's middle plane at one unit per CSS pixel; then it
// starts to turn and the depth shows.

const SIDES = 10;
const PETALS = 64;

export type Depth = {
  // `t` is the clock the sky moves by, in seconds.
  render: (turn: number, tilt: number, petals: Petal[], t: number) => void;
  // Settles once its shaders are compiled and everything it draws is on the
  // GPU, so its first frame waits on nothing.
  ready: Promise<void>;
  dispose: () => void;
};

export const color = (c: RGB) => new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);

// A small texture drawn on a canvas.
function canvasTexture(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx) draw(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Bark: light wood with dark fissures running along it, seamless around the
// limb. Mirrored along it, so its ends never show a seam.
function barkTexture() {
  const texture = canvasTexture(64, 256, (ctx) => {
    const image = ctx.createImageData(64, 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 64; x++) {
        const a = (x / 64) * Math.PI * 2;
        const n = noise(Math.cos(a) * 2.2, Math.sin(a) * 2.2, y * 0.035);
        const v = 255 * (0.72 + 0.28 * Math.min(1, Math.abs(n) * 4) + 0.06 * noise(x * 0.5, y * 0.5, 9));
        const k = (y * 64 + x) * 4;
        image.data[k] = image.data[k + 1] = image.data[k + 2] = Math.min(255, v);
        image.data[k + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  });
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.MirroredRepeatWrapping;
  return texture;
}

// Glaze: speckled, as the 2D pot is.
const glazeTexture = () =>
  canvasTexture(256, 64, (ctx) => {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 256, 64);
    const rand = random(0x91a2e);
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = `rgb(${rand() < 0.7 ? "150 150 160" : "255 255 255"} / ${0.25 + rand() * 0.4})`;
      ctx.fillRect(rand() * 256, rand() * 64, 0.8 + rand(), 0.8 + rand());
    }
  });

const tiled = (texture: THREE.Texture) => {
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
};

// White shapes on clear, tinted per instance: a leaf, a cherry flower and a
// fallen petal.
const leafTexture = () =>
  canvasTexture(64, 32, (ctx) => {
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.moveTo(2, 16);
    ctx.quadraticCurveTo(32, -2, 62, 16);
    ctx.quadraticCurveTo(32, 34, 2, 16);
    ctx.fill();
    ctx.strokeStyle = "rgb(200 200 200)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(6, 16);
    ctx.lineTo(58, 16);
    ctx.stroke();
  });

const flowerTexture = () =>
  canvasTexture(64, 64, (ctx) => {
    ctx.translate(32, 32);
    ctx.fillStyle = "#fff";
    for (let p = 0; p < 5; p++) {
      const a = (p * Math.PI * 2) / 5 - Math.PI / 2;
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * 14, Math.sin(a) * 14, 15, 11, a, 0, Math.PI * 2);
      ctx.fill();
    }
    const heart = ctx.createRadialGradient(0, 0, 0, 0, 0, 12);
    heart.addColorStop(0, "rgb(255 236 190)");
    heart.addColorStop(0.35, "rgb(176 120 136)");
    heart.addColorStop(1, "rgb(255 255 255 / 0)");
    ctx.fillStyle = heart;
    ctx.beginPath();
    ctx.arc(0, 0, 12, 0, Math.PI * 2);
    ctx.fill();
  });

const petalTexture = () =>
  canvasTexture(32, 32, (ctx) => {
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.ellipse(16, 16, 14, 10, 0, 0, Math.PI * 2);
    ctx.fill();
  });

// The outline of a rounded rectangle on the ground plane.
function roundedRect(width: number, depth: number, radius: number, steps = 8) {
  const hw = width / 2;
  const hd = depth / 2;
  const r = Math.min(radius, hw, hd);
  const points: [number, number][] = [];
  const corners = [
    [hw - r, hd - r],
    [-(hw - r), hd - r],
    [-(hw - r), -(hd - r)],
    [hw - r, -(hd - r)],
  ];
  corners.forEach(([cx, cz], q) => {
    for (let i = 0; i <= steps; i++) {
      const a = ((q + i / steps) * Math.PI) / 2;
      points.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
  });
  return points;
}

export type Ring = { y: number; width: number; depth: number; radius: number };

// The sides of a rounded box that may taper: its outline at each height,
// joined top to bottom, with a lid on the first. Textures map a pixel to a
// unit, around and down.
export function shell(rings: Ring[], steps = 8) {
  const outlines = rings.map((ring) => roundedRect(ring.width, ring.depth, ring.radius, steps));
  const count = outlines[0].length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  outlines.forEach((outline, j) => {
    let around = 0;
    outline.forEach(([x, z], i) => {
      if (i > 0) around += Math.hypot(x - outline[i - 1][0], z - outline[i - 1][1]);
      positions.push(x, rings[j].y, z);
      uvs.push(around / 256, rings[j].y / 64);
    });
  });
  for (let j = 0; j < rings.length - 1; j++) {
    for (let i = 0; i < count; i++) {
      const a = j * count + i;
      const b = j * count + ((i + 1) % count);
      indices.push(a, b, a + count, b, b + count, a + count);
    }
  }
  const lid = positions.length / 3;
  positions.push(0, rings[0].y, 0);
  uvs.push(0, rings[0].y / 64);
  for (let i = 0; i < count; i++) indices.push(lid, (i + 1) % count, i);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// How the 3D stages see the picture. The camera stands `distance` in front,
// its eye level with the pot's rim, where the picture's middle plane is one
// unit per CSS pixel.
export function framing(s: Scene) {
  const { width: W, height: H } = s;
  const { pot } = s.skeleton;
  const fov = 30;
  const distance = H / 2 / Math.tan((fov * Math.PI) / 360);
  const eye = H / 2 - pot.top;
  // A point of the picture at depth `z`, set nearer the middle the nearer it
  // is, so from the front it falls exactly where the picture has it.
  const at = (x: number, y: number, z = 0) => {
    const k = (distance - z) / distance;
    return new THREE.Vector3((x - W / 2) * k, eye + (H / 2 - y - eye) * k, z);
  };
  // Where the camera, before it turns, sees a point of the picture.
  const toward2D = (x: number, y: number) => new THREE.Vector3(x - W / 2, pot.top - y, -distance);
  // The lens shifts so the frame still holds the whole page.
  const lens = (camera: THREE.PerspectiveCamera, near: number, far: number) => {
    const k = near / distance;
    camera.near = near;
    camera.far = far;
    camera.projectionMatrix.makePerspective((-W / 2) * k, (W / 2) * k, (H / 2 - eye) * k, (-H / 2 - eye) * k, near, far);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  };
  return { distance, eye, at, toward2D, lens };
}

// The hills: three rings of them round the tree, `k` times the camera's
// distance away. In front, each ring rises exactly where the picture's ridge
// does; round the back the ridge line runs on, unrolled, and the two ends
// meet behind. `height` is above the plain, at an angle round from the front.
export function hillRings(s: Scene) {
  const { width: W } = s;
  const { distance } = framing(s);
  const { pot } = s.skeleton;
  const rise = pot.foot - pot.top; // the eye above the plain, from the front
  const rings: [Ridge, number][] = [
    ["back", 4.4],
    ["far", 3.2],
    ["near", 2.2],
  ];
  return rings.map(([which, k]) => {
    const R = distance * k;
    // Its height above the plain for a point of the picture, seen at `depth`.
    const tall = (x: number, depth: number) =>
      (pot.top + (rise * distance) / depth - (s.horizon - ridgeLine(s, x, which))) * (depth / distance);
    const seen = (a: number) => {
      const depth = R * Math.cos(a) + distance;
      return tall(W / 2 + (distance * R * Math.sin(a)) / depth, depth);
    };
    const unrolled = (a: number) => tall(W / 2 + (a * distance * R) / (R + distance), R + distance);
    // How far round the picture's edge is, with room to spare.
    let edge = 0;
    while (edge < 1.4 && (distance * R * Math.sin(edge)) / (R * Math.cos(edge) + distance) < W * 0.8) edge += 0.002;
    const heightAt = (a: number) => {
      const w = smooth(edge, edge * 1.5, Math.abs(a));
      return seen(a) * (1 - w) + unrolled(a) * w;
    };
    const height = (a: number) => {
      const seam = a > 0 ? smooth(Math.PI - 0.5, Math.PI + 0.5, a) : smooth(-Math.PI + 0.5, -Math.PI - 0.5, a);
      return heightAt(a) * (1 - seam) + heightAt(a - Math.sign(a) * Math.PI * 2) * seam;
    };
    // The ridge's height in front, for shading.
    const span = (s.ridge(W / 2, which) * 2 * (R + distance)) / distance;
    return { which, R, height, span };
  });
}

type Disposable = { dispose: () => void };

// Every caster draws its shadow with a depth material of its own: three.js's
// shared one would keep its program on the GPU after the stage is gone. The
// one given to casters that had none is returned, to be freed with the stage.
// The shadow pass draws each caster with its depth material, set as the pass
// sets it, into the shadow map, under the scene's lights. compileAsync
// doesn't reach those, so stand-ins carry them through it ahead of the first
// shadow: each caster's own copy of its depth material, set as the pass
// would set it, compiled into a render target as the pass draws.
export async function compileShadows(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, disposables: Disposable[]) {
  const target = new THREE.WebGLRenderTarget(1, 1);
  try {
    await compileGently(renderer, standIns(scene, disposables), camera, target);
  } finally {
    target.dispose();
  }
}

// three writes out each shader's text as it hands it to the GPU, several
// milliseconds a shader, so they're handed over a shape at a time between
// the page's frames, then waited for together. `target` is what they'll
// draw into, which some shaders depend on. A shape with a light in it is
// left to the last call: compiled on its own, its lights would count twice.
export async function compileGently(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, target: THREE.WebGLRenderTarget | null = null) {
  const shapes: THREE.Object3D[] = [];
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line || object instanceof THREE.Sprite)) return;
    let lit = false;
    object.traverse((inner) => {
      if (inner instanceof THREE.Light) lit = true;
    });
    if (!lit) shapes.push(object);
  });
  const into = (work: () => void) => {
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    work();
    renderer.setRenderTarget(previous);
  };
  const slice = slicer();
  for (const shape of shapes) {
    await slice();
    into(() => renderer.compile(shape, camera, scene));
  }
  await slice();
  // Anything left is picked now; then it waits for them all.
  let compiled: Promise<unknown> = Promise.resolve();
  into(() => (compiled = renderer.compileAsync(scene, camera)));
  await compiled;
}

function standIns(scene: THREE.Scene, disposables: Disposable[]) {
  const flip: Record<THREE.Side, THREE.Side> = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };
  disposables.push(ownShadows(scene));
  // The same lights as the scene, which shaders are compiled for.
  const casters = new THREE.Scene();
  scene.traverse((object) => {
    if (!(object instanceof THREE.Light)) return;
    const Kind = object.constructor as new () => THREE.Light;
    const twin = new Kind();
    twin.castShadow = object.castShadow;
    casters.add(twin);
  });
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !object.castShadow || Array.isArray(object.material)) return;
    const material: THREE.Material = object.material;
    if (!object.customDepthMaterial) return;
    // Copies lose the hooks a patched material compiles with, so they're
    // carried over.
    const own = object.customDepthMaterial;
    const depth = own.clone();
    depth.onBeforeCompile = own.onBeforeCompile;
    depth.customProgramCacheKey = own.customProgramCacheKey;
    disposables.push(depth);
    const from = material as THREE.Material & Partial<Pick<THREE.MeshStandardMaterial, "map" | "alphaMap" | "displacementMap" | "displacementScale" | "displacementBias" | "wireframe">>;
    depth.side = material.shadowSide ?? flip[material.side];
    depth.alphaTest = material.alphaToCoverage ? 0.5 : material.alphaTest;
    const into = depth as THREE.Material & Partial<Pick<THREE.MeshDepthMaterial, "map" | "alphaMap" | "displacementMap" | "displacementScale" | "displacementBias" | "wireframe">>;
    into.map = from.map ?? null;
    into.alphaMap = from.alphaMap ?? null;
    into.displacementMap = from.displacementMap ?? null;
    into.displacementScale = from.displacementScale ?? 1;
    into.displacementBias = from.displacementBias ?? 0;
    into.wireframe = from.wireframe ?? false;
    depth.clipShadows = material.clipShadows;
    depth.clippingPlanes = material.clippingPlanes;
    depth.clipIntersection = material.clipIntersection;
    if (object instanceof THREE.InstancedMesh) {
      const twin = new THREE.InstancedMesh(object.geometry, depth, 1);
      twin.instanceColor = object.instanceColor;
      casters.add(twin);
    } else casters.add(new THREE.Mesh(object.geometry, depth));
  });
  return casters;
}

// Compiled shaders still make a round trip to the GPU the first time each is
// drawn, for its uniforms, and a scene's textures, buffers and shadows go up
// with its first frame. All of that happens here instead, a piece at a time
// between the page's frames: the shaders, then the textures, then, with
// `draw`, two frames onto the canvas while it's still hidden (which the first
// frame shown draws over). The first sees nothing, yet draws the shadows and
// sends up everything that casts one; the second, the rest.
export async function warm(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  { wanted = () => true, draw = false }: { wanted?: () => boolean; draw?: boolean } = {},
) {
  for (const program of renderer.info.programs ?? []) {
    if (!wanted()) return;
    program.getUniforms();
    program.getAttributes();
    await pause();
  }
  const textures = new Set<THREE.Texture>();
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Sprite)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      if (material instanceof THREE.ShaderMaterial) {
        for (const uniform of Object.values(material.uniforms)) if (uniform.value instanceof THREE.Texture) textures.add(uniform.value);
      }
    }
  });
  for (const texture of textures) {
    if (!wanted()) return;
    if (texture.isRenderTargetTexture) continue;
    renderer.initTexture(texture);
    await pause();
  }
  if (!draw || !wanted()) return;
  // Nothing lies between its near and far planes, but its lights still shine.
  const blind = camera.clone();
  if (blind instanceof THREE.PerspectiveCamera) {
    blind.far = blind.near * 1.001;
    blind.updateProjectionMatrix();
  }
  renderer.render(scene, blind);
  await pause();
  if (wanted()) renderer.render(scene, camera);
}

export function ownShadows(scene: THREE.Scene) {
  const plain = new THREE.MeshDepthMaterial();
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh && object.castShadow && object.customDepthMaterial === undefined) object.customDepthMaterial = plain;
  });
  return plain;
}

// `start` is the clock now, so the clouds set off where the 2D ones are. It's
// built a few milliseconds at a time between the page's frames. `hidden`
// says its canvas isn't showing anything yet, so it may be sized and drawn
// on ahead; otherwise the canvas keeps its last picture until this stage's
// first frame.
export async function createDepth(canvas: HTMLCanvasElement, s: Scene, start: number, hidden: boolean): Promise<Depth> {
  const steps = build(canvas, s, start, hidden);
  const slice = slicer();
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await slice();
  }
}

function* build(canvas: HTMLCanvasElement, s: Scene, start: number, hidden: boolean): Generator<undefined, Depth, undefined> {
  // Everything made is freed in reverse, so the renderer goes last: once
  // disposed it forgets what it holds on the GPU, and nothing after it frees.
  const disposables: Disposable[] = [];
  const release = () => {
    for (const item of disposables.reverse()) item.dispose();
    disposables.length = 0;
  };
  try {
    return yield* buildDepth(canvas, s, start, hidden, disposables, release);
  } catch (error) {
    release();
    throw error;
  }
}

// It stops at each `yield`, where the page may draw a frame.
function* buildDepth(canvas: HTMLCanvasElement, s: Scene, start: number, hidden: boolean, disposables: Disposable[], release: () => void): Generator<undefined, Depth, undefined> {
  const { width: W, height: H, layout: l, skeleton } = s;
  const { cw, ch } = l;
  const p = s.sky.palette;
  const { distance, eye, at, toward2D, lens } = framing(s);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
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
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Nothing that casts a shadow moves, so the shadows are drawn once.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;

  const scene = new THREE.Scene();

  // The eye sits level with the pot's rim, as a bonsai is photographed.
  const camera = new THREE.PerspectiveCamera();
  lens(camera, 1, distance * 12);
  const { pot } = skeleton;
  const own = <T extends Disposable>(item: T) => {
    disposables.push(item);
    return item;
  };
  const add = <T extends THREE.Object3D>(object: T) => {
    scene.add(object);
    return object;
  };
  const rand = random(s.seed ^ 0x3d3d);

  // Light from the sky, from wherever the sun or moon is, and a soft fill
  // from the camera so the tree keeps its colors against the sky.
  const day = 1 - s.night;
  const center = at(pot.center, pot.top - ch * 10);
  add(new THREE.HemisphereLight(color(mix(p.top, [255, 255, 255], 0.5)), color(mix(p.land, [120, 100, 80], 0.5)), 0.9 + 1.7 * day));
  const key = own(add(new THREE.DirectionalLight(color(s.sky.body === "sun" ? mix(p.sun, [255, 255, 255], 0.4) : [196, 210, 245]), 1.1 + 2.1 * day)));
  const toward = at(s.body.x, s.body.y, distance * 0.5).sub(center).normalize();
  key.position.copy(center).addScaledVector(toward, distance);
  key.target.position.copy(center);
  add(key.target);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 4;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 1;
  const reach = Math.max(W, H) * 0.55;
  Object.assign(key.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: distance * 3 });
  const fill = add(new THREE.DirectionalLight(0xfff2e2, 0.6 + 0.8 * day));
  fill.position.set(0, H * 0.3, distance);

  // The world around the tree. From the front it lines up with the 2D
  // picture.
  const front = new THREE.Vector3(0, eye, distance);
  // A color as the 2D canvas has it, for shaders that blend as it does.
  const raw = (c: RGB) => new THREE.Vector3(c[0] / 255, c[1] / 255, c[2] / 255);

  // The sky: a dome that goes where the camera goes, so it is as far as can
  // be, shaded by height as the 2D sky is, with the Milky Way where the
  // picture has it.
  const sky = add(new THREE.Group());
  const dome = distance * 10;
  const galaxy = s.galaxy ? own(new THREE.CanvasTexture(s.galaxy)) : null;
  const heaven = add(
    new THREE.Mesh(
      own(new THREE.SphereGeometry(dome, 48, 24)),
      own(
        new THREE.ShaderMaterial({
          side: THREE.BackSide,
          depthWrite: false,
          uniforms: {
            top: { value: raw(p.top) },
            mid: { value: raw(mix(p.top, p.low, 0.55)) },
            low: { value: raw(p.low) },
            eyeY: { value: pot.top },
            horizon: { value: s.horizon },
            lens: { value: distance },
            width: { value: W },
            galaxy: { value: galaxy },
            milky: { value: galaxy ? s.night : 0 },
          },
          vertexShader: `
            varying vec3 vDir;
            void main() {
              vDir = position;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
          fragmentShader: `
            uniform vec3 top;
            uniform vec3 mid;
            uniform vec3 low;
            uniform float eyeY;
            uniform float horizon;
            uniform float lens;
            uniform float width;
            uniform sampler2D galaxy;
            uniform float milky;
            varying vec3 vDir;
            void main() {
              vec3 d = normalize(vDir);
              float y = eyeY - lens * d.y / max(length(d.xz), 0.001);
              float g = clamp(y / horizon, 0.0, 1.0);
              vec3 c = g < 0.7 ? mix(top, mid, g / 0.7) : mix(mid, low, (g - 0.7) / 0.3);
              if (milky > 0.0 && d.z < -0.05) {
                vec2 at = vec2((0.5 * width + lens * d.x / -d.z) / width, (eyeY - lens * d.y / -d.z) / horizon);
                float fade = smoothstep(0.0, 0.12, at.x) * (1.0 - smoothstep(0.88, 1.0, at.x)) * smoothstep(-0.1, 0.05, at.y) * step(at.y, 1.0);
                vec4 band = texture2D(galaxy, vec2(at.x, 1.0 - at.y));
                c = mix(c, band.rgb, band.a * milky * fade);
              }
              gl_FragColor = vec4(c, 1.0);
            }`,
        }),
      ),
    ),
  );
  heaven.renderOrder = -3;
  sky.add(heaven);

  yield;
  // Stars: the picture's own where they are, and as many again all the way
  // round, but none in the picture's patch of sky.
  let stars: THREE.ShaderMaterial | undefined;
  if (s.night > 0.05) {
    const positions: number[] = [];
    const looks: number[] = [];
    const put = (d: THREE.Vector3, glow: number, rate: number, phase: number) => {
      d.normalize().multiplyScalar(dome * 0.9);
      positions.push(d.x, d.y, d.z);
      looks.push(glow, rate, phase);
    };
    for (const star of s.stars) put(toward2D(star.x, star.y), star.glow, star.rate, star.phase);
    for (let i = 0; i < s.stars.length * 18; i++) {
      const turn = rand() * Math.PI * 2;
      const rise = Math.asin(0.02 + 0.97 * rand());
      const d = new THREE.Vector3(Math.sin(turn) * Math.cos(rise), Math.sin(rise), -Math.cos(turn) * Math.cos(rise));
      if (d.z < 0) {
        const x = W / 2 + (distance * d.x) / -d.z;
        const y = pot.top - (distance * d.y) / -d.z;
        if (x > 0 && x < W && y > 0 && y < s.horizon) continue;
      }
      put(d, rand() ** 3, 0.6 + 1.8 * rand(), rand() * Math.PI * 2);
    }
    const geometry = own(new THREE.BufferGeometry());
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("look", new THREE.Float32BufferAttribute(looks, 3));
    stars = own(
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { time: { value: 0 }, night: { value: s.night }, scale: { value: ratio } },
        vertexShader: `
          attribute vec3 look;
          uniform float time;
          uniform float night;
          uniform float scale;
          varying float vAlpha;
          void main() {
            vAlpha = night * (0.25 + 0.75 * look.x) * (0.7 + 0.3 * sin(time * look.y + look.z));
            gl_PointSize = max(1.0, 0.6 + 1.2 * look.x) * scale;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          varying float vAlpha;
          void main() {
            gl_FragColor = vec4(0.957, 0.937, 0.886, vAlpha);
          }`,
      }),
    );
    const points = new THREE.Points(geometry, stars);
    points.renderOrder = -2;
    points.frustumCulled = false;
    sky.add(points);
  }

  yield;
  // The sun or the moon, with its glow, where the picture has it. A pixel of
  // the picture spans `pixel` units out there.
  const bodyAt = toward2D(s.body.x, s.body.y);
  const bodyDistance = distance * 9;
  const pixel = bodyDistance / bodyAt.length();
  const radius = s.body.radius;
  const halo = (reach: number, draw: (ctx: CanvasRenderingContext2D, k: number) => void, additive = false) => {
    // `k` is the texture's pixels for each of the picture's.
    const texture = own(canvasTexture(1024, 1024, (ctx) => {
      ctx.translate(512, 512);
      draw(ctx, 512 / (reach * radius));
    }));
    const sprite = new THREE.Sprite(
      own(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending })),
    );
    sprite.position.copy(bodyAt).normalize().multiplyScalar(bodyDistance);
    sprite.scale.setScalar(reach * radius * 2 * pixel);
    sprite.renderOrder = -1;
    sky.add(sprite);
    return sprite;
  };
  const glow = (ctx: CanvasRenderingContext2D, k: number, tint: RGB, layers: number[][]) => {
    for (const [reach, strength] of layers) {
      const gradient = ctx.createRadialGradient(0, 0, radius * 0.5 * k, 0, 0, radius * reach * k);
      gradient.addColorStop(0, css(tint, strength));
      gradient.addColorStop(1, css(tint, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(-512, -512, 1024, 1024);
    }
  };
  let rays: THREE.Sprite | undefined;
  if (s.sky.body === "sun") {
    halo(9, (ctx, k) => {
      glow(ctx, k, p.glow, [[9, 0.16], [3.5, 0.4]]);
      const r = radius * 0.7 * k;
      const disc = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      disc.addColorStop(0, css([255, 255, 250]));
      disc.addColorStop(0.75, css(mix(p.sun, [255, 255, 250], 0.5)));
      disc.addColorStop(1, css(p.sun));
      ctx.fillStyle = disc;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
    });
    if (s.night < 0.5) {
      rays = halo(
        13,
        (ctx, k) => {
          for (let i = 0; i < 9; i++) {
            const angle = (i / 9) * Math.PI * 2;
            const reach = radius * (9 + 4 * hash(i, 4)) * k;
            const spread = 0.035 + 0.03 * hash(i, 9);
            const beam = ctx.createRadialGradient(0, 0, radius * k, 0, 0, reach);
            beam.addColorStop(0, css(p.glow, 0.06 * (1 - s.night)));
            beam.addColorStop(1, css(p.glow, 0));
            ctx.fillStyle = beam;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, reach, angle - spread, angle + spread);
            ctx.fill();
          }
        },
        true,
      );
    }
  } else if (s.moon) {
    const moon = s.moon;
    halo(3.4, (ctx, k) => {
      glow(ctx, k, [150, 165, 200], [[3.4, 0.16]]);
      ctx.drawImage(moon, (-moon.width / 2) * k, (-moon.height / 2) * k, moon.width * k, moon.height * k);
    });
  }

  yield;
  // Clouds: the picture's own where they are, and more round the rest of
  // the sky, all drifting round the tree the way the 2D ones drift.
  const cloudDepth = distance * 5.5;
  const cloudMaps = s.clouds.map((cloud) => (cloud.sprite ? own(new THREE.CanvasTexture(cloud.sprite)) : undefined));
  for (const map of cloudMaps) if (map) map.colorSpace = THREE.SRGBColorSpace;
  type Drifter = { sprite: THREE.Sprite; radius: number; angle: number; speed: number; size: number };
  const drifters: Drifter[] = [];
  const cloudAt = (map: THREE.Texture | undefined, x: number, y: number, w: number, speed: number, angle?: number) => {
    if (!map) return;
    const point = front.clone().addScaledVector(toward2D(x, y), cloudDepth / distance);
    const radius = angle === undefined ? Math.hypot(point.x, point.z) : cloudDepth - distance;
    const size = (w * cloudDepth) / distance;
    const sprite = add(new THREE.Sprite(own(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false }))));
    sprite.position.y = point.y;
    sprite.scale.set(size, size * 0.4, 1);
    drifters.push({ sprite, radius, angle: angle ?? Math.atan2(point.x, -point.z), speed: (speed * cloudDepth) / distance / radius, size });
  };
  s.clouds.forEach((cloud, i) => {
    const span = W + cloud.w * 2;
    const x = ((((cloud.x + start * cloud.speed) % span) + span) % span) - cloud.w / 2;
    cloudAt(cloudMaps[i], x, cloud.y, cloud.w, cloud.speed);
  });
  for (let i = 0; i < 12; i++) {
    const k = i % s.clouds.length;
    const cloud = s.clouds[k];
    const angle = 0.8 + ((i + rand() * 0.6) / 12) * (Math.PI * 2 - 1.6);
    cloudAt(cloudMaps[k], W / 2, s.horizon * (0.1 + 0.4 * rand()), cloud.w * (0.8 + 0.5 * rand()), cloud.speed, angle);
  }
  const cloudAlpha = 1 - 0.55 * s.night;

  yield;
  // Hills: three rings of them round the tree, flat cards of color.
  const groundY = H / 2 - pot.foot;
  const tints: Record<Ridge, [RGB, number]> = {
    back: [mix(p.land, p.low, 0.74), 1200],
    far: [mix(p.land, p.low, 0.52), 1800],
    near: [mix(p.land, p.low, 0.22), 4800],
  };
  for (const { which, R, height: around, span } of hillRings(s)) {
    const [tint, steps] = tints[which];
    const foot = color(mix(tint, p.low, 0.3));
    const head = color(tint);
    const positions: number[] = [];
    const shades: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= steps; i++) {
      if (i % 512 === 511) yield;
      const a = -Math.PI + (i / steps) * Math.PI * 2;
      const h = Math.max(1, around(a));
      const [x, z] = [Math.sin(a) * R, -Math.cos(a) * R];
      positions.push(x, groundY - 40, z, x, groundY + h, z);
      const c = foot.clone().lerp(head, Math.min(1, h / span));
      shades.push(foot.r, foot.g, foot.b, c.r, c.g, c.b);
      if (i < steps) indices.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
    }
    const geometry = own(new THREE.BufferGeometry());
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(shades, 3));
    geometry.setIndex(indices);
    add(new THREE.Mesh(geometry, own(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }))));
    yield;
  }

  yield;
  // The plain, shaded by how far off it is as the 2D one is by height.
  const plain = plainStops(p);
  const field = add(
    new THREE.Mesh(
      own(new THREE.CircleGeometry(distance * 5, 128)),
      own(
        new THREE.ShaderMaterial({
          uniforms: {
            near: { value: raw(plain[0][1]) },
            mid: { value: raw(plain[1][1]) },
            far: { value: raw(plain[2][1]) },
            groundY: { value: groundY },
            eyeY: { value: pot.top },
            horizon: { value: s.horizon },
            height: { value: H },
            lens: { value: distance },
          },
          vertexShader: `
            varying vec3 vWorld;
            void main() {
              vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
              gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
            }`,
          fragmentShader: `
            uniform vec3 near;
            uniform vec3 mid;
            uniform vec3 far;
            uniform float groundY;
            uniform float eyeY;
            uniform float horizon;
            uniform float height;
            uniform float lens;
            varying vec3 vWorld;
            void main() {
              float off = max(length(vWorld.xz - cameraPosition.xz), 1.0);
              float y = eyeY + (cameraPosition.y - groundY) * lens / off;
              float g = clamp((y - horizon) / (height - horizon), 0.0, 1.0);
              gl_FragColor = vec4(g < 0.35 ? mix(near, mid, g / 0.35) : mix(mid, far, (g - 0.35) / 0.65), 1.0);
            }`,
        }),
      ),
    ),
  );
  field.rotation.x = -Math.PI / 2;
  field.position.y = groundY;

  yield;
  // Limbs and roots as tapered tubes of bark.
  const bark = own(barkTexture());
  const wood = own(
    new THREE.MeshStandardMaterial({ color: color(ramp(BARK, 0.6)), map: bark, bumpMap: bark, bumpScale: 1.5, roughness: 0.85 }),
  );
  // All of it one mesh, drawn at once rather than limb by limb.
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const tube = (joints: Joint[]) => {
    const path = resample(joints, 4);
    if (path.length < 2) return;
    const first = positions.length / 3;
    const curve = new THREE.CatmullRomCurve3(path.map((j) => at(j.x, j.y, j.z)));
    const segments = Math.max(2, path.length - 1);
    const frames = curve.computeFrenetFrames(segments, false);
    let along = 0;
    let previous = curve.getPointAt(0);
    for (let j = 0; j <= segments; j++) {
      const u = j / segments;
      const middle = curve.getPointAt(u);
      along += middle.distanceTo(previous);
      previous = middle;
      const x = u * (path.length - 1);
      const k = Math.min(path.length - 2, Math.floor(x));
      const r = (path[k].r + (path[k + 1].r - path[k].r) * (x - k)) * ((distance - middle.z) / distance);
      for (let side = 0; side <= SIDES; side++) {
        const angle = (side / SIDES) * Math.PI * 2;
        const n = frames.normals[j].clone().multiplyScalar(Math.cos(angle)).addScaledVector(frames.binormals[j], Math.sin(angle));
        positions.push(middle.x + r * n.x, middle.y + r * n.y, middle.z + r * n.z);
        normals.push(n.x, n.y, n.z);
        uvs.push(side / SIDES, along / (cw * 16));
      }
    }
    for (let j = 0; j < segments; j++) {
      for (let side = 0; side < SIDES; side++) {
        const a = first + j * (SIDES + 1) + side;
        indices.push(a, a + 1, a + SIDES + 1, a + 1, a + SIDES + 2, a + SIDES + 1);
      }
    }
  };
  for (const [i, limb] of skeleton.limbs.entries()) {
    tube(i === 0 ? [skeleton.soil, ...limb.joints] : limb.joints);
    yield;
  }
  for (const root of skeleton.roots) {
    tube(root);
    yield;
  }
  const woodGeometry = own(new THREE.BufferGeometry());
  woodGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  woodGeometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  woodGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  woodGeometry.setIndex(indices);
  const limbs = add(new THREE.Mesh(woodGeometry, wood));
  limbs.castShadow = true;
  limbs.receiveShadow = true;

  // The canopy as cards: leaves in shadow at its heart, then leaves and
  // flowers around them, tinted by where they face the light.
  const cards = (texture: THREE.Texture, count: number) => {
    const material = own(
      new THREE.MeshStandardMaterial({ map: own(texture), alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.8 }),
    );
    const mesh = own(add(new THREE.InstancedMesh(own(new THREE.PlaneGeometry(1, 1)), material, Math.max(1, count))));
    mesh.customDepthMaterial = own(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: texture, alphaTest: 0.5 }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };
  const greensOf = (blossom: boolean) => (blossom ? 14 : 30);
  const leaves = cards(leafTexture(), skeleton.leaves.reduce((sum, leaf) => sum + greensOf(leaf.blossom), 0));
  const flowers = cards(flowerTexture(), skeleton.leaves.filter((leaf) => leaf.blossom).length * 18);
  yield;
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();
  const offset = new THREE.Vector3();
  let leafCount = 0;
  let flowerCount = 0;
  // Cards turn every way about their middle, but lean at most an angle off
  // facing the front, so the canopy reads as full as the 2D one.
  const place = (mesh: THREE.InstancedMesh, index: number, origin: THREE.Vector3, size: number, aspect: number, tint: RGB) => {
    euler.set((rand() - 0.5) * 1.8, (rand() - 0.5) * 1.8, rand() * Math.PI * 2);
    rotation.setFromEuler(euler);
    matrix.compose(origin, rotation, scale.set(size, size * aspect, size));
    mesh.setMatrixAt(index, matrix);
    mesh.setColorAt(index, color(tint));
  };
  for (const leaf of skeleton.leaves) {
    yield;
    const heart = at(leaf.x, leaf.y, leaf.z);
    const spot = (spread: number) => {
      offset.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize().multiplyScalar(Math.cbrt(rand()) * spread);
      offset.y *= 0.75;
      return { origin: heart.clone().add(offset), facing: offset.dot(toward) / spread };
    };
    const greens = greensOf(leaf.blossom);
    for (let k = 0; k < greens; k++) {
      const inner = k < greens / 3;
      const { origin, facing } = spot(cw * (inner ? 0.6 : 1.05));
      const tone = (inner ? 0.18 : 0.52) + 0.22 * facing - 0.25 * leaf.cover + 0.14 * (rand() - 0.5);
      place(leaves, leafCount++, origin, cw * (0.95 + 0.4 * rand()), 0.5, ramp(LEAF, tone));
    }
    if (!leaf.blossom) continue;
    for (let k = 0; k < 18; k++) {
      const { origin, facing } = spot(cw * 1.0);
      const tone = 0.64 + 0.2 * facing - 0.2 * leaf.cover + 0.14 * (rand() - 0.5);
      place(flowers, flowerCount++, origin, cw * (0.8 + 0.3 * rand()), 1, ramp(BLOSSOM, tone));
    }
  }
  leaves.count = leafCount;
  flowers.count = flowerCount;
  yield;

  // The pot: a glazed, rounded tray that tapers to its base, on two long feet,
  // with soil and a mound of moss.
  const glaze = own(
    new THREE.MeshPhysicalMaterial({
      color: color(ramp(GLAZE, 0.3 - 0.2 * s.night)),
      map: own(tiled(glazeTexture())),
      roughness: 0.6,
      clearcoat: 0.25,
      clearcoatRoughness: 0.5,
    }),
  );
  const width = pot.right - pot.left;
  const deep = width * 0.42;
  const rim = ch * 0.3;
  const lipTop = pot.top - rim * 0.4;
  const bodyTop = lipTop + rim;
  const baseWidth = pot.base * 2;
  const ring = (screenY: number, w: number, radius = deep * 0.14): Ring => ({
    y: H / 2 - screenY,
    width: w,
    depth: w * (deep / width),
    radius,
  });
  const potShapes = [
    shell([ring(lipTop, width, deep * 0.16), ring(lipTop + rim * 0.15, width + 1, deep * 0.16), ring(bodyTop, width, deep * 0.16)]),
    shell([
      ring(bodyTop, width - cw * 0.9),
      ring(pot.bottom - ch * 0.3, baseWidth + cw * 0.6),
      ring(pot.bottom - ch * 0.08, baseWidth - cw * 0.4),
      ring(pot.bottom, baseWidth - cw * 1.4),
    ]),
  ];
  for (const geometry of potShapes) {
    const mesh = add(new THREE.Mesh(own(geometry), glaze));
    mesh.position.x = pot.center - W / 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
  const footDepth = ((baseWidth * deep) / width) * 0.7;
  const foot = own(
    shell([
      { y: H / 2 - (pot.bottom - 2), width: cw * 2.6, depth: footDepth, radius: cw * 0.3 },
      { y: H / 2 - pot.foot, width: cw * 2.1, depth: footDepth - cw * 0.5, radius: cw * 0.3 },
    ]),
  );
  for (const side of [-1, 1]) {
    const mesh = add(new THREE.Mesh(foot, glaze));
    mesh.position.x = pot.center - W / 2 + side * (pot.base - cw * 1.6);
    mesh.castShadow = true;
  }
  const soil = add(
    new THREE.Mesh(
      own(shell([ring(lipTop - 0.5, width - cw * 0.5, deep * 0.12), ring(lipTop + 1, width - cw * 0.5, deep * 0.12)])),
      own(new THREE.MeshStandardMaterial({ color: color(BARK[1]), roughness: 1 })),
    ),
  );
  soil.position.x = pot.center - W / 2;
  soil.receiveShadow = true;

  yield;
  // A soft shadow under the pot, as the 2D picture has.
  const shade = canvasTexture(128, 128, (ctx) => {
    const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, "rgb(0 0 0 / 0.6)");
    gradient.addColorStop(0.6, "rgb(0 0 0 / 0.28)");
    gradient.addColorStop(1, "rgb(0 0 0 / 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
  });
  const contact = add(
    new THREE.Mesh(
      own(new THREE.PlaneGeometry(width * 1.25, deep * 1.6)),
      own(new THREE.MeshBasicMaterial({ map: own(shade), transparent: true, depthWrite: false })),
    ),
  );
  contact.rotation.x = -Math.PI / 2;
  contact.position.copy(at(pot.center, pot.foot - 0.5));

  const mound = own(new THREE.SphereGeometry(1, 96, 24, 0, Math.PI * 2, 0, Math.PI / 2));
  const position = mound.getAttribute("position");
  const shades: number[] = [];
  for (let i = 0; i < position.count; i++) {
    const n = noise(position.getX(i) * 9, position.getZ(i) * 9, 2.3);
    position.setY(i, position.getY(i) * (1 + 0.25 * n));
    const c = color(ramp(MOSS, 0.3 + 0.45 * n + 0.25 * position.getY(i)));
    shades.push(c.r, c.g, c.b);
  }
  mound.setAttribute("color", new THREE.Float32BufferAttribute(shades, 3));
  mound.computeVertexNormals();
  const moss = add(new THREE.Mesh(mound, own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }))));
  moss.position.copy(at(skeleton.soil.x, lipTop));
  moss.scale.set(cw * 8, ch * 0.32, deep * 0.36);
  moss.receiveShadow = true;

  // Falling petals.
  const drift = own(
    add(
      new THREE.InstancedMesh(
        own(new THREE.PlaneGeometry(1, 0.7)),
        own(new THREE.MeshBasicMaterial({ map: own(petalTexture()), alphaTest: 0.5, side: THREE.DoubleSide })),
        PETALS,
      ),
    ),
  );
  drift.frustumCulled = false;
  // Its colours exist from the start, so its shader is the one compiled.
  const tint = new THREE.Color();
  for (let i = 0; i < PETALS; i++) drift.setColorAt(i, tint);
  const seen = new THREE.Vector3();
  const facing = new THREE.Vector3();
  own(ownShadows(scene));

  // The first frame would work out each shape's bounds, to see whether it's
  // in view; they're worked out here instead, a shape at a time.
  const shapes: THREE.Mesh[] = [];
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh && object.frustumCulled) shapes.push(object);
  });
  for (const shape of shapes) {
    if (shape instanceof THREE.InstancedMesh) shape.computeBoundingSphere();
    else if (!shape.geometry.boundingSphere) shape.geometry.computeBoundingSphere();
    yield;
  }

  // Its shaders compile in parallel, then it's warmed: if its canvas is
  // hidden, with a frame drawn ahead, which also draws its one set of
  // shadows.
  // If the context is lost meanwhile, it fails, and the page disposes it,
  // which ends any wait on a shader.
  let gone = false;
  const watching = new AbortController();
  const lost = new Promise<never>((_, reject) => {
    canvas.addEventListener("webglcontextlost", () => reject(new Error("The WebGL context was lost")), { once: true, signal: watching.signal });
  });
  const ready = Promise.race([
    lost,
    (async () => {
      camera.position.set(0, eye, distance);
      camera.lookAt(0, eye, 0);
      camera.updateMatrixWorld();
      await compileGently(renderer, scene, camera);
      if (gone) return;
      await compileShadows(renderer, scene, camera, disposables);
      if (gone) return;
      if (hidden) fit();
      await warm(renderer, scene, camera, { wanted: () => !gone, draw: hidden });
    })(),
  ]).finally(() => watching.abort());
  // Settled one way or another; a failure shows when it's drawn.
  ready.catch(() => undefined);

  return {
    ready,
    render(turn, tilt, petals, t) {
      fit();
      const size = cw * 0.5;
      for (let i = 0; i < PETALS; i++) {
        const petal = petals[i];
        if (!petal) {
          matrix.makeScale(0, 0, 0);
        } else {
          euler.set(petal.phase, petal.phase * 0.7, 0);
          rotation.setFromEuler(euler);
          matrix.compose(at(petal.x, petal.y, (((i * 37) % 64) / 64 - 0.5) * cw * 20), rotation, scale.set(size, size, size));
          drift.setColorAt(i, tint.set(petal.color));
        }
        drift.setMatrixAt(i, matrix);
      }
      drift.instanceMatrix.needsUpdate = true;
      if (drift.instanceColor) drift.instanceColor.needsUpdate = true;

      camera.position.set(Math.sin(turn) * distance, eye + Math.sin(tilt) * distance, Math.cos(turn) * Math.cos(tilt) * distance);
      camera.lookAt(0, eye, 0);
      camera.updateMatrixWorld();
      camera.getWorldDirection(facing);
      sky.position.copy(camera.position);
      // The fill comes from wherever the camera is, so no side of the tree
      // is left in the dark.
      fill.position.copy(camera.position).setY(camera.position.y + H * 0.3);
      if (stars) stars.uniforms.time.value = t;
      if (rays) rays.material.rotation = t * 0.015;

      // Clouds drift on, and thin as they pass behind the page's words.
      for (const cloud of drifters) {
        const a = cloud.angle + cloud.speed * (t - start);
        cloud.sprite.position.set(Math.sin(a) * cloud.radius, cloud.sprite.position.y, -Math.cos(a) * cloud.radius);
        const depth = seen.copy(cloud.sprite.position).sub(camera.position).dot(facing);
        let behind = 0;
        if (depth > 0) {
          seen.copy(cloud.sprite.position).project(camera);
          const w = (cloud.size * distance) / depth;
          const [left, top] = [((seen.x + 1) / 2) * W - w / 2, ((1 - seen.y) / 2) * H - w * 0.2];
          for (const box of s.words) {
            const across = Math.max(0, Math.min(left + w, box.right) - Math.max(left, box.left));
            const down = Math.max(0, Math.min(top + w * 0.4, box.bottom) - Math.max(top, box.top));
            behind = Math.max(behind, (across * down) / (w * w * 0.4));
          }
        }
        cloud.sprite.material.opacity = cloudAlpha * (1 - 0.8 * smooth(0, 0.35, behind));
      }
      renderer.render(scene, camera);
    },
    dispose() {
      gone = true;
      watching.abort();
      release();
    },
  };
}
