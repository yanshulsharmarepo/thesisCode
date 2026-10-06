#!/usr/bin/env node
/**
 * ETA-HP: energy and temperature-aware real-time scheduler for heterogeneous
 * platforms (Sharma, Chakraborty, Moulik - J. Supercomputing 2022). Node.js port.
 *
 * Stages (per frame):
 *   1. Deadline partitioning       |R_k| = min(rp_1..rp_n)            (Eq. 7)
 *   2. Task-to-core allocation     TENTATIVE-SCHEDULE, ALLOCATE-FIXED,
 *                                  ALLOCATE-MIGRATE                   (Alg. 2-4)
 *   3. Temperature-aware ordering  TA-ALLOCATE (hot/cold alternation) (Alg. 5)
 *   4. Energy-aware DVFS           EA-ALLOCATE, F_opt                 (Alg. 6, Eq. 9)
 *
 * Usage:
 *   node eta_hp.js input.json
 *   node eta_hp.js input.json --compare         (none / TA / EA / TA+EA)
 *   node eta_hp.js input.json --dump-frames 2
 *   node eta_hp.js input.json --slots 100000 --out metrics.json
 */
const fs = require("fs");

const EPS = 1e-9;
const CS_DELAY_US = 5.24; // context-switch delay (paper, ref [31])

// ---------------------------------------------------------------------------
// Frame scheduling
// ---------------------------------------------------------------------------
function scheduleFrame(inst, R, useTA = true, useEA = true) {
  const { tasks, platform: cores } = inst;
  const n = tasks.length, m = cores.length;
  const u = tasks.map((t) => t.u);

  // ---- Algorithm 2: shares (Eq. 8) and sorted list LT1 --------------------
  const shr = tasks.map((_, i) =>
    cores.map((_, j) => Math.ceil(u[i][j] * R - EPS))
  );
  const LT1 = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) LT1.push([shr[i][j], i, j]);
  LT1.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

  // ---- Algorithm 3: ALLOCATE-FIXED ----------------------------------------
  const fixedUsed = new Array(m).fill(0);
  const fixed = Array.from({ length: m }, () => []); // [task, share]
  const done = new Set();
  let LT2 = [];
  for (const [s, i, j] of LT1) {
    if (done.has(i)) continue;
    if (fixedUsed[j] + s <= R + EPS) {
      fixed[j].push([i, s]);
      fixedUsed[j] += s;
      done.add(i);
    } else LT2.push([s, i, j]);
  }
  LT2 = LT2.filter((e) => !done.has(e[1]));

  // ---- Algorithm 4: ALLOCATE-MIGRATE --------------------------------------
  const mig = Array.from({ length: m }, () => []); // [task, start, end]
  const cursor = new Array(m).fill(0); // end of last migrating segment
  const migUsed = new Array(m).fill(0);
  const rejected = [];
  const order = [];
  for (const [, i] of LT2) if (!order.includes(i)) order.push(i);

  for (const i of order) {
    const LT3 = LT2.filter((e) => e[1] === i)
      .map((e) => [e[0], e[2]])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]); // favourite core first
    let ns = 0, prevJ = null, prevEnd = 0;
    const placed = [];
    for (const [s, j] of LT3) {
      const cand = prevJ === null ? s : (ns * u[i][j]) / u[i][prevJ];
      const rc = R - fixedUsed[j] - migUsed[j];
      const start = Math.max(cursor[j], prevEnd); // never parallel with itself
      const cap = Math.min(rc, R - start);
      if (cap <= EPS) continue;
      let dur;
      if (cand > cap + EPS) { dur = cap; ns = cand - cap; }
      else { dur = cand; ns = 0; }
      placed.push([j, start, start + dur]);
      cursor[j] = start + dur;
      prevEnd = start + dur;
      prevJ = j;
      migUsed[j] += dur;
      if (ns <= EPS) break;
    }
    if (prevJ === null || ns > EPS) {
      // cannot be scheduled -> roll back
      for (const [j, a, b] of placed) migUsed[j] -= b - a;
      rejected.push(i);
      for (const j of new Set(placed.map((p) => p[0])))
        cursor[j] = Math.max(0, ...mig[j].map((x) => x[2]));
    } else {
      for (const [j, a, b] of placed) mig[j].push([i, a, b]);
    }
  }
  const accepted = [];
  for (let i = 0; i < n; i++) if (!rejected.includes(i)) accepted.push(i);

  // ---- Algorithm 6 (Eq. 9): DVFS frequency per core -----------------------
  const freq = new Array(m).fill(1.0);
  let energy = 0, baseEnergy = 0;
  for (let j = 0; j < m; j++) {
    const F = fixedUsed[j];
    const M = mig[j].reduce((acc, x) => acc + (x[2] - x[1]), 0);
    const free = R - M;
    const fopt = free > EPS ? F / free : 1.0;
    if (useEA) {
      const levels = [...cores[j].freqs].sort((a, b) => a - b);
      const hit = levels.find((f) => f + EPS >= fopt);
      freq[j] = hit === undefined ? levels[levels.length - 1] : hit;
      if (F === 0) freq[j] = levels[0];
    }
    energy += F * freq[j] ** 2 + M; // P = c f^3, time = share / f
    baseEnergy += F + M;
  }

  // ---- Algorithm 5: TA-ALLOCATE (hot/cold alternation) + layout -----------
  const segments = [];
  for (let j = 0; j < m; j++) {
    let LT4 = fixed[j].slice();
    if (useTA && LT4.length) {
      LT4.sort((a, b) => tasks[b[0]].tss[j] - tasks[a[0]].tss[j]); // hottest first
      const LT5 = [];
      let lo = 0, hi = LT4.length - 1, hot = true;
      while (lo <= hi) {
        LT5.push(hot ? LT4[lo++] : LT4[hi--]);
        hot = !hot;
      }
      LT4 = LT5;
    }
    // free intervals = complement of migrating segments
    const freeIv = [];
    let t = 0;
    for (const [, a, b] of mig[j].slice().sort((x, y) => x[1] - y[1])) {
      if (a > t + EPS) freeIv.push([t, a]);
      t = Math.max(t, b);
    }
    if (t < R - EPS) freeIv.push([t, R]);

    const segs = mig[j].map(([i, a, b]) => [i, a, b, 1.0]); // migrating at fmax
    let k = 0;
    for (const [i, s] of LT4) {
      let need = s / freq[j];
      while (need > EPS && k < freeIv.length) {
        const [a, b] = freeIv[k];
        const use = Math.min(need, b - a);
        segs.push([i, a, a + use, freq[j]]);
        freeIv[k][0] = a + use;
        need -= use;
        if (freeIv[k][1] - freeIv[k][0] <= EPS) k++;
      }
    }
    segs.sort((x, y) => x[1] - y[1]);
    segments.push(segs);
  }

  return { R, segments, freq, fixed, migrating: mig, accepted, rejected, energy, baseEnergy };
}

// ---------------------------------------------------------------------------
// Thermal model (Eq. 5)
// ---------------------------------------------------------------------------
// Eq. 6 taken literally gives negative temperatures for beta in [-0.05, 0];
// we use  Tss(f) = Tamb + (Tss_max - Tamb) * f^gamma  (gamma fitted to Fig. 1).
const steadyTemp = (tssMax, f, th) =>
  th.ambient + (tssMax - th.ambient) * Math.pow(f, th.gamma);
const advanceTemp = (T0, Tss, dt, B) => Tss + (T0 - Tss) * Math.exp(-B * dt);

function frameTemperatures(inst, fr, T) {
  const th = inst.thermal, tasks = inst.tasks;
  let peak = 0;
  fr.segments.forEach((segs, j) => {
    let t = 0;
    for (const [i, a, b, f] of [...segs, [null, fr.R, fr.R, 1.0]]) {
      if (a > t + EPS) T[j] = advanceTemp(T[j], th.ambient, a - t, th.B); // idle
      if (i !== null && b > a) {
        T[j] = advanceTemp(T[j], steadyTemp(tasks[i].tss[j], f, th), b - a, th.B);
        peak = Math.max(peak, T[j]);
      }
      t = Math.max(t, b);
    }
  });
  return peak;
}

// ---------------------------------------------------------------------------
// Simulation driver (Algorithm 1)
// ---------------------------------------------------------------------------
function simulate(inst, slots = 100000, useTA = true, useEA = true, dump = 0) {
  const { tasks } = inst;
  const n = tasks.length, m = inst.platform.length;
  let rp = tasks.map((t) => t.period);
  const T = new Array(m).fill(inst.thermal.ambient);
  let now = 0, frames = 0, okTotal = 0, taskTotal = 0;
  let eAct = 0, eBase = 0, tempSum = 0, peak = 0, cs = 0;

  while (now < slots) {
    const R = Math.min(...rp); // deadline partitioning
    const fr = scheduleFrame(inst, R, useTA, useEA);
    peak = Math.max(peak, frameTemperatures(inst, fr, T));
    tempSum += T.reduce((a, b) => a + b, 0) / m;
    okTotal += fr.accepted.length;
    taskTotal += n;
    eAct += fr.energy;
    eBase += fr.baseEnergy;
    cs += fr.segments.reduce((a, s) => a + s.length, 0);
    if (frames < dump) printFrame(inst, fr, now, frames);
    frames++;
    now += R;
    rp = rp.map((r, i) => (r - R <= 0 ? tasks[i].period : r - R));
  }
  return {
    frames,
    "SRat_%": (100 * okTotal) / taskTotal,
    ATOC_C: tempSum / frames,
    PeakTemp_C: peak,
    NEC: eBase ? eAct / eBase : 0,
    CSO_us_per_slot: (cs * CS_DELAY_US) / now,
  };
}

function printFrame(inst, fr, start, k) {
  console.log(`\n=== Frame ${k}  [t=${start}, len=${fr.R}]  rejected=[${fr.rejected}] ===`);
  fr.segments.forEach((segs, j) => {
    console.log(` core ${j} (${inst.platform[j].type}, f=${fr.freq[j].toFixed(3)})`);
    for (const [i, a, b] of segs) {
      const tag = fr.migrating[j].some((x) => x[0] === i) ? "MIG" : "fix";
      console.log(`    task ${String(i).padStart(2)} ${tag}  [${a.toFixed(2).padStart(8)}, ${b.toFixed(2).padStart(8)})`);
    }
  });
}

// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0].startsWith("--")) {
    console.error("usage: node eta_hp.js input.json [--slots N] [--compare] [--dump-frames N] [--out file]");
    process.exit(1);
  }
  const opt = { slots: 100000, compare: false, dump: 0, out: null };
  for (let k = 1; k < argv.length; k++) {
    if (argv[k] === "--slots") opt.slots = parseInt(argv[++k], 10);
    else if (argv[k] === "--compare") opt.compare = true;
    else if (argv[k] === "--dump-frames") opt.dump = parseInt(argv[++k], 10);
    else if (argv[k] === "--out") opt.out = argv[++k];
  }
  const inst = JSON.parse(fs.readFileSync(argv[0], "utf8"));
  const modes = opt.compare
    ? [["no TA, no EA", false, false], ["TA only", true, false],
       ["EA only", false, true], ["ETA-HP (TA+EA)", true, true]]
    : [["ETA-HP (TA+EA)", true, true]];

  const results = {};
  const pad = (s, w) => String(s).padStart(w);
  console.log("mode".padEnd(18) + pad("frames", 7) + pad("SRat %", 9) + pad("ATOC C", 9) +
    pad("Peak C", 9) + pad("NEC", 8) + pad("CSO us/slot", 13));
  for (const [name, ta, ea] of modes) {
    const r = simulate(inst, opt.slots, ta, ea, name.startsWith("ETA") ? opt.dump : 0);
    results[name] = r;
    console.log(name.padEnd(18) + pad(r.frames, 7) + pad(r["SRat_%"].toFixed(2), 9) +
      pad(r.ATOC_C.toFixed(2), 9) + pad(r.PeakTemp_C.toFixed(2), 9) +
      pad(r.NEC.toFixed(3), 8) + pad(r.CSO_us_per_slot.toFixed(5), 13));
  }
  if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(results, null, 2));
}

if (require.main === module) main();
module.exports = { scheduleFrame, simulate };
