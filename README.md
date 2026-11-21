# Push-Optimal Sokoban Solver

[![Bounty](https://img.shields.io/badge/bounty-sokoban--solver--01--run--20261121-blue)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A push-optimal Sokoban solver for the [make.fun bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121):
one program answers 5 freshly drawn instances per run, pushing every box
onto a goal in as few pushes as possible.

**Practice score: 1,000,000 / 1,000,000** — every practice instance solved in
exactly its push-optimal count P* (i001: 13, i002: 16, i003: 29, i004: 47,
i005: 60), in ~0.3 s for the whole set. The house baseline
(plain-astar 1.0.0) scores 200,000 on the same practice set.

## How it works

A level is a one-square-wide hallway (the player's row) with 1–4 rooms off
it, one door each. A box pushed out of a door can never come back, so the
rooms are independent problems and the level optimum is the sum of the
rooms' optima.

1. **Split into rooms.** Live squares are found by pulling boxes back from
   the goals; the dead floor squares of the hallway row are cut out, and
   each remaining connected part holding boxes is a room.
2. **Solve each room with A\* over pushes.** A state is the sorted box
   squares plus the player's reachable region (named by its lowest square).
   The heuristic is the minimum-cost assignment of boxes to goals under
   box-move distances — admissible, so the first solved state settled is
   push-optimal for the room.
3. **Prune deadlocks.** A box on a dead square and a frozen 2×2 block of
   walls and boxes holding a box off its goal are both discarded; neither
   prunes a solvable state, so optimality stands.
4. **Stitch the walks together.** The player walks the hallway between
   rooms (other rooms' boxes stand as walls meanwhile).

The search budget is a count of expansions, never the wall clock, and ties
break on the state's key — so two runs write byte-identical answers. If a
room's A\* exhausts its budget it is retried as a plain breadth-first
search over pushes; if that also gives up, the instance is answered empty
(valid format, 0 points) rather than risking an illegal move.

## Run it

```sh
node main.ts            # reads /input/<id>/level.txt, writes /output/<id>/solution.txt
```

Node 22 or later (type-stripping runs `main.ts` as it is). No dependencies,
no network, no WebAssembly, no native code.

## License

MIT — see [LICENSE](LICENSE).
