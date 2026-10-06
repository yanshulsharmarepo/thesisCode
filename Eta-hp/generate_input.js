#!/usr/bin/env node
/**
 * Generate an ETA-HP input instance (task set + heterogeneous platform).
 * Setup follows Sect. 6 of the paper: 4 out-of-order (3.0 GHz) + 4 in-order
 * (1.8 GHz) cores, tasks from the PARSEC programs of Table 4, ambient 25 C,
 * UF = sum_i avg_j(u_ij) / |Pi|, steady-state temperature perturbed by 0..10 %.
 *
 * Usage: node generate_input.js --uf 0.8 --tasks 20 --seed 1 --out input.json
 */
const fs = require("fs");

const PARSEC_TEMP = {
  Bodytrack: 85, Canneal: 80, Dedup: 91, Fluidanimate: 81,
  Freqmine: 84, Streamcluster: 68, Swaptions: 76, x264: 85,
};
const PERIODS = [200, 250, 400, 500, 1000]; // time-slots (1 slot = 1 ms)
const OOO_FREQS = [0.6, 0.7, 0.8, 0.9, 1.0]; // 1800..3000 MHz of 3000
const IO_FREQS = [0.5, 0.6667, 0.8333, 1.0]; // 900..1800 MHz of 1800

// small seedable PRNG (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function build(o) {
  const rand = rng(o.seed);
  const uniform = (a, b) => a + (b - a) * rand();
  const choice = (arr) => arr[Math.floor(rand() * arr.length)];
  const r4 = (x) => Math.round(x * 1e4) / 1e4;

  const cores = [];
  for (let k = 0; k < o.ooo; k++)
    cores.push({ id: cores.length, type: "out-of-order", fmax_mhz: 3000, freqs: OOO_FREQS });
  for (let k = 0; k < o.io; k++)
    cores.push({ id: cores.length, type: "in-order", fmax_mhz: 1800, freqs: IO_FREQS });
  const m = cores.length;

  // raw utilisations: OoO fast, in-order slower (higher u)
  const raw = [];
  for (let i = 0; i < o.tasks; i++) {
    const base = uniform(0.05, 0.6), ratio = uniform(1.3, 2.2);
    raw.push(cores.map((c) => (c.type === "out-of-order" ? base : base * ratio)));
  }
  // scale to requested UF (clip individual u at 0.95, iterate)
  const ufOf = (u) => u.reduce((a, r) => a + r.reduce((x, y) => x + y, 0) / m, 0) / m;
  let k = 1, u = raw;
  for (let it = 0; it < 50; it++) {
    u = raw.map((row) => row.map((x) => Math.min(0.95, x * k)));
    const uf = ufOf(u);
    if (Math.abs(uf - o.uf) < 1e-4) break;
    k *= o.uf / uf;
  }
  u = u.map((row) => row.map(r4));

  const names = Object.keys(PARSEC_TEMP);
  const tasks = [];
  for (let i = 0; i < o.tasks; i++) {
    const prog = o.cycle ? names[i % names.length] : choice(names);
    const tss = cores.map((c) => {
      const base = PARSEC_TEMP[prog] * (c.type === "out-of-order" ? 1.0 : 0.85);
      const alpha = uniform(0, 0.1);
      return Math.round(base * (1 + (rand() < 0.5 ? -1 : 1) * alpha) * 100) / 100;
    });
    tasks.push({ id: i, name: `${prog}_${i}`, period: choice(PERIODS), u: u[i], tss });
  }
  return {
    meta: { uf_target: o.uf, seed: o.seed, uf_actual: r4(ufOf(tasks.map((t) => t.u))) },
    thermal: { ambient: 25.0, B: 0.005, gamma: 0.55 },
    platform: cores,
    tasks,
  };
}

function main() {
  const o = { uf: 0.8, tasks: 20, ooo: 4, io: 4, seed: 1, cycle: false, out: "input.json" };
  const argv = process.argv.slice(2);
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === "--cycle") o.cycle = true;
    else if (a === "--out") o.out = argv[++k];
    else if (a === "--uf") o.uf = parseFloat(argv[++k]);
    else if (["--tasks", "--ooo", "--io", "--seed"].includes(a)) o[a.slice(2)] = parseInt(argv[++k], 10);
  }
  const inst = build(o);
  fs.writeFileSync(o.out, JSON.stringify(inst, null, 2));
  console.log(`wrote ${o.out}: ${o.tasks} tasks, ${o.ooo + o.io} cores, UF=${inst.meta.uf_actual}`);
}

if (require.main === module) main();
module.exports = { build };
