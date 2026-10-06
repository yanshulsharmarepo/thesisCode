#!/usr/bin/env node
/**
 * Input generator for FRESH (Node.js).
 *   node generate_inputs.js                                   -> writes inputs/*.json
 *   node generate_inputs.js --n 40 --m 4 --uf 0.8 --out inputs/my.json [--seed 1 --sigma 0.3]
 *
 * Job: {id, benchmark, period(=deadline), priority, c:[c^i1..c^im], r:[r^i1..r^im]}, c^ij = c^i / r^ij
 * UF = sum_i avg_j(u^ij) / m  (Section 7.1). Utilisations ~ N(0.4, sigma), scaled to hit UF.
 */
const fs = require("fs");
const BENCH = ["x264", "Canneal", "Dedup", "Freq", "Body", "Swap", "Stream", "Fluid"]; // Table 4

function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function paperExample() {
  const c = [[5,35,20,50],[25,10,20,15],[45,30,15,60],[45,105,135,60],
             [30,35,25,20],[25,20,40,55],[150,90,75,120],[150,180,105,90]];
  const d = [100,100,150,300,100,100,300,300];
  return { description: "Table 2 of the FRESH paper", m: 4,
    jobs: d.map((p, i) => ({ id: `J${i + 1}`, benchmark: null, period: p, priority: d.length - i,
                             c: c[i], r: [1, 1, 1, 1] })) };
}
function randomSet(n = 40, m = 4, uf = 0.8, sigma = 0.3, seed = 1, mu = 0.4) {
  const rng = rngFrom(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  const periods = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  let d, rates, cij, ok = false;
  for (let tries = 0; tries < 1000 && !ok; tries++) {
    d = Array.from({ length: n }, () => periods[Math.floor(rng() * periods.length)]);
    rates = Array.from({ length: n }, () => Array.from({ length: m }, () => 0.5 + rng()));
    const u = Array.from({ length: n }, () => Math.max(0.05, mu + sigma * gauss()));
    const base = u.map((x, i) => x * d[i]);
    const avgInv = rates.map((r) => r.reduce((s, x) => s + 1 / x, 0) / m);
    const cur = base.reduce((s, b, i) => s + (b * avgInv[i]) / d[i], 0) / m;
    const s = uf / cur;
    cij = base.map((b, i) => rates[i].map((r) => (b * s) / r));
    ok = cij.every((row, i) => row.every((c) => c / d[i] <= 0.95));   // each u^ij <= 0.95
  }
  if (!ok) throw new Error("could not generate a feasible set; lower UF or sigma");
  const prios = Array.from({ length: n }, (_, i) => i + 1);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [prios[i], prios[j]] = [prios[j], prios[i]]; }
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const jobs = d.map((p, i) => ({ id: `J${i + 1}`, benchmark: BENCH[Math.floor(rng() * BENCH.length)],
    period: p, priority: prios[i], c: cij[i].map(r3), r: rates[i].map(r3) }));
  const actual = jobs.reduce((s, j) => s + j.c.reduce((a, c) => a + c / j.period, 0) / m, 0) / m;
  return { description: `random n=${n} m=${m} UF=${uf} (actual ${actual.toFixed(3)}) seed=${seed}`, n, m, uf, jobs };
}
const write = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 1));

const a = process.argv.slice(2), o = {};
for (let i = 0; i < a.length; i += 2) o[a[i].slice(2)] = a[i + 1];
fs.mkdirSync("inputs", { recursive: true });
if (o.n) {
  write(o.out || "inputs/custom.json", randomSet(+o.n, +(o.m || 4), +(o.uf || 0.8), +(o.sigma || 0.3), +(o.seed || 1)));
} else {
  write("inputs/example_paper.json", paperExample());
  for (const uf of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) write(`inputs/random_uf${uf.toFixed(1)}_n40_m4.json`, randomSet(40, 4, uf));  // Fig.5
  for (const m of [2, 4, 6, 8]) write(`inputs/random_uf0.8_n40_m${m}.json`, randomSet(40, m, 0.8));                 // Fig.6
  for (const n of [10, 20, 30, 40, 50, 60]) write(`inputs/random_uf0.8_n${n}_m4.json`, randomSet(n, 4, 0.8));       // Fig.7
  console.log("inputs written:", fs.readdirSync("inputs").length);
}
