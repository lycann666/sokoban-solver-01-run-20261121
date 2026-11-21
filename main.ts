// Push-optimal Sokoban solver — per-room A* over pushes.
//
// Idea: a level is a 1-wide hallway (the player's row) with 1-4 rooms off
// it, one door each. A box pushed out of a door can never come back, so the
// rooms are independent problems and the level optimum is the sum of the
// rooms' optima. We split the level into rooms, then solve each room with an
// A* search over pushes and stitch the walks together.
//
// A search state is the sorted box squares plus the player's reachable
// region (named by its lowest square). The heuristic is the minimum-cost
// assignment of boxes to goals under box-move distances (ignoring other
// boxes), which never overestimates the pushes still needed. Two deadlocks
// are pruned: a box on a dead square (no pull-back path from any goal
// reaches it) and a frozen 2x2 block of walls and boxes holding a box off
// its goal. Neither prunes a solvable state, so the first solved state the
// A* settles is push-optimal for its room.
//
// Pure and deterministic: the budget is a count of expansions, never the
// wall clock; ties break on the state's key, so two runs write the same
// bytes. Local run:
//   mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
/** Expansions one push search may spend before it gives up: work, never the clock. */
const MAX_EXPANSIONS = 2_000_000;

type Dir = { dx: number; dy: number; ch: string };
const DIRS: Dir[] = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
];

type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on goal, @ player). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * Live squares: the squares a box can stand on and still be pushed onto some
 * goal. Found by pulling boxes back from the goals: a box on square x is
 * live, so the square y one step back from x is live too when the player can
 * stand one step further back (y - d) to make that pull.
 */
function liveSquares(wall: Uint8Array, goals: number[], w: number): Uint8Array {
  const n = wall.length;
  const live = new Uint8Array(n);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const d of DIRS) {
      const step = d.dy * w + d.dx;
      const y = x - step;
      const behind = y - step;
      if (y < 0 || y >= n || behind < 0 || behind >= n) continue;
      if (wall[y] || wall[behind] || live[y]) continue;
      live[y] = 1;
      queue.push(y);
    }
  }
  return live;
}

/**
 * The level's rooms: cut the dead floor squares of the player's row (the
 * hallway: a box there reaches no goal) out of the floor, and each remaining
 * connected part holding boxes is a room. Null when the level is no set of
 * rooms (a box starts in the hallway, a goal is cut off, or some part holds
 * a different count of boxes and goals).
 */
function roomsOf(level: Level): { boxes: number[]; goals: number[] }[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(wall, goals, w);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { cells: number[]; boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const cells = [s];
    part[s] = rooms.length;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k]!;
      for (const d of DIRS) {
        const q = c + d.dy * w + d.dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          cells.push(q);
        }
      }
    }
    rooms.push({ cells, boxes: [], goals: [] });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]]!.boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Flood the squares the player reaches from `from` with `occupied` in the way. Returns the lowest reached square and the reached set. */
function reachFrom(
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  w: number,
): { low: number; seen: Uint8Array } {
  const seen = new Uint8Array(wall.length);
  const stack = [from];
  seen[from] = 1;
  let low = from;
  while (stack.length > 0) {
    const p = stack.pop()!;
    if (p < low) low = p;
    for (const d of DIRS) {
      const q = p + d.dy * w + d.dx;
      if (!wall[q] && !occupied[q] && !seen[q]) {
        seen[q] = 1;
        stack.push(q);
      }
    }
  }
  return { low, seen };
}

/** Box-move distances from each goal over open floor (a box steps onto adjacent floor squares). */
function goalDistances(
  wall: Uint8Array,
  goals: number[],
  w: number,
): number[][] {
  return goals.map((g) => {
    const dist = new Array<number>(wall.length).fill(Infinity);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const c = queue[qi]!;
      for (const d of DIRS) {
        const q = c + d.dy * w + d.dx;
        if (!wall[q] && dist[q] === Infinity) {
          dist[q] = dist[c]! + 1;
          queue.push(q);
        }
      }
    }
    return dist;
  });
}

/** Cheapest assignment of boxes to goals under the distance tables (exact permutations for few boxes, else the sum of each box's nearest goal). */
function assignmentHeuristic(boxes: number[], dists: number[][]): number {
  const n = boxes.length;
  if (n === 0) return 0;
  if (n > 5) {
    let sum = 0;
    for (const b of boxes) {
      let best = Infinity;
      for (const dist of dists) if (dist[b]! < best) best = dist[b]!;
      if (best === Infinity) return Infinity;
      sum += best;
    }
    return sum;
  }
  // Exact minimum over all bijections, by walking the permutations in fixed order.
  const perm = dists.map((_, i) => i);
  let best = Infinity;
  const walk = (k: number, acc: number): void => {
    if (acc >= best) return;
    if (k === n) {
      best = acc;
      return;
    }
    for (let i = k; i < n; i++) {
      [perm[k], perm[i]] = [perm[i]!, perm[k]!];
      const d = dists[perm[k]!]![boxes[k]!]!;
      if (d !== Infinity) walk(k + 1, acc + d);
      [perm[k], perm[i]] = [perm[i]!, perm[k]!];
    }
  };
  walk(0, 0);
  return best;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes holding a box off its goal. */
function frozenBlock(
  wall: Uint8Array,
  occupied: Uint8Array,
  goal: Uint8Array,
  t: number,
  w: number,
): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    if (!(wall[a] || occupied[a])) continue;
    if (!(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c])) continue;
    if (!(wall[d] || occupied[d])) continue;
    if (
      (occupied[a] && !goal[a]) ||
      (occupied[b] && !goal[b]) ||
      (occupied[c] && !goal[c]) ||
      (occupied[d] && !goal[d])
    ) {
      return true;
    }
  }
  return false;
}

/** A binary heap ordered by (f, h, key): smallest first, ties broken on the key so the order is fixed. */
class Heap {
  private items: { f: number; h: number; key: string; state: number }[] = [];
  get size(): number {
    return this.items.length;
  }
  private less(
    a: { f: number; h: number; key: string },
    b: { f: number; h: number; key: string },
  ): boolean {
    return (
      a.f < b.f ||
      (a.f === b.f && (a.h < b.h || (a.h === b.h && a.key < b.key)))
    );
  }
  push(e: { f: number; h: number; key: string; state: number }): void {
    let i = this.items.length;
    this.items.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(this.items[i]!, this.items[p]!)) break;
      [this.items[i], this.items[p]] = [this.items[p]!, this.items[i]!];
      i = p;
    }
  }
  pop(): { f: number; h: number; key: string; state: number } {
    const top = this.items[0]!;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= this.items.length) break;
        if (
          c + 1 < this.items.length &&
          this.less(this.items[c + 1]!, this.items[c]!)
        ) {
          c++;
        }
        if (!this.less(this.items[c]!, this.items[i]!)) break;
        [this.items[i], this.items[c]] = [this.items[c]!, this.items[i]!];
        i = c;
      }
    }
    return top;
  }
}

/**
 * The push-optimal moves solving one room (or a whole level) from `player`,
 * or null when the search gives up. `useHeuristic` false runs the same
 * search as a plain breadth-first search over pushes.
 */
function solvePushes(
  wall: Uint8Array,
  goals: number[],
  boxes0: number[],
  player0: number,
  w: number,
  useHeuristic: boolean,
): string | null {
  const n = wall.length;
  const goal = new Uint8Array(n);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(wall, goals, w);
  if (boxes0.some((b) => !live[b])) return null;
  const dists = goalDistances(wall, goals, w);
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);
  if (solved(boxes0)) return '';

  const occupied = new Uint8Array(n);
  const stateBoxes: number[][] = [boxes0.slice()];
  const statePlayer: number[] = [player0];
  const stateParent: number[] = [-1];
  const stateFrom: number[] = [-1]; // the box square the push started from
  const stateDir: number[] = [-1]; // the direction index of that push
  const stateG: number[] = [0];
  const bestG = new Map<string, number>();
  const keyOf = (bs: number[], low: number): string =>
    `${low}|${bs.join(',')}`;
  for (const b of boxes0) occupied[b] = 1;
  const startLow = reachFrom(wall, occupied, player0, w).low;
  for (const b of boxes0) occupied[b] = 0;
  bestG.set(keyOf(boxes0, startLow), 0);
  const h0 = useHeuristic ? assignmentHeuristic(boxes0, dists) : 0;
  if (h0 === Infinity) return null;
  const heap = new Heap();
  heap.push({ f: h0, h: h0, key: keyOf(boxes0, startLow), state: 0 });

  let expanded = 0;
  let found = -1;
  while (heap.size > 0 && expanded < MAX_EXPANSIONS) {
    const cur = heap.pop();
    const s = cur.state;
    if (bestG.get(cur.key) !== stateG[s]) continue;
    const bs = stateBoxes[s]!;
    if (solved(bs)) {
      found = s;
      break;
    }
    expanded++;
    const player = statePlayer[s]!;
    for (const b of bs) occupied[b] = 1;
    const { low, seen } = reachFrom(wall, occupied, player, w);
    void low;
    for (let bi = 0; bi < bs.length; bi++) {
      const b = bs[bi]!;
      for (let di = 0; di < 4; di++) {
        const d = DIRS[di]!;
        const step = d.dy * w + d.dx;
        const t = b + step;
        const pushFrom = b - step;
        if (seen[pushFrom] !== 1) continue; // the player cannot reach the push square
        if (wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(wall, occupied, goal, t, w)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = bs.slice();
        next[bi] = t;
        next.sort((x, y) => x - y);
        const nextLow = reachFrom(wall, occupied, b, w).low;
        occupied[t] = 0;
        occupied[b] = 1;
        const key = keyOf(next, nextLow);
        const g2 = stateG[s]! + 1;
        const prevG = bestG.get(key);
        if (prevG !== undefined && prevG <= g2) continue;
        const h2 = useHeuristic ? assignmentHeuristic(next, dists) : 0;
        if (h2 === Infinity) continue;
        bestG.set(key, g2);
        const idx = stateBoxes.length;
        stateBoxes.push(next);
        statePlayer.push(b);
        stateParent.push(s);
        stateFrom.push(b);
        stateDir.push(di);
        stateG.push(g2);
        heap.push({ f: g2 + h2, h: h2, key, state: idx });
        if (solved(next)) {
          found = idx;
          break;
        }
      }
      if (found >= 0) break;
    }
    for (const b of bs) occupied[b] = 0;
    if (found >= 0) break;
  }
  if (found < 0) return null;

  // The pushes, first to last, then the walks between them.
  const chain: number[] = [];
  for (let s = found; s > 0; s = stateParent[s]!) chain.push(s);
  chain.reverse();
  let moves = '';
  let player = player0;
  let boxes = boxes0.slice();
  for (const s of chain) {
    const from = stateFrom[s]!;
    const di = stateDir[s]!;
    const d = DIRS[di]!;
    const step = d.dy * w + d.dx;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(wall, occupied, player, from - step, w);
    for (const b of boxes) occupied[b] = 0;
    moves += d.ch;
    player = from;
    const at = boxes.indexOf(from);
    boxes[at] = from + step;
    boxes.sort((a, b) => a - b);
  }
  return moves;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (first direction first on ties). */
function walkTo(
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  to: number,
  w: number,
): string {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length).fill('');
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const d of DIRS) {
      const q = p + d.dy * w + d.dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d.ch;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return '';
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The player's square after playing `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/** Solve one level's text into its moves, room by room; '' when no room search lands. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms === null) {
    // No room split: search the whole level as one problem.
    return (
      solvePushes(level.wall, level.goals, level.boxes, level.player, level.w, true) ??
      solvePushes(level.wall, level.goals, level.boxes, level.player, level.w, false) ??
      ''
    );
  }
  let player = level.player;
  let moves = '';
  const done: boolean[] = rooms.map(() => false);
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri]!;
    // The other rooms' boxes stand as walls (on their goals once solved).
    const wall = level.wall.slice();
    for (let oj = 0; oj < rooms.length; oj++) {
      if (oj === ri) continue;
      const other = rooms[oj]!;
      for (const b of done[oj] ? other.goals : other.boxes) wall[b] = 1;
    }
    const solved =
      solvePushes(wall, room.goals, room.boxes, player, level.w, true) ??
      solvePushes(wall, room.goals, room.boxes, player, level.w, false);
    if (solved === null) return '';
    moves += solved;
    player = endOf(level.w, player, solved);
    done[ri] = true;
  }
  return moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
