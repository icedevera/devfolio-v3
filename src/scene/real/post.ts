import * as THREE from "three";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { compileGently } from "../depth";

// What a camera adds after the light: the scene drawn in high dynamic range,
// shadowed where things crowd each other (ambient occlusion), hazed with
// the sky's own color the further off it is, glowing where it is too bright
// for the sensor, the sun's light in shafts through the leaves, far things
// out of focus, and a film look: tone curve, grade, vignette, a fringe of
// color at the edges, grain.

export type Shot = {
  exposure: number;
  sun: THREE.Vector3; // toward the sun
  shafts: number; // how strongly its light shows in the air
  focus: number; // the distance in focus
  aperture: number; // how out of focus the far distance gets, 0 to 1
  time: number;
  balance: THREE.Color; // white balance
};

export type Post = {
  render: (scene: THREE.Scene, camera: THREE.PerspectiveCamera, shot: Shot) => void;
  // Called once a frame with the time since the last, so the resolution
  // drops when frames run long and climbs back when they don't.
  pace: (dt: number) => void;
  compile: () => Promise<void>; // readies every shader without holding up the page
  depth: THREE.Texture; // the scene's depth
  lean: () => boolean; // dropped its costliest passes, as the GPU is slow
  dispose: () => void;
};

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

const pass = (uniforms: Record<string, THREE.IUniform>, fragmentShader: string) =>
  new THREE.ShaderMaterial({ uniforms, vertexShader: QUAD_VERTEX, fragmentShader, depthTest: false, depthWrite: false });

// The scene's position from the depth buffer, in view space.
const VIEW = /* glsl */ `
  uniform mat4 uProjectionInverse;
  vec3 viewAt(vec2 uv, float depth) {
    vec4 p = uProjectionInverse * vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
    return p.xyz / p.w;
  }`;

// Occlusion, then the air between the camera and what it sees: light lost
// on the way and the sky's light scattered in, thicker low down.
const AIR = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform sampler2D tOcclusion;
  uniform float uOcclusion;
  uniform samplerCube tHaze;
  uniform mat4 uCameraWorld;
  uniform float uExposure;
  uniform vec3 uSun;
  uniform vec3 uSunLight;
  uniform float uClear; // the distance the air is clear for: the tree's own hilltop
  uniform float uThickness; // the distance over which the air hides two thirds, at the valley floor
  uniform float uFloor; // the valley floor, where the air is thickest
  uniform float uScale; // how fast the air thins with height
  varying vec2 vUv;
  ${VIEW}
  void main() {
    // Unsqueezed: the scene was averaged across each pixel squeezed.
    vec3 color = texture(tColor, vUv).rgb;
    color /= max(1.0 - max(color.r, max(color.g, color.b)), 1e-3);
    float depth = texture(tDepth, vUv).x;
    if (depth < 1.0) {
      color *= mix(1.0, texture(tOcclusion, vUv).r, uOcclusion);
      vec3 view = viewAt(vUv, depth);
      vec3 world = (uCameraWorld * vec4(view, 1.0)).xyz;
      vec3 eye = uCameraWorld[3].xyz;
      float far = length(view);
      vec3 dir = (world - eye) / far;
      // The air's density, averaged along the ray, falls off with height.
      float a = (eye.y - uFloor) / uScale;
      float b = (world.y - uFloor) / uScale;
      float mean = abs(b - a) < 1e-3 ? exp(-a) : (exp(-a) - exp(-b)) / (b - a);
      float through = exp(-max(far - uClear, 0.0) / uThickness * mean);
      vec3 sky = textureLod(tHaze, normalize(vec3(dir.x, max(dir.y, 0.08), dir.z)), 4.0).rgb;
      // Toward the sun the haze glows, as the air scatters its light forward.
      float forward = 0.0796 * 0.4375 / pow(1.5625 - 1.5 * dot(dir, uSun), 1.5);
      vec3 haze = sky * 1.05 + uSunLight * forward * 0.006;
      color = color * through + haze * (1.0 - through);
    }
    gl_FragColor = vec4(color * uExposure, 1.0);
  }`;

// Far things out of focus, gathered at half size: each pixel takes in
// those round it within its own blur, weighted by theirs, so a sharp near
// leaf never smears over the blurred hills behind it.
const FOCUS = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform float uFocus;
  uniform float uAperture;
  uniform vec2 uTexel;
  uniform float uReach; // the widest blur, in pixels
  varying vec2 vUv;
  ${VIEW}
  float blurAt(vec2 uv) {
    float depth = texture(tDepth, uv).x;
    // The sky only a little, so the stars stay points.
    if (depth >= 1.0) return uAperture * 0.3;
    return uAperture * clamp(1.0 - uFocus / length(viewAt(uv, depth)), 0.0, 1.0);
  }
  void main() {
    float own = blurAt(vUv);
    vec3 sum = texture(tColor, vUv).rgb;
    float total = 1.0;
    if (own > 0.02) {
      for (int i = 1; i < 28; i++) {
        float r = sqrt(float(i) / 28.0) * own * uReach;
        float a = float(i) * 2.39996;
        vec2 uv = vUv + vec2(cos(a), sin(a)) * r * uTexel;
        float w = smoothstep(0.0, 1.0, blurAt(uv) * uReach - r + 1.0);
        // Capped, so the sun's glare doesn't flood the blur.
        sum += min(texture(tColor, uv).rgb, vec3(4.0)) * w;
        total += w;
      }
    }
    gl_FragColor = vec4(sum / total, own);
  }`;

// Shafts of sunlight: the bright sky behind the leaves, smeared toward the
// sun, at half size.
const SHAFTS = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 uSunAt;
  uniform float uAspect;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    vec2 toward = uSunAt - vUv;
    const int STEPS = 40;
    vec2 stride = toward / float(STEPS) * 0.9;
    vec2 uv = vUv + stride * hash(gl_FragCoord.xy);
    vec3 sum = vec3(0.0);
    float decay = 1.0;
    for (int i = 0; i < STEPS; i++) {
      vec2 q = clamp(uv, 0.0, 1.0);
      if (texture(tDepth, q).x >= 1.0) {
        vec3 c = texture(tColor, q).rgb;
        sum += min(c, vec3(2.0)) * smoothstep(1.5, 4.0, dot(c, vec3(0.2126, 0.7152, 0.0722))) * decay;
      }
      decay *= 0.955;
      uv += stride;
    }
    // Strongest looking toward the sun.
    vec2 off = toward * vec2(uAspect, 1.0);
    gl_FragColor = vec4(sum / float(STEPS) * exp(-dot(off, off) * 3.5), 1.0);
  }`;

// The film: focus, shafts, tone curve, grade, vignette, color fringe,
// grain, and the screen's own encoding.
const FILM = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tFocus;
  uniform sampler2D tShafts;
  uniform float uFocus;
  uniform float uShafts;
  uniform float uTime;
  uniform float uAspect;
  uniform vec3 uBalance;
  varying vec2 vUv;
  // ACES, fitted, as three.js has it.
  vec3 aces(vec3 color) {
    const mat3 into = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
    const mat3 back = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
    color = into * (color / 0.6);
    vec3 a = color * (color + 0.0245786) - 0.000090537;
    vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
    return clamp(back * (a / b), 0.0, 1.0);
  }
  vec3 encode(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
  float hash(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  void main() {
    vec2 centered = vUv - 0.5;
    // The lens bends red and blue a little apart toward the edges.
    vec2 fringe = centered * dot(centered, centered) * 0.006;
    vec3 color = vec3(texture(tColor, vUv + fringe).r, texture(tColor, vUv).g, texture(tColor, vUv - fringe).b);
    vec4 soft = texture(tFocus, vUv);
    color = mix(color, soft.rgb, smoothstep(0.03, 0.25, soft.a) * uFocus);
    color += texture(tShafts, vUv).rgb * uShafts;
    color = aces(color * uBalance);
    // Grade: highlights a touch warm, a little richer.
    float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color *= mix(vec3(1.0), vec3(1.03, 1.0, 0.96), smoothstep(0.2, 0.8, l));
    color = mix(vec3(l), color, 1.08);
    // The lens darkens toward its corners.
    float corner = length(centered * vec2(uAspect, 1.0) / vec2(max(uAspect, 1.0), 1.0));
    color *= mix(1.0, 1.0 - smoothstep(0.25, 0.95, corner), 0.32);
    color = encode(clamp(color, 0.0, 1.0));
    // Grain, more in the shadows, and a dither so gradients never band.
    float grain = hash(vec3(gl_FragCoord.xy, fract(uTime * 7.31) * 911.0)) - 0.5;
    color += grain * (0.035 - 0.022 * l) + (hash(vec3(gl_FragCoord.yx, 3.7)) - 0.5) / 255.0;
    gl_FragColor = vec4(color, 1.0);
  }`;

type Air = { clear: number; thickness: number; floor: number; scale: number; sunLight: THREE.Color };

type TimerQuery = { TIME_ELAPSED_EXT: GLenum; GPU_DISJOINT_EXT: GLenum };

// How long the GPU takes over a frame, where the browser can say.
function gpuClock(gl: WebGL2RenderingContext) {
  const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerQuery | null;
  const pending: WebGLQuery[] = [];
  let open: WebGLQuery | null = null;
  return {
    timed: timer !== null,
    start() {
      if (!timer || open || pending.length > 4) return;
      open = gl.createQuery();
      if (open) gl.beginQuery(timer.TIME_ELAPSED_EXT, open);
    },
    stop() {
      if (!timer || !open) return;
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      pending.push(open);
      open = null;
    },
    // The latest frame's time in seconds, once the GPU has told it. If its
    // clock jumped meanwhile, every time still waiting is void.
    read() {
      if (!timer) return undefined;
      if (gl.getParameter(timer.GPU_DISJOINT_EXT) === true) {
        for (const query of pending) gl.deleteQuery(query);
        pending.length = 0;
        return undefined;
      }
      let seconds: number | undefined;
      while (pending.length > 0 && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE) === true) {
        const query = pending.shift();
        if (!query) break;
        seconds = Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1e9;
        gl.deleteQuery(query);
      }
      return seconds;
    },
    dispose() {
      if (timer && open) {
        gl.endQuery(timer.TIME_ELAPSED_EXT);
        gl.deleteQuery(open);
        open = null;
      }
      for (const query of pending) gl.deleteQuery(query);
      pending.length = 0;
    },
  };
}

// `overlay` is drawn as light added to the scene once it is unsqueezed.
// `ratio` is the screen's pixel ratio the canvas will be drawn at.
export function createPost(renderer: THREE.WebGLRenderer, haze: THREE.Texture, air: Air, clip: THREE.Box3, overlay: THREE.Scene, width: number, height: number, ratio: number): Post {
  const target = (options?: THREE.RenderTargetOptions) => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, ...options });
  const depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
  depthTexture.format = THREE.DepthFormat;
  const hdr = target({ samples: 4, depthBuffer: true, depthTexture });
  const lit = target();
  const focus = target();
  const shafts = target();
  // Built bare first so it makes its own normal target, then pointed at the
  // scene's depth, from which it works out the normals.
  const occlusion = new GTAOPass(new THREE.Scene(), new THREE.PerspectiveCamera(), 1, 1);
  occlusion.setGBuffer(depthTexture);
  occlusion.output = GTAOPass.OUTPUT.Off;
  occlusion.updateGtaoMaterial({ radius: 16, distanceExponent: 1.2, thickness: 6, scale: 1.1, samples: 16 });
  occlusion.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
  occlusion.setSceneClipBox(clip);
  // Its high pass lets a whole pixel through once it passes the threshold, so
  // the threshold sits above the brightest sky: only the sun and glints bloom.
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.14, 0.5, 6);
  const quad = new FullScreenQuad();

  const airPass = pass(
    {
      tColor: { value: hdr.texture },
      tDepth: { value: depthTexture },
      tOcclusion: { value: occlusion.pdRenderTarget.texture },
      uOcclusion: { value: 0.9 },
      tHaze: { value: haze },
      uProjectionInverse: { value: new THREE.Matrix4() },
      uCameraWorld: { value: new THREE.Matrix4() },
      uExposure: { value: 1 },
      uSun: { value: new THREE.Vector3() },
      uSunLight: { value: air.sunLight },
      uClear: { value: air.clear },
      uThickness: { value: air.thickness },
      uFloor: { value: air.floor },
      uScale: { value: air.scale },
    },
    AIR,
  );
  const focusPass = pass(
    {
      tColor: { value: lit.texture },
      tDepth: { value: depthTexture },
      uProjectionInverse: { value: new THREE.Matrix4() },
      uFocus: { value: 1 },
      uAperture: { value: 0 },
      uTexel: { value: new THREE.Vector2() },
      uReach: { value: 10 },
    },
    FOCUS,
  );
  const shaftsPass = pass({ tColor: { value: lit.texture }, tDepth: { value: depthTexture }, uSunAt: { value: new THREE.Vector2() }, uAspect: { value: 1 } }, SHAFTS);
  const filmPass = pass(
    {
      tColor: { value: lit.texture },
      tFocus: { value: focus.texture },
      tShafts: { value: shafts.texture },
      uFocus: { value: 1 },
      uShafts: { value: 0 },
      uTime: { value: 0 },
      uAspect: { value: width / height },
      uBalance: { value: new THREE.Color() },
    },
    FILM,
  );

  // The share of the screen's pixels drawn, eased toward what the GPU's
  // time allows, or failing a timer, the time between frames.
  const clock = gpuClock(renderer.getContext() as WebGL2RenderingContext);
  let scale = Math.min(1, 1.6 / ratio);
  let sized = 0;
  let slow = 0;
  // On a slow GPU even at half size: no occlusion, focus or shafts. Timed,
  // it may come back once, if the GPU turns out to have room after all.
  let lean = false;
  let leanings = 0;
  const setLean = (on: boolean) => {
    lean = on;
    if (on) leanings++;
    airPass.uniforms.uOcclusion.value = on ? 0 : 0.9;
    filmPass.uniforms.uFocus.value = on ? 0 : 1;
  };
  const size = () => {
    if (Math.abs(sized - scale) < 0.01) return;
    sized = scale;
    const pixels = ratio * scale;
    const w = Math.max(2, Math.round(width * pixels));
    const h = Math.max(2, Math.round(height * pixels));
    hdr.setSize(w, h);
    lit.setSize(w, h);
    focus.setSize(w >> 1, h >> 1);
    shafts.setSize(w >> 1, h >> 1);
    occlusion.setSize(w >> 1, h >> 1);
    bloom.setSize(w, h);
    focusPass.uniforms.uTexel.value.set(2 / w, 2 / h);
    focusPass.uniforms.uReach.value = 14 * (w / 1920);
  };

  const run = (material: THREE.ShaderMaterial, to: THREE.WebGLRenderTarget | null) => {
    quad.material = material;
    renderer.setRenderTarget(to);
    quad.render(renderer);
  };
  const sunAt = new THREE.Vector3();

  const draw = (world: THREE.Scene, camera: THREE.PerspectiveCamera, shot: Shot) => {
    renderer.setRenderTarget(hdr);
    renderer.render(world, camera);
    if (!lean) {
      occlusion.camera = camera;
      occlusion.render(renderer, lit, hdr, 0, false);
    }

    airPass.uniforms.uProjectionInverse.value.copy(camera.projectionMatrixInverse);
    airPass.uniforms.uCameraWorld.value.copy(camera.matrixWorld);
    airPass.uniforms.uExposure.value = shot.exposure;
    airPass.uniforms.uSun.value.copy(shot.sun);
    run(airPass, lit);
    renderer.setRenderTarget(lit);
    const clearing = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(overlay, camera);
    renderer.autoClear = clearing;
    bloom.render(renderer, lit, lit, 0, false);

    if (!lean) {
      focusPass.uniforms.uProjectionInverse.value.copy(camera.projectionMatrixInverse);
      focusPass.uniforms.uFocus.value = shot.focus;
      focusPass.uniforms.uAperture.value = shot.aperture;
      run(focusPass, focus);
    }

    // Where the sun is on screen, and how far out of view.
    sunAt.copy(shot.sun).multiplyScalar(camera.far * 0.5).add(camera.position).project(camera);
    const ahead = sunAt.z < 1 ? 1 : 0;
    const inView = Math.exp(-Math.max(0, Math.abs(sunAt.x) - 1, Math.abs(sunAt.y) - 1) * 1.5);
    const strength = lean ? 0 : shot.shafts * ahead * inView;
    filmPass.uniforms.uShafts.value = strength > 0.01 ? strength : 0;
    if (strength > 0.01) {
      shaftsPass.uniforms.uSunAt.value.set(sunAt.x * 0.5 + 0.5, sunAt.y * 0.5 + 0.5);
      shaftsPass.uniforms.uAspect.value = width / height;
      run(shaftsPass, shafts);
    }

    filmPass.uniforms.uTime.value = shot.time;
    filmPass.uniforms.uBalance.value.copy(shot.balance);
    run(filmPass, null);
  };

  return {
    render(world, camera, shot) {
      size();
      clock.start();
      try {
        draw(world, camera, shot);
      } finally {
        clock.stop();
      }
    },
    depth: depthTexture,
    lean: () => lean,
    async compile() {
      const passes = new THREE.Scene();
      // Like the passes' own full-screen triangle: no normals, which would
      // make a different shader.
      const plane = new THREE.PlaneGeometry(2, 2).deleteAttribute("normal");
      const materials = [airPass, focusPass, shaftsPass, filmPass, occlusion.gtaoMaterial, occlusion.pdMaterial, bloom.materialHighPassFilter, ...bloom.separableBlurMaterials, bloom.compositeMaterial, bloom.blendMaterial];
      for (const material of materials) passes.add(new THREE.Mesh(plane, material));
      await compileGently(renderer, passes, new THREE.OrthographicCamera());
      plane.dispose();
    },
    pace(dt) {
      // Untimed, a frame long because the page held back (reduced motion, a
      // hidden tab) says nothing of the GPU.
      const gpu = clock.read();
      if (clock.timed ? gpu === undefined : dt > 0.25) return;
      const spent = gpu ?? dt;
      // Untimed, the time between frames holds the display's own pace too,
      // so only a frame slower than about 22 a second counts as long: a
      // display capped at 30 shouldn't.
      const [over, under] = clock.timed ? [0.013, 0.008] : [0.045, 0.02];
      // Long frames for a while: draw fewer pixels. Short ones: more.
      slow = slow * 0.9 + (spent > over ? 1 : spent < under ? -1 : 0) * 0.1;
      if (slow > 0.6) {
        if (scale <= 0.5 && !lean) setLean(true);
        scale = Math.max(0.5, scale - 0.1);
        slow = 0;
      } else if (slow < -0.9) {
        if (lean && clock.timed && spent < 0.005 && leanings < 2) setLean(false);
        else scale = Math.min(1, scale + 0.05);
        slow = 0;
      }
    },
    dispose() {
      clock.dispose();
      // GTAOPass and UnrealBloomPass leave a material each out of their own
      // disposal.
      occlusion.gtaoMaterial.dispose();
      bloom.materialHighPassFilter.dispose();
      for (const item of [hdr, lit, focus, shafts, depthTexture, occlusion, bloom, quad, airPass, focusPass, shaftsPass, filmPass]) item.dispose();
    },
  };
}
