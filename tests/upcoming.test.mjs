// Run with: node tests/upcoming.test.mjs
import assert from "node:assert/strict";
import { upcomingDays, nextUpcoming, isOneOff, addDays } from "../src/dayview.js";

const T = "2026-09-28"; // a Monday

// A fake dayView: each date maps to { deadlines, blocks }.
const days = {
  [T]: {
    deadlines: [{ id: "t0", name: "Pay rent", imp: 2 }],
    blocks: [{ id: "b0", title: "Dentist" }], // today's block - already in the plan
  },
  [addDays(T, 1)]: {
    deadlines: [],
    blocks: [
      { id: "r1", title: "Gym", src: "h1", tracked: true }, // routine, placed by placeFixed
      { id: "b1", title: "Coffee with Sam" },
      { id: "b2", title: "Done thing", done: true },
    ],
  },
  [addDays(T, 3)]: {
    deadlines: [
      { id: "t1", name: "Reading notes", imp: 1 },
      { id: "t2", name: "Fintech exam", imp: 3 },
    ],
    blocks: [{ id: "r2", title: "Laundry", derived: true }],
  },
  [addDays(T, 5)]: { deadlines: [], blocks: [{ id: "r3", title: "Standup", derived: true, fixed: true }] },
  [addDays(T, 14)]: { deadlines: [{ id: "t3", name: "Edge of window" }], blocks: [] },
  [addDays(T, 15)]: { deadlines: [{ id: "t4", name: "Past window" }], blocks: [] },
};
const viewOf = (k) => days[k] || { deadlines: [], blocks: [] };

const g = upcomingDays(T, 14, viewOf);

// Empty days and routine-only days are dropped entirely.
assert.deepEqual(g.map((x) => x.rel), [0, 1, 3, 14]);

// Today: the deadline, but not today's block.
assert.deepEqual(g[0].deadlines.map((t) => t.id), ["t0"]);
assert.deepEqual(g[0].blocks, []);

// Tomorrow: the one-off only - no routine, nothing already done.
assert.deepEqual(g[1].blocks.map((b) => b.id), ["b1"]);

// High importance leads within a day.
assert.deepEqual(g[2].deadlines.map((t) => t.id), ["t2", "t1"]);

// Nearest item wins the summary, regardless of importance.
const n = nextUpcoming(g);
assert.equal(n.title, "Pay rent");
assert.equal(n.rel, 0);
assert.equal(n.total, 5);

// A day with only a block summarises by block title.
const blockOnly = (k) => (k === T ? { deadlines: [], blocks: [] } : viewOf(k));
assert.equal(nextUpcoming(upcomingDays(T, 1, blockOnly)).title, "Coffee with Sam");
assert.equal(nextUpcoming([]), null);

assert.equal(isOneOff({ title: "x" }), true);
assert.equal(isOneOff({ title: "x", src: "c1" }), false);

console.log("upcoming: all passed");
