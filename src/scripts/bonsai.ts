// Copyright (C) 2026 Ice de Vera. The branch walk and the pot here are
// ported from cbonsai, copyright John Allbritten
// (gitlab.com/jallbrit/cbonsai), which is GPL-3.0. Ported to TypeScript and
// changed for this site in October 2026: each step is recorded for the
// canvas stages, and the tree is laid out around the page's words.

import { clamp, random } from "./canvas";

export const FAMILY = '"Martian Mono Variable", ui-monospace, monospace';
const BARK = ["#8a6a4f", "#a3805f", "#76593f"];
const LEAF = ["#7d9a6b", "#94ad7f", "#62805a"];
const BLOSSOM = ["#f2b8c6", "#e99ab0", "#f7d4dd"];
export const GLAZE = "#7c8aa6";
export const MOSS = "#6f7d55";
const MULTIPLIER = 5;
const PAD = 14; // clear space around the words, in pixels

// cbonsai's first pot, with moss on the soil.
export const POT = [
  ":___________./~~~\\.___________:",
  " \\                           / ",
  "  \\_________________________/  ",
  "  (_)                     (_)  ",
];

type Kind = "trunk" | "left" | "right" | "dying" | "dead";
// One step of the walk, drawn as characters from cell (c, r) rightward.
export type Op = {
  c: number;
  r: number;
  text: string;
  color: string;
  leaf: boolean;
  blossom: boolean;
  branch: number; // which branch drew it
  step: number; // and where along it
};
// The path a branch took, cell by cell, with the life it had left at each.
export type Branch = {
  kind: Kind;
  points: { c: number; r: number; left: number }[];
  parent: number; // the branch it grew from, or -1 for the trunk
  at: number; // and the point there it left from
};
export type Tree = { ops: Op[]; branches: Branch[] };

// A port of cbonsai's branch walk.
// Branches step up and out, split into shoots, and end in leaves and
// blossoms. The trunk starts at cell (0, 0), just above the pot.
function walk(seed: number, life: number): Tree {
  const rand = random(seed);
  const roll = (n: number) => Math.floor(rand() * n);
  const pick = <T>(list: T[]) => list[roll(list.length)];
  const ops: Op[] = [];
  const branches: Branch[] = [];
  let shoots = 0;
  let cooldown = MULTIPLIER;

  const deltas = (kind: Kind, left: number, age: number): [number, number] => {
    if (kind === "trunk") {
      if (age <= 2 || left < 4) return [roll(3) - 1, 0];
      if (age < MULTIPLIER * 3) {
        const d = roll(10);
        return [d === 0 ? -2 : d <= 3 ? -1 : d <= 5 ? 0 : d <= 8 ? 1 : 2, age % 2 === 0 ? -1 : 0];
      }
      return [roll(3) - 1, roll(10) > 2 ? -1 : 0];
    }
    if (kind === "left" || kind === "right") {
      const y = roll(10);
      const x = roll(10);
      const dx = x <= 1 ? 2 : x <= 5 ? 1 : x <= 8 ? 0 : -1;
      return [kind === "left" ? -dx : dx, y <= 1 ? -1 : y <= 7 ? 0 : 1];
    }
    if (kind === "dying") {
      const y = roll(10);
      const x = roll(15);
      const dx = x === 0 ? -3 : x <= 2 ? -2 : x <= 5 ? -1 : x <= 8 ? 0 : x <= 11 ? 1 : x <= 13 ? 2 : 3;
      return [dx, y <= 1 ? -1 : y <= 8 ? 0 : 1];
    }
    const y = roll(10);
    return [roll(3) - 1, y <= 2 ? -1 : y <= 6 ? 0 : 1];
  };

  const shape = (kind: Kind, dx: number, dy: number) => {
    if (kind === "trunk") return dy === 0 ? "/~" : dx < 0 ? "\\|" : dx === 0 ? "/|\\" : "|/";
    if (kind === "left") return dy > 0 ? "\\" : dy === 0 ? "\\_" : dx < 0 ? "\\|" : dx === 0 ? "/|" : "/";
    return dy > 0 ? "/" : dy === 0 ? "_/" : dx < 0 ? "\\|" : dx === 0 ? "/|" : "/";
  };

  const branch = (r: number, c: number, kind: Kind, left: number, parent: number, at: number) => {
    const index = branches.length;
    const points = [{ c, r, left }];
    branches.push({ kind, points, parent, at });
    while (left > 0) {
      left--;
      const age = life - left;
      let [dx, dy] = deltas(kind, left, age);
      if (dy > 0 && r > -2) dy--;

      const here = points.length - 1;
      if (left < 3) branch(r, c, "dead", left, index, here);
      else if (kind === "trunk" && left < MULTIPLIER + 2) branch(r, c, "dying", left, index, here);
      else if ((kind === "left" || kind === "right") && left < MULTIPLIER + 2) branch(r, c, "dying", left, index, here);
      else if (kind === "trunk" && (roll(3) === 0 || left % MULTIPLIER === 0)) {
        if (roll(8) === 0 && left > 7) {
          cooldown = MULTIPLIER * 2;
          branch(r, c, "trunk", left + roll(5) - 2, index, here);
        } else if (cooldown <= 0) {
          cooldown = MULTIPLIER * 2;
          shoots++;
          branch(r, c, shoots % 2 ? "left" : "right", left + MULTIPLIER, index, here);
        }
      }
      cooldown--;
      c += dx;
      r += dy;
      points.push({ c, r, left });
      const step = points.length - 1;

      if (kind === "dying" || kind === "dead") {
        // Gaps in the canopy let the branches show through.
        if (rand() < 0.3) continue;
        // Cherry: the outermost growth is mostly blossom.
        const blossom = rand() < (kind === "dead" ? 0.75 : 0.42);
        const text = blossom ? pick(["&", "*", "&"]) : "&";
        ops.push({ c, r, text, color: pick(blossom ? BLOSSOM : LEAF), leaf: true, blossom, branch: index, step });
      } else {
        const text = shape(kind, dx, dy);
        ops.push({ c, r, text, color: pick(BARK), leaf: false, blossom: false, branch: index, step });
      }
    }
  };

  branch(0, 0, "trunk", life, -1, 0);
  return { ops, branches };
}

const leavesOf = (tree: Tree) => tree.ops.filter((op) => op.leaf).length;

// Some walks branch little and come out bare. Takes the first of a few walks
// with leaves enough for its life, or failing that the leafiest.
export function grow(seed: number, life: number): Tree {
  let best = walk(seed, life);
  for (let k = 1; k < 6 && leavesOf(best) < 0.3 * life * life; k++) {
    const tree = walk((seed + k * 0x9e3779b9) | 0, life);
    if (leavesOf(tree) > leavesOf(best)) best = tree;
  }
  return best;
}

export type Bounds = { left: number; right: number; top: number; bottom: number };

// The words, padded, in the canvas's pixels. Each block hugs its text.
export function wordsAround(canvas: HTMLCanvasElement, text: HTMLElement): Bounds[] {
  const canvasBox = canvas.getBoundingClientRect();
  return [...text.children].map((el) => {
    const box = el.getBoundingClientRect();
    return {
      left: box.left - canvasBox.left - PAD,
      right: box.right - canvasBox.left + PAD,
      top: box.top - canvasBox.top - PAD,
      bottom: box.bottom - canvasBox.top + PAD,
    };
  });
}

// The columns a tree and its pot cover in each row, in cells from the trunk's
// base.
function outline(ops: Op[]) {
  const rows = new Map<number, [number, number]>();
  const cover = (r: number, from: number, to: number) => {
    const span = rows.get(r);
    rows.set(r, span ? [Math.min(span[0], from), Math.max(span[1], to)] : [from, to]);
  };
  POT.forEach((_, i) => cover(i + 1, -15, 15));
  for (const op of ops) cover(op.r, op.c, op.c + op.text.length - 1);
  const box = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  for (const [r, [from, to]] of rows) {
    box.left = Math.min(box.left, from);
    box.right = Math.max(box.right, to);
    box.top = Math.min(box.top, r);
    box.bottom = Math.max(box.bottom, r);
  }
  return { rows, box };
}

type Outline = ReturnType<typeof outline>;

// Where cell (0, 0) goes for the tree to stand in the middle of the canvas.
function middle({ box }: Outline, cw: number, ch: number, width: number, height: number) {
  return {
    x: (width - (box.right - box.left + 1) * cw) / 2 - box.left * cw,
    y: (height - (box.bottom - box.top + 1) * ch) / 2 - box.top * ch,
  };
}

// 0, then step, -step, 2 * step, ... out to the slack on either side.
function offsets(slack: number, step: number) {
  const list = [0];
  for (let k = 1; k * step <= slack; k++) list.push(k * step, -k * step);
  return list;
}

// Centers the tree, then moves it until it clears the words: up or down a
// row at a time, and sideways too if allowed. Undefined if it can't at this
// cell size.
function place(
  tree: Outline,
  cw: number,
  ch: number,
  width: number,
  height: number,
  edge: number,
  words: Bounds[],
  sideways: boolean,
) {
  const { box } = tree;
  const w = (box.right - box.left + 1) * cw;
  const h = (box.bottom - box.top + 1) * ch;
  if (w > width - 2 * edge || h > height - 2 * edge) return;
  const { x, y } = middle(tree, cw, ch, width, height);
  const clear = (x: number, y: number) => {
    for (const [r, [from, to]] of tree.rows) {
      const left = x + from * cw;
      const right = x + (to + 1) * cw;
      const top = y + r * ch;
      for (const b of words) {
        if (left < b.right && right > b.left && top < b.bottom && top + ch > b.top) return false;
      }
    }
    return true;
  };
  const across = sideways ? offsets((width - 2 * edge - w) / 2, cw * 2) : [0];
  const down = offsets((height - 2 * edge - h) / 2, ch);
  for (const dx of across) {
    for (const dy of down) {
      if (clear(x + dx, y + dy)) return { x: x + dx, y: y + dy };
    }
  }
}

// A grown tree, its cell size, and where cell (0, 0) sits, in CSS pixels.
export type Layout = { tree: Tree; size: number; cw: number; ch: number; x: number; y: number };

// Grows the fullest tree that fits around the words at this screen's cell
// size, letting it grow up to 40% larger to fill the space. Failing that, it
// moves the tree sideways; failing that too, it shrinks the smallest tree to
// fit the screen, even over the words.
export function layoutTree(
  seed: number,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  edge: number,
  words: Bounds[],
): Layout {
  const base = clamp(Math.min(width, height) / 40, 10, 15);
  ctx.font = `100px ${FAMILY}`;
  const aspect = ctx.measureText("M").width / 100;
  // Taller rows on portrait screens, whose width would otherwise cap the tree.
  const line = 1.2 + 0.25 * clamp((height / width - 1) / 0.6);
  const trees = new Map<number, [Tree, Outline]>();
  const attempt = (life: number, size: number, sideways: boolean) => {
    let grown = trees.get(life);
    if (!grown) {
      const tree = grow(seed, life);
      grown = [tree, outline(tree.ops)];
      trees.set(life, grown);
    }
    const [tree, shape] = grown;
    const at = place(shape, size * aspect, size * line, width, height, edge, words, sideways);
    return at && { tree, size, cw: size * aspect, ch: size * line, ...at };
  };
  for (let life = 40; life >= 16; life -= 2) {
    for (let k = 16; k >= 0; k--) {
      const fit = attempt(life, base * (1 + 0.025 * k), false);
      if (fit) return fit;
    }
  }
  for (let life = 40; life >= 16; life -= 2) {
    const fit = attempt(life, base, true);
    if (fit) return fit;
  }
  const tree = grow(seed, 16);
  const shape = outline(tree.ops);
  const { box } = shape;
  const size = Math.max(
    2,
    Math.min(
      base,
      (width - 2 * edge) / ((box.right - box.left + 1) * aspect),
      (height - 2 * edge) / ((box.bottom - box.top + 1) * line),
    ),
  );
  const cw = size * aspect;
  const ch = size * line;
  return { tree, size, cw, ch, ...middle(shape, cw, ch, width, height) };
}
