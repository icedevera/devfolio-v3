import { FAMILY, GLAZE, layoutTree, MOSS, POT, wordsAround, type Bounds, type Layout, type Op } from "../scripts/bonsai";
import { clamp, fitCanvas, loop, onReady, still, type Surface } from "../scripts/canvas";
import { asciiBackdrop, cellKey, type Glyph } from "./ascii";
import type { Depth } from "./depth";
import type { Real } from "./real";
import { hash, smooth } from "./noise";
import { paletteOf } from "./palette";
import type { Gpu } from "./paint.worker";
import { buildScene, paintBackdrop, paintFlyers, paintPetals, SOIL, type Petal, type Reveal, type Scene, type SkyPixels } from "./scene";
import { cellX, forgetLayer, keepLayer, paintTree, paintTreeAt } from "./tree";
import { css, skyAt, type RGB } from "./sky";

// The longer someone stays, the more of the scene appears and the clearer it
// gets: characters, then pixels, then smooth 2D, then 3D, then as a camera
// would see it.

// The 3D stage's code, which loads later.
type DepthModule = typeof import("./depth");

// When each step starts, in seconds the page has been visible. The tree grows
// slowly, as cbonsai's does, until the horizon appears, and the camera
// settles by END.
const AT = {
  tree: 0,
  horizon: 10,
  body: 11,
  hills: 12.5,
  pixels: 14.5,
  sky: 17,
  life: 20,
  flat: 22.5,
  depth: 27.5,
  orbit: 30.5,
  real: 34.5,
};
const END = 40;

type Step = keyof typeof AT;
const STEPS = Object.keys(AT) as Step[];
const NAMES: Record<Step, string> = {
  tree: "Tree",
  horizon: "Horizon",
  body: "Sun",
  hills: "Hills",
  pixels: "Pixels",
  sky: "Sky",
  life: "Birds",
  flat: "2D",
  depth: "3D",
  orbit: "Orbit",
  real: "Real",
};

const nameOf = (step: Step, s: Scene) =>
  step === "body" && s.sky.body === "moon" ? "Moon" : step === "life" && s.night >= 0.5 ? "Fireflies" : NAMES[step];

const stepAt = (t: number) => Math.max(0, STEPS.filter((step) => AT[step] <= t).length - 1);

function revealAt(t: number): Reveal {
  const at = (start: number, length: number) => smooth(start, start + length, t);
  return {
    horizon: at(AT.horizon, 1),
    body: at(AT.body, 1.5),
    far: at(AT.hills, 1.2),
    near: at(AT.hills + 0.7, 1.2),
    sky: at(AT.sky, 2.5),
    clouds: at(AT.sky + 0.5, 2),
    birds: at(AT.life, 1),
    mist: at(AT.life + 0.5, 2),
    rays: at(AT.flat + 2.5, 2),
  };
}

// The pixel size in CSS pixels, which shrinks a step at a time, and how
// much the colors are dithered. Size 1 is the smooth 2D scene.
function pixelsAt(t: number) {
  if (t < AT.flat) return { size: Math.round(8 - 5 * smooth(AT.sky, AT.flat, t)), dither: 1 };
  const k = clamp((t - AT.flat) / 3);
  return { size: Math.max(1, Math.round(3 - 2 * k)), dither: 1 - k };
}


// Ordered dithering, the way old screens faked more colors than they had.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);

// Snaps each pixel to its nearest palette color, remembering answers by
// 15-bit color. Pixels are read and written whole, as 32-bit numbers with
// red in the low byte, as canvases keep them.
function quantize(ctx: CanvasRenderingContext2D, w: number, h: number, palette: RGB[], memo: Int16Array, dither: number) {
  const image = ctx.getImageData(0, 0, w, h);
  const pixels = new Uint32Array(image.data.buffer);
  const colors = palette.map(([r, g, b]) => Math.round(r) | (Math.round(g) << 8) | (Math.round(b) << 16));
  const shift = BAYER.map((v) => v * dither * 10);
  for (let y = 0, i = 0; y < h; y++) {
    const row = (y & 3) * 4;
    for (let x = 0; x < w; x++, i++) {
      const v = pixels[i];
      const offset = shift[row + (x & 3)];
      let r = (v & 255) + offset;
      let g = ((v >>> 8) & 255) + offset;
      let b = ((v >>> 16) & 255) + offset;
      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let best = memo[key];
      if (best < 0) {
        let nearest = Infinity;
        for (let k = 0; k < palette.length; k++) {
          const c = palette[k];
          const d = 2 * (r - c[0]) ** 2 + 4 * (g - c[1]) ** 2 + 3 * (b - c[2]) ** 2;
          if (d < nearest) {
            nearest = d;
            best = k;
          }
        }
        memo[key] = best;
      }
      pixels[i] = (v & 0xff000000) | colors[best];
    }
  }
  ctx.putImageData(image, 0, 0);
}

export function mountScene(root: HTMLElement) {
  const canvas = root.querySelector<HTMLCanvasElement>("canvas.flat");
  const glCanvas = root.querySelector<HTMLCanvasElement>("canvas.depth");
  const realCanvas = root.querySelector<HTMLCanvasElement>("canvas.real");
  // Birds and fireflies fly in front of the 3D scene, on a canvas of their own.
  const overCanvas = root.querySelector<HTMLCanvasElement>("canvas.over");
  const text = root.querySelector("main");
  const replant = root.querySelector<HTMLButtonElement>("[data-plant]");
  const stages = root.querySelector<HTMLOListElement>("[data-stages]");
  const stageLabel = root.querySelector<HTMLElement>("[data-stage]");
  if (!canvas || !glCanvas || !realCanvas || !overCanvas || !text || !replant || !stages || !stageLabel) return;

  // A dot for each step, which plays it.
  const dots = STEPS.map((_, i) => {
    const item = document.createElement("li");
    const dot = document.createElement("button");
    dot.type = "button";
    dot.addEventListener("click", () => playStep(i));
    item.append(dot);
    stages.append(item);
    return dot;
  });
  stages.style.setProperty("--count", String(STEPS.length));
  let marked = -1; // the step the dots last showed

  let surface: Surface | undefined;
  let layout: Layout | undefined;
  let scene: Scene | undefined;
  let words: Bounds[] = [];
  // On the dev server: ?t= seconds in, held there, ?seed= a tree, ?hour= the
  // time of day.
  const params = new URLSearchParams(import.meta.env.DEV ? location.search : "");
  let seed = Number(params.get("seed")) || Math.floor(Math.random() * 1e9);
  const start = Number(params.get("t"));
  const hour = params.get("hour");
  const now = () => {
    const date = new Date();
    if (hour !== null) date.setHours(Number(hour), (Number(hour) % 1) * 60);
    return date;
  };
  // The timeline, which the controls can pause and move, and the clock that
  // keeps clouds and stars moving regardless.
  let elapsed = Number.isFinite(start) ? clamp(start, 0, 600) : 0;
  let clock = 0;
  let playing = !params.has("t");
  let step = stepAt(elapsed); // the step on show
  let until = Infinity; // where a single step stops
  let planted = 0; // when this tree started growing
  let last = performance.now();
  let checked = 0; // when the sky was last read from the clock
  const petals: Petal[] = [];
  let nextPetal = 0;
  // The 3D view: a slight lean after the pointer, eased, and where a drag has
  // turned it. Once someone drags, the camera's own drift stops.
  let pointer = 0;
  let lean = 0;
  let yaw = 0;
  let pitch = 0;
  let aim = { yaw: 0, pitch: 0 };
  let drift = 1;
  let held = false;
  // How far the wheel has brought the camera in toward the tree, 0 to 1.
  let closer = 0;
  let closerAim = 0;
  let drag: { x: number; y: number } | undefined;
  let lively = 0; // until when the view is being leaned or zoomed, in page time
  let interval = 1000 / 60; // the screen's time between frames, as measured
  let seen = 0; // the last frame the screen offered
  let every = 1; // draw every this many frames the screen offers
  let everyFor = 0; // the rate `every` was worked out for

  // Characters, the tree's revealed so far.
  let grown = new Map<number, Op>();
  let shown = 0;
  const pot = new Map<number, Glyph>();

  // Offscreen canvases: the pixel stage paints small, and the characters
  // paint apart while the pixels ripple through them.
  const low = document.createElement("canvas");
  const lowCtx = low.getContext("2d", { willReadFrequently: true });
  if (lowCtx) lowCtx.imageSmoothingQuality = "high";
  const glyphs = document.createElement("canvas");
  let over: Surface | undefined;
  let fetched = false; // the 3D stages' code has been asked for
  let depthModule: DepthModule | undefined; // once its code has loaded
  let depth: Depth | undefined;
  let loading = false;
  let depthSince = Infinity; // the clock when 3D was first ready
  let warming = false; // a 3D stage is getting ready to show
  // The last picture of each 3D stage is kept up, when one is showing, until
  // its replacement after a rebuild is ready.
  let holding = false;
  let holdingReal = false;
  let depthShown = 0; // how far the 3D stage showed at the last frame
  let real: Real | undefined;
  let developing = false; // the real stage is being built
  let realSince = 0; // the clock when it was ready
  let realShown = 0; // how far it has faded in
  // How long the realistic stage has drawn under 20 frames a second, net of
  // the time it kept up: in all, and since it dropped all it can. And when
  // (in page time) it began fading out for being too slow.
  let slowFor = 0;
  let leanFor = 0;
  let retiring = Infinity;
  let palette: RGB[] | undefined; // worked out when the pixels first need it
  // After a resize, the new scene waits for the worker's pictures before it
  // takes the place of the one showing, which plays on meanwhile, stretched,
  // so the page never paints them itself.
  let coming: { scene: Scene; layout: Layout; words: Bounds[]; width: number; height: number; ratio: number; palette?: RGB[]; ready: boolean } | undefined;
  // Lets a resized scene go without showing it, with its pictures.
  const drop = () => {
    if (coming) forgetLayer(coming.scene);
    coming = undefined;
  };
  const memo = new Int16Array(32768);

  // The last step this screen can show. Without WebGL 2, or with only a
  // software stand-in for a GPU (which browsers report as a major
  // performance caveat), the scene stays 2D and three.js is never fetched. A
  // stage that fails to build or loses its GPU, or the realistic one drawn
  // too slowly, goes for good.
  let reach = STEPS.length - 1;
  const stopAt = (last: Step) => {
    reach = Math.min(reach, STEPS.indexOf(last));
    // A stage dropped is never drawn again, so its canvas gives back its
    // drawing buffer too.
    if (reach < STEPS.indexOf("depth")) {
      depth?.dispose();
      depth = undefined;
      holding = false;
      glCanvas.width = glCanvas.height = 1;
    }
    if (reach < STEPS.indexOf("real")) {
      real?.dispose();
      real = undefined;
      holdingReal = false;
      realCanvas.width = realCanvas.height = 1;
    }
    dots.forEach((dot, i) => dot.parentElement?.toggleAttribute("hidden", i > reach));
    stages.style.setProperty("--count", String(reach + 1));
    marked = -1;
  };
  // Whether there's a GPU for 3D. The paint worker asks, so the page never
  // waits while the browser first sets up WebGL (half a second, once);
  // failing that, the page asks itself.
  let asked = false;
  const askHere = () => {
    if (asked) return;
    asked = true;
    const probe = document.createElement("canvas").getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    probe?.getExtension("WEBGL_lose_context")?.loseContext();
    if (!probe) stopAt("flat");
  };
  const heard = (gpu: Gpu) => {
    if (gpu === "unknown") return askHere();
    if (asked) return;
    asked = true;
    if (gpu === "slow") stopAt("flat");
  };

  // What the scene draws from pictures (the moon, the Milky Way, the clouds
  // and the smooth tree) is painted in a worker as soon as there's a scene,
  // so it's ready long before it shows and the page never waits on it.
  // Without one, each is painted here when first needed.
  let painter: Worker | undefined;
  let painterFailed = false;
  const painting = new Map<number, Scene>();
  const skies = new Set<Scene>(); // scenes whose sky the worker is painting
  let paints = 0;
  // How long the worker has had work and said nothing, counting only time
  // the page ran: a tab put to sleep doesn't count against it, nor does a
  // slow download of the worker itself (it has said nothing at all yet).
  let quiet = 0;
  let spoken = false;
  // Given up on for good: the page paints what it needs itself.
  const giveUp = () => {
    painter?.terminate();
    painter = undefined;
    painterFailed = true;
    painting.clear();
    skies.clear();
    // A scene waiting on it goes up now, its pictures painted here.
    if (coming) coming.ready = true;
    wake();
    askHere();
  };
  const paintAhead = (forScene: Scene) => {
    if (typeof OffscreenCanvas === "undefined" || painterFailed) return askHere();
    try {
      painter ??= new Worker(new URL("./paint.worker.ts", import.meta.url), { type: "module" });
    } catch {
      painterFailed = true;
      return askHere();
    }
    painter.onmessage = ({ data }: MessageEvent<{ gpu?: Gpu; id?: number; sky?: SkyPixels; tree?: ImageBitmap; small?: ImageBitmap[]; palette?: RGB[]; done?: boolean }>) => {
      quiet = 0;
      spoken = true;
      if (data.gpu) return heard(data.gpu);
      if (data.id === undefined) return;
      const made = painting.get(data.id);
      if (made && (data.sky || data.done)) skies.delete(made);
      const wanted = made !== undefined && (made === scene || made === coming?.scene);
      if (data.sky && wanted) made.adopt(data.sky);
      if (data.tree) {
        if (wanted) {
          keepLayer(made, data.tree, data.small);
          if (made === scene) palette ??= data.palette;
          else if (coming) coming.palette = data.palette;
        } else {
          data.tree.close();
          data.small?.forEach((copy) => copy.close());
        }
      }
      if (data.done) {
        painting.delete(data.id);
        if (coming && made === coming.scene) {
          coming.ready = true;
          wake();
        }
      }
    };
    painter.onerror = (event) => {
      event.preventDefault();
      giveUp();
    };
    if (painting.size === 0) quiet = 0;
    painting.set(++paints, forScene);
    skies.add(forScene);
    const { layout: l, width, height, sky, seed: from, words: around } = forScene;
    painter.postMessage({ id: paints, layout: l, width, height, sky, seed: from, words: around, ratio: Math.min(devicePixelRatio || 1, 2) });
  };

  // Puts `next` up in place of the scene showing.
  const show = (next: Scene) => {
    if (scene) forgetLayer(scene);
    scene = next;
    palette = undefined;
    memo.fill(-1);
    if (depth) holding = true;
    if (real && realShown > 0) holdingReal = true;
    depth?.dispose();
    depth = undefined;
    real?.dispose();
    real = undefined;
  };

  const build = () => {
    if (!surface || !layout) return;
    const next = buildScene(layout, surface.width, surface.height, skyAt(now()), seed, words);
    paintAhead(next);
    show(next);
  };

  // Sizes the canvases to their boxes, which clears them.
  const fit = () => {
    surface = fitCanvas(canvas);
    const ratio = Math.min(devicePixelRatio || 1, 2);
    glyphs.width = Math.round(surface.width * ratio);
    glyphs.height = Math.round(surface.height * ratio);
    over = fitCanvas(overCanvas);
  };

  const plant = () => {
    // A tree planted while a resized scene is on its way replaces it, at the
    // new size.
    if (coming) {
      drop();
      fit();
    }
    if (!surface) return;
    const edge = parseFloat(getComputedStyle(text).paddingTop);
    words = wordsAround(canvas, text);
    layout = layoutTree(seed, surface.ctx, surface.width, surface.height, edge, words);
    pot.clear();
    POT.forEach((line, i) => {
      for (let k = 0; k < line.length; k++) {
        if (line[k] === " ") continue;
        pot.set(cellKey(k - 15, i + 1), { char: line[k], color: i === 0 && k >= 13 && k <= 17 ? MOSS : GLAZE });
      }
    });
    grown = new Map();
    shown = 0;
    petals.length = 0;
    build();
  };

  const setup = () => {
    // Once a worker paints the pictures, a resize lays the new scene out
    // without touching the canvases, and it goes up once they're in.
    if (scene && surface && painter && !painterFailed) {
      const { width, height } = canvas.getBoundingClientRect();
      const edge = parseFloat(getComputedStyle(text).paddingTop);
      const around = wordsAround(canvas, text);
      const laid = layoutTree(seed, surface.ctx, width, height, edge, around);
      const next = buildScene(laid, width, height, skyAt(now()), seed, around);
      drop();
      coming = { scene: next, layout: laid, words: around, width, height, ratio: Math.min(devicePixelRatio || 1, 2), ready: false };
      paintAhead(next);
      return;
    }
    drop();
    fit();
    plant();
  };

  // The resized scene, its pictures in, takes the place of the one showing,
  // just before a frame draws it.
  const arrive = () => {
    if (!coming) return;
    // Resized again meanwhile: it's let go, as a newer one is on its way.
    const { width, height } = canvas.getBoundingClientRect();
    if (width !== coming.width || height !== coming.height || Math.min(devicePixelRatio || 1, 2) !== coming.ratio) return drop();
    const next = coming;
    coming = undefined;
    fit();
    layout = next.layout;
    words = next.words;
    grown = new Map();
    shown = 0;
    petals.length = 0;
    show(next.scene);
    palette = next.palette;
  };

  // Characters: the backdrop, then the pot and tree on top.
  const drawCharacters = (ctx: CanvasRenderingContext2D, s: Scene, v: Reveal, t: number) => {
    const l = s.layout;
    ctx.fillStyle = css(SOIL);
    ctx.fillRect(0, 0, s.width, s.height);
    const cells = new Map<number, Glyph>();
    asciiBackdrop(cells, s, v, t);
    for (const [key, glyph] of pot) cells.set(key, glyph);
    for (const [key, op] of grown) cells.set(key, { char: op.text, color: op.color });
    ctx.font = `${l.size}px ${FAMILY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const byColor = new Map<string, number[]>();
    for (const [key, glyph] of cells) {
      const list = byColor.get(glyph.color) ?? [];
      list.push(key);
      byColor.set(glyph.color, list);
    }
    for (const [color, keys] of byColor) {
      ctx.fillStyle = color;
      for (const key of keys) {
        const glyph = cells.get(key);
        if (!glyph) continue;
        const r = Math.floor(key / 8192) - 2048;
        const c = (key % 8192) - 4096;
        ctx.fillText(glyph.char, l.x + (c + 0.5) * l.cw, l.y + (r + 0.5) * l.ch);
      }
    }
    for (const p of petals) {
      const turn = Math.sin(p.phase * 1.3);
      ctx.globalAlpha = 0.85 * clamp(p.y / 60);
      ctx.fillStyle = p.color;
      ctx.fillText(turn > 0.35 ? "'" : turn < -0.35 ? "," : ".", p.x, p.y);
    }
    ctx.globalAlpha = 1;
  };

  const drawPixels = (ctx: CanvasRenderingContext2D, s: Scene, v: Reveal, t: number, size: number, dither: number) => {
    if (!lowCtx) return;
    const w = Math.ceil(s.width / size);
    const h = Math.ceil(s.height / size);
    if (low.width !== w || low.height !== h) {
      low.width = w;
      low.height = h;
    }
    lowCtx.setTransform(1 / size, 0, 0, 1 / size, 0, 0);
    paintBackdrop(lowCtx, s, v, t);
    paintTreeAt(lowCtx, s, size);
    paintPetals(lowCtx, petals, s.layout.cw);
    palette ??= paletteOf(s);
    quantize(lowCtx, w, h, palette, memo, dither);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(low, 0, 0, w * size, h * size);
    ctx.imageSmoothingEnabled = true;
  };

  // The 3D stage is built a few milliseconds at a time and shown once it's
  // ready, so neither its building nor its first frame holds the page up.
  // The first is built well before it's due. A rebuild (for a resize, say)
  // keeps the old one's last picture up meanwhile, rather than showing 2D.
  const loadDepth = () => {
    if (!asked || loading || warming || depth || !scene || reach < STEPS.indexOf("depth")) return;
    // Its sky comes from the worker, in a moment, rather than painted here.
    if (skies.has(scene)) return;
    if (depthShown === 0) holding = false;
    const forScene = scene;
    const stale = () => scene !== forScene || reach < STEPS.indexOf("depth");
    const make = (module: DepthModule) => {
      warming = true;
      void (async () => {
        let made: Depth | undefined;
        try {
          made = await module.createDepth(glCanvas, forScene, still.matches ? 0 : clock, !holding);
          await made.ready;
          if (stale()) return made.dispose();
          depth = made;
          holding = false;
          depthSince = Math.min(depthSince, clock);
        } catch (error) {
          made?.dispose();
          // A lost context has already dropped the stage, as expected.
          if (reach >= STEPS.indexOf("depth")) console.error(error);
          stopAt("flat");
        } finally {
          warming = false;
        }
      })();
    };
    if (depthModule) return make(depthModule);
    loading = true;
    import("./depth")
      .then((module) => {
        depthModule = module;
        if (!stale()) make(module);
      })
      .catch((error: unknown) => {
        stopAt("flat");
        console.error(error);
      })
      .finally(() => {
        loading = false;
      });
  };

  // The realistic stage takes a few seconds to build, so it starts once the
  // 3D one shows.
  const loadReal = () => {
    if (developing || real || !scene || reach < STEPS.indexOf("real") || retiring < Infinity) return;
    if (realShown === 0) holdingReal = false;
    developing = true;
    const forScene = scene;
    const held = holdingReal;
    import("./real")
      .then(({ createReal }) => createReal(realCanvas, forScene, !held))
      .then((made) => {
        if (scene !== forScene || reach < STEPS.indexOf("real")) {
          made.dispose();
          // Its stage was given up while it was being made, after the canvas
          // was, so the canvas is given back again. Builds never overlap, so
          // nothing newer is drawing on it.
          if (reach < STEPS.indexOf("real")) realCanvas.width = realCanvas.height = 1;
          return;
        }
        real = made;
        // A replacement takes the old one's place at once; the first fades in.
        if (!holdingReal) realSince = clock;
        holdingReal = false;
        slowFor = 0;
        leanFor = 0;
      })
      .catch((error: unknown) => {
        // A lost context has already dropped the stage, as expected. Any
        // other failure is worth a trace.
        if (reach >= STEPS.indexOf("real")) console.error(error);
        stopAt("orbit");
      })
      .finally(() => {
        developing = false;
      });
  };

  glCanvas.addEventListener("webglcontextlost", () => stopAt("flat"));
  realCanvas.addEventListener("webglcontextlost", () => stopAt("orbit"));

  // The sky follows the clock, but rebuilding it costs a moment, and in 3D
  // a flash: only once the sun or moon has moved enough to see, and in 3D
  // only once it has moved a lot.
  const followSky = () => {
    const was = scene?.sky;
    const sky = skyAt(now());
    if (!was) return;
    const moved = Math.abs(sky.elevation - was.elevation) + Math.abs(sky.progress - was.progress) * 180;
    if (coming) return;
    if (sky.body !== was.body || moved > (depth || real ? 8 : 2)) build();
  };

  const frame = (now: number) => {
    const offered = now - seen;
    seen = now;
    if (offered > 0 && offered < 100) interval += (offered - interval) * 0.05;
    // Characters and pixels change 30 times a second, which suits them;
    // smooth 2D and 3D 60 times, which their slow drift needs no more than;
    // and 3D while someone turns, zooms or leans it, as often as the screen
    // shows. That's every Nth frame the screen offers, evenly: a 120 Hz screen
    // draws every other frame (60 fps), 144 Hz every other (72), and 75 to
    // 100 Hz every one. A frame counts within half an interval of its time.
    // A screen between two (165 Hz) keeps the one it settled on.
    const moving = drag !== undefined || now < lively;
    const rate = moving && depth ? Infinity : elapsed >= AT.flat + 3 ? 60 : 30;
    const frames = 1000 / rate / interval;
    if (rate !== everyFor || Math.abs(frames - every) > 0.75) {
      every = Math.max(1, Math.floor(frames + 0.25));
      everyFor = rate;
    }
    if (now - last < (every - 0.5) * interval) return;
    // Reduced motion draws once a second, so it may move a whole second.
    const gap = (now - last) / 1000;
    const dt = Math.min(still.matches ? 1 : 0.1, gap);
    last = now;
    if (!document.hidden) {
      clock += dt;
      if (playing) elapsed += dt;
    }
    if (elapsed >= until) {
      // Hold at the end of a single step.
      elapsed = until;
      until = Infinity;
      playing = false;
    } else if (playing && until === Infinity) step = stepAt(elapsed);
    step = Math.min(step, reach);
    if (now - checked > 60000) {
      checked = now;
      followSky();
    }
    // A worker gone quiet with work outstanding is given up on, as if it had
    // failed, so nothing waits on it for good.
    if (painter && spoken && painting.size > 0) {
      quiet += Math.min(gap, still.matches ? 1 : 0.1);
      if (quiet > 8) giveUp();
    }
    if (coming?.ready) arrive();
    const s = surface;
    const sc = scene;
    if (!s || !sc) return;
    const { ctx } = s;
    const t = still.matches ? 0 : clock;
    const v = revealAt(elapsed);
    const l = sc.layout;

    // Reveal the walk in order, so the tree grows the way it was drawn.
    const ops = l.tree.ops;
    const target = Math.ceil(ops.length * clamp((elapsed - planted) / AT.horizon));
    if (target < shown) {
      grown = new Map();
      shown = 0;
    }
    for (; shown < target; shown++) {
      const op = ops[shown];
      for (let k = 0; k < op.text.length; k++) {
        grown.set(cellKey(op.c + k, op.r), { ...op, text: op.text[k], c: op.c + k });
      }
    }

    // Once grown, blossoms let go now and then and drift on the wind.
    if (still.matches) petals.length = 0;
    else if (shown >= ops.length && now > nextPetal && petals.length < 60) {
      const blossoms = ops.filter((op) => op.blossom);
      const from = blossoms[Math.floor(Math.random() * blossoms.length)];
      if (from) {
        petals.push({
          x: cellX(l, from.c),
          y: l.y + (from.r + 0.5) * l.ch,
          vx: -10 - Math.random() * 18,
          vy: 12 + Math.random() * 14,
          phase: Math.random() * Math.PI * 2,
          color: from.color,
        });
      }
      nextPetal = now + 500 + Math.random() * 1100;
    }
    for (let i = petals.length - 1; i >= 0; i--) {
      const p = petals[i];
      p.phase += dt * 1.8;
      p.x += (p.vx + Math.sin(p.phase) * 14) * dt;
      p.y += p.vy * dt;
      if (p.y > sc.height + 10 || p.x < -10) petals.splice(i, 1);
    }

    const ripple = clamp((elapsed - AT.pixels) / (AT.sky - AT.pixels));
    const { size, dither } = pixelsAt(elapsed);
    // The 3D stages' code downloads once the tree has grown, well before
    // it's needed.
    if (!fetched && asked && elapsed > AT.horizon && reach >= STEPS.indexOf("depth")) {
      fetched = true;
      import("./depth").catch(() => undefined);
      if (reach >= STEPS.indexOf("real")) import("./real").catch(() => undefined);
    }
    if (elapsed > AT.life) loadDepth();
    if (depth && elapsed > AT.depth) loadReal();
    // Each 3D stage fades in on time, or once it is ready if it's late.
    const fade = depth || holding ? Math.min(smooth(AT.depth, AT.depth + 3, elapsed), smooth(depthSince, depthSince + 3, clock)) : 0;
    depthShown = fade;
    let realFade = real || holdingReal ? Math.min(smooth(AT.real, AT.real + 3, elapsed), smooth(realSince, realSince + 3, clock)) : 0;
    // The realistic stage first draws fewer pixels, then drops its costliest
    // passes, to keep up. If it still can't, it fades back to 3D: 6 seconds
    // slow with nothing left to drop, or 20 in all (slow for some other
    // reason than its GPU).
    if (retiring < Infinity) {
      realFade *= 1 - smooth(retiring, retiring + 1500, now);
      if (now > retiring + 1500) {
        retiring = Infinity;
        realFade = 0;
        stopAt("orbit");
      }
    } else if (real && realFade >= 1 && !still.matches) {
      // Real time between frames, though no single pause counts for more
      // than half a second.
      const slow = gap > 0.05 ? Math.min(gap, 0.5) : -gap;
      slowFor = Math.max(0, slowFor + slow);
      leanFor = real.lean() ? Math.max(0, leanFor + slow) : 0;
      if (leanFor > 6 || slowFor > 20) retiring = now;
    }
    realShown = realFade;
    const turnable = fade > 0.5;
    if (root.classList.contains("turnable") !== turnable) root.classList.toggle("turnable", turnable);

    // The pixels and the smooth 2D draw from the worker's pictures. Until
    // they're in (just after a new tree, say), the last frame stays up rather
    // than the page painting them itself.
    const waiting = fade < 1 && [...painting.values()].includes(sc);
    if (ripple === 0) drawCharacters(ctx, sc, v, t);
    else if (waiting) {
      // The last frame stays.
    } else if (ripple < 1) {
      // The pixels spread out from the pot like a ripple.
      drawPixels(ctx, sc, v, t, size, dither);
      const gctx = glyphs.getContext("2d");
      if (gctx) {
        const ratio = glyphs.width / sc.width;
        gctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        drawCharacters(gctx, sc, v, t);
        const cx = cellX(l, 0);
        const cy = l.y + 2 * l.ch;
        const reach = Math.hypot(Math.max(cx, sc.width - cx), Math.max(cy, sc.height - cy));
        ctx.save();
        ctx.beginPath();
        const cols = Math.ceil(sc.width / l.cw) + 2;
        const rows = Math.ceil(sc.height / l.ch) + 2;
        const c0 = Math.floor(-l.x / l.cw) - 1;
        const r0 = Math.floor(-l.y / l.ch) - 1;
        for (let r = r0; r < r0 + rows; r++) {
          for (let c = c0; c < c0 + cols; c++) {
            const x = l.x + c * l.cw;
            const y = l.y + r * l.ch;
            const d = Math.hypot(x - cx, y - cy) / reach + 0.12 * hash(c, r, 21);
            if (d > ripple * 1.12) ctx.rect(x, y, l.cw, l.ch);
          }
        }
        ctx.clip();
        ctx.drawImage(glyphs, 0, 0, sc.width, sc.height);
        ctx.restore();
      }
    } else if (size > 1) drawPixels(ctx, sc, v, t, size, dither);
    else if (fade < 1) {
      paintBackdrop(ctx, sc, v, t);
      paintTree(ctx, sc);
      paintPetals(ctx, petals, l.cw);
    }

    glCanvas.style.opacity = String(fade);
    realCanvas.style.opacity = String(realFade);
    // A photograph's bright ground needs more shade under the words.
    const shade = realFade.toFixed(2);
    if (root.style.getPropertyValue("--real") !== shade) root.style.setProperty("--real", shade);
    if (over) {
      over.ctx.clearRect(0, 0, over.width, over.height);
      // The realistic stage has fireflies of its own.
      const flyers = v.birds * fade * (sc.night >= 0.5 ? 1 - realFade : 1);
      if ((depth || holding) && flyers > 0) paintFlyers(over.ctx, sc, flyers, t);
    }
    if (depth && fade > 0) {
      const orbit = still.matches ? 0 : smooth(AT.orbit, AT.orbit + 4, elapsed);
      const ease = (rate: number) => 1 - Math.exp(-dt * rate);
      lean += ((still.matches ? 0 : 0.05 * pointer) - lean) * ease(2.5);
      yaw += (aim.yaw - yaw) * ease(10);
      pitch += (aim.pitch - pitch) * ease(10);
      drift += ((held ? 0 : 1) - drift) * ease(1.5);
      closer += (closerAim * realFade - closer) * ease(6);
      const turn = orbit * drift * 0.38 * Math.sin(clock * 0.3) + fade * (lean + yaw);
      const tilt = orbit * drift * 0.06 + fade * pitch;
      if (realFade < 1) depth.render(turn, tilt, petals, t);
      if (real && realFade > 0) real.render(turn, tilt, closer, petals, t, realFade >= 1);
    }

    // The stepper: dots up to this step filled, and the line between them
    // filling as the step plays.
    const from = AT[STEPS[step]];
    const to = step + 1 < STEPS.length ? AT[STEPS[step + 1]] : END;
    const progress = clamp((step + clamp((elapsed - from) / (to - from))) / reach);
    stages.style.setProperty("--progress", progress.toFixed(4));
    if (marked !== step) {
      dots.forEach((dot, i) => {
        dot.classList.toggle("past", i < step);
        if (i === step) dot.setAttribute("aria-current", "step");
        else dot.removeAttribute("aria-current");
      });
      marked = step;
    }
    dots.forEach((dot, i) => {
      const name = nameOf(STEPS[i], sc);
      if (dot.title === name) return;
      dot.title = name;
      dot.setAttribute("aria-label", name);
    });
    const name = nameOf(STEPS[step], sc);
    if (stageLabel.textContent !== name) stageLabel.textContent = name;
  };

  const wake = loop(frame, Infinity);
  // Reduced motion still moves through the steps, one still frame a second.
  setInterval(() => {
    if (still.matches) wake();
  }, 1000);

  const seek = (time: number) => {
    elapsed = time;
    if (elapsed < planted) planted = 0;
    wake();
  };
  // Plays one step from its start, and holds where the next one begins. The
  // view goes back to where the camera would have it.
  function playStep(index: number) {
    aim = { yaw: 0, pitch: 0 };
    closerAim = 0;
    held = false;
    step = clamp(index, 0, STEPS.length - 1);
    until = step + 1 < STEPS.length ? AT[STEPS[step + 1]] : END;
    playing = true;
    seek(AT[STEPS[step]]);
  }

  // A new tree grows from the first step and plays through them all.
  replant.addEventListener("click", () => {
    seed = Math.floor(Math.random() * 1e9);
    aim = { yaw: 0, pitch: 0 };
    closerAim = 0;
    held = false;
    step = 0;
    until = Infinity;
    playing = true;
    planted = 0;
    plant();
    seek(0);
  });

  // Dragging the 3D scene turns it, all the way round, and tilts it a
  // little.
  root.addEventListener("pointerdown", (event) => {
    if (!root.classList.contains("turnable") || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("a, button, details")) return;
    drag = { x: event.clientX, y: event.clientY };
    held = true;
    root.setPointerCapture(event.pointerId);
    root.classList.add("turning");
  });
  root.addEventListener("pointermove", (event) => {
    pointer = (event.clientX / innerWidth) * 2 - 1;
    lively = performance.now() + 400;
    if (!drag) return;
    aim = {
      yaw: aim.yaw - ((event.clientX - drag.x) / innerWidth) * Math.PI * 1.5,
      pitch: clamp(aim.pitch + ((event.clientY - drag.y) / innerHeight) * 0.8, -0.04, 0.22),
    };
    drag = { x: event.clientX, y: event.clientY };
    wake();
  });
  const release = () => {
    drag = undefined;
    root.classList.remove("turning");
  };
  root.addEventListener("pointerup", release);
  root.addEventListener("pointercancel", release);
  // In the realistic stage, the wheel brings the camera in toward the tree.
  // At either end, over the writing list, or with ctrl held for the
  // browser's zoom, it scrolls.
  root.addEventListener(
    "wheel",
    (event) => {
      if (realShown < 1 || event.ctrlKey) return;
      if (event.target instanceof Element && event.target.closest("details")) return;
      const next = clamp(closerAim - event.deltaY * (event.deltaMode === 1 ? 0.04 : 0.0012));
      if (next === closerAim) return;
      event.preventDefault();
      closerAim = next;
      lively = performance.now() + 600;
      wake();
    },
    { passive: false },
  );

  // The words can reflow without the canvas changing size, as with text-only
  // zoom, so they're watched too. After the first, the scene is rebuilt once
  // a resize has settled, not at every step of it; meanwhile the canvases
  // stretch.
  let settling = 0;
  onReady(
    canvas,
    FAMILY,
    () => {
      clearTimeout(settling);
      if (!surface) {
        setup();
        wake();
        return;
      }
      settling = window.setTimeout(() => {
        setup();
        wake();
      }, 150);
    },
    text.children,
  );
}
