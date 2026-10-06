#!/usr/bin/env node

const fs = require("fs");
const EPS = 1e-9;

function makeRng(seed) {
  let a = (seed >>> 0) + 0x6d2b79f5;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sample(arr, k, rng) {            // k distinct elements (partial Fisher-Yates)
  const a = arr.slice();
  for (let i = 0; i < Math.min(k, a.length); i++) {
    const j = i + Math.floor(rng() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(k, a.length));
}

function makePower(o = {}) {
  const { ceff = 0.5e-9, vdd = 1.0, mu = 3.0e9, isubn = 0.2, vbs = 0.3, ij = 0.1, lg = 1.0,
          pSleep = 0.05, eSwitch = 0.23, breakEven = 5, slotMs = 1 } = o;
  const dynamic = ceff * vdd ** 2 * mu;
  const stat = (vdd * isubn + Math.abs(vbs) * ij) * lg;
  return { active: dynamic + stat, idle: stat, sleep: pSleep, eSwitch, breakEven, slotMs };
}

const windowLength = (rem) => Math.min(...rem);
function quotas(jobs, W) {
  const q = new Map();
  jobs.forEach((job, i) => job.c.forEach((c, j) => q.set(`${i},${j}`, (c / job.period) * W)));
  return q;
}
const cmpNode = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function allot(jobs, W, mode = "general", strict = false) {
  const n = jobs.length, m = jobs[0].c.length;
  const q = quotas(jobs, W), Q = (i, j) => q.get(`${i},${j}`);
  const t = new Array(m).fill(0);
  const S = new Map();
  const add = (i, j, s, e, kind) => {
    const k = `${i},${j}`;
    if (!S.has(k)) S.set(k, []);
    S.get(k).push({ s, e, kind });
  };
  const firstEnd = {}, migrated = new Set(), hasFirst = new Set(), hasBackup = new Set();

  const Yfc = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) Yfc.push([Q(i, j), i, j]);
  Yfc.sort(cmpNode);
  const Ysc = new Set(Yfc.map(([, i, j]) => `${i},${j}`));

  let Y1 = [];
  for (const [qq, i, j] of Yfc) {
    if (hasFirst.has(i)) continue;
    if (qq <= W - t[j] + EPS) {
      add(i, j, t[j], t[j] + qq, "P");
      firstEnd[i] = t[j] + qq; t[j] += qq;
      hasFirst.add(i); Ysc.delete(`${i},${j}`);
      Y1 = Y1.filter((x) => x[1] !== i);
    } else Y1.push([qq, i, j]);
  }

  const order = [];
  for (const [, i] of Y1) if (!order.includes(i)) order.push(i);
  for (const i of order) {
    const nodes = [];
    for (let j = 0; j < m; j++) nodes.push([Q(i, j), i, j]);
    nodes.sort(cmpNode);
    let frac = 1, prevEnd = 0; const pieces = [], saved = t.slice();
    for (const [qq, , j] of nodes) {
      const start = Math.max(t[j], prevEnd);      // never run in parallel with itself
      const avail = W - start;
      if (avail <= EPS) continue;
      const take = Math.min(frac * qq, avail);
      pieces.push([j, start, start + take]);
      t[j] = start + take; prevEnd = start + take; frac -= take / qq;
      if (frac <= EPS) break;
    }
    if (frac > EPS) saved.forEach((v, j) => (t[j] = v));   // roll back
    else {
      pieces.forEach(([j, s, e]) => add(i, j, s, e, "P"));
      hasFirst.add(i); migrated.add(i); firstEnd[i] = prevEnd;
    }
    for (let j = 0; j < m; j++) Ysc.delete(`${i},${j}`);  // no second copy for migrating jobs
  }
  for (let i = 0; i < n; i++)
    if (!hasFirst.has(i)) for (let j = 0; j < m; j++) Ysc.delete(`${i},${j}`);

  const prio = (i) => -(jobs[i].priority || 0);
  const nodes2 = [...Ysc].map((k) => k.split(",").map(Number));   // [i,j]
  nodes2.sort(mode === "general"
    ? (a, b) => Q(...a) - Q(...b) || a[0] - b[0] || a[1] - b[1]
    : (a, b) => prio(a[0]) - prio(b[0]) || Q(...a) - Q(...b) || a[0] - b[0] || a[1] - b[1]);
  for (const [i, j] of nodes2) {
    if (hasBackup.has(i)) continue;
    const start = strict ? Math.max(t[j], firstEnd[i]) : t[j];
    if (Q(i, j) <= W - start + EPS) {
      add(i, j, start, start + Q(i, j), "B");
      t[j] = start + Q(i, j); hasBackup.add(i);
    }
  }
  return { S, hasFirst, hasBackup, migrated };
}

function simulateWindow({ S, hasFirst, hasBackup }, m, W, nFaults, rng, pw) {
  const scheduled = [...hasFirst].sort((a, b) => a - b);
  const faulty = new Set(sample(scheduled, nFaults, rng));
  const busy = Array.from({ length: m }, () => []);
  for (const [k, ivs] of S) {
    const [i, j] = k.split(",").map(Number);
    for (const { s, e, kind } of ivs)
      if (kind === "P" || faulty.has(i)) busy[j].push([s, e]);   // backup runs only on a fault
  }
  let ok = 0;
  for (const i of scheduled) if (!faulty.has(i) || hasBackup.has(i)) ok++;
  let energy = 0;
  for (let j = 0; j < m; j++) {
    const ivs = busy[j].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    energy += ivs.reduce((s, [a, b]) => s + b - a, 0) * pw.active * pw.slotMs;
    const gaps = []; let cur = 0;
    for (const [s, e] of ivs) { if (s > cur + EPS) gaps.push(s - cur); cur = Math.max(cur, e); }
    if (W > cur + EPS) gaps.push(W - cur);
    for (const g of gaps)                                         // DPM with break-even time
      energy += g >= pw.breakEven ? g * pw.sleep * pw.slotMs + pw.eSwitch : g * pw.idle * pw.slotMs;
  }
  return { ok, energy, baseline: m * W * pw.active * pw.slotMs };
}

function run(jobs, { mode = "general", horizon = 100000, maxWindows = null, nFaults = 10,
                     seed = 0, strict = false, verbose = false, power } = {}) {
  const rng = makeRng(seed), pw = power || makePower();
  const n = jobs.length, m = jobs[0].c.length;
  let rem = jobs.map((j) => j.period), time = 0, k = 0;
  const tot = { jobs: 0, backup: 0, ok: 0, E: 0, Eb: 0, migr: 0, nofirst: 0 };
  while (time < horizon - EPS && (maxWindows === null || k < maxWindows)) {
    const W = windowLength(rem);
    const res = allot(jobs, W, mode, strict);
    const sim = simulateWindow(res, m, W, nFaults, rng, pw);
    tot.jobs += n; tot.backup += res.hasBackup.size; tot.ok += sim.ok;
    tot.E += sim.energy; tot.Eb += sim.baseline;
    tot.migr += res.migrated.size; tot.nofirst += n - res.hasFirst.size;
    k++;
    if (verbose) {
      console.log(`\n=== Window W${k}: length ${W}, remaining deadlines [${rem.join(", ")}]`);
      printSchedule(res.S, n, m);
    }
    time += W;
    rem = rem.map((r, i) => (r - W <= EPS ? jobs[i].period : r - W));
  }
  return { windows: k, SCopy: (100 * tot.backup) / tot.jobs, STot: (100 * tot.ok) / tot.jobs,
           ERed: 100 * (1 - tot.E / tot.Eb), migrated_jobs: tot.migr,
           jobs_without_first_copy: tot.nofirst };
}

function printSchedule(S, n, m) {
  const g = (x) => +x.toFixed(3);
  console.log("      " + Array.from({ length: m }, (_, j) => `P${j + 1}`.padStart(22)).join(""));
  for (let i = 0; i < n; i++) {
    let row = "";
    for (let j = 0; j < m; j++) {
      const iv = S.get(`${i},${j}`);
      row += (iv ? iv.map(({ s, e, kind }) => `<${g(s)},${g(e)}>${kind}`).join(" ") : "-").padStart(22);
    }
    console.log(`J${i + 1}`.padEnd(6) + row);
  }
}

const load = (path) => JSON.parse(fs.readFileSync(path, "utf8")).jobs;
module.exports = { allot, run, quotas, windowLength, makePower, load };

if (require.main === module) {
  const args = process.argv.slice(2), opt = {}, pos = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) { pos.push(args[i]); continue; }
    const key = args[i].slice(2);
    if (["strict", "verbose", "compare"].includes(key)) opt[key] = true;
    else opt[key] = args[++i];
  }
  if (!pos.length) { console.error("usage: node fresh.js <input.json> [options]"); process.exit(1); }
  const jobs = load(pos[0]);
  const runs = +(opt.runs || 1);
  for (const mode of opt.compare ? ["general", "priority"] : [opt.mode || "general"]) {
    const rs = [];
    for (let r = 0; r < runs; r++)
      rs.push(run(jobs, { mode, horizon: +(opt.horizon || 100000),
        maxWindows: opt.windows ? +opt.windows : null, nFaults: +(opt.faults || 10),
        seed: +(opt.seed || 0) + r, strict: !!opt.strict, verbose: !!opt.verbose && r === 0 }));
    const avg = Object.fromEntries(Object.keys(rs[0]).map((k) => [k, rs.reduce((s, x) => s + x[k], 0) / runs]));
    console.log(`\nFRESH-${mode.toUpperCase()}: ` +
      Object.entries(avg).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(", "));
  }
}
