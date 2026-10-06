/**
 * CETAS: Cluster based Energy and Temperature efficient real-time Scheduler
 * for heterogeneous multicore platforms (Sharma & Moulik, SAC'22).
 *
 * Stages (per frame):
 *   0. Deadline partitioning            deadlinePartition()
 *   1. Core clustering (Alg. 2)         constructClusters()
 *   2. Schedule construction (Alg. 3)   constructSchedule()
 *   3. Temperature-aware order (Alg. 4) taOrder()
 *   4. Energy-aware DVFS (Alg. 5)       inside scheduleFrame()
 *
 * No external dependencies. Node >= 14.
 */
'use strict';
const fs = require('fs');

const EPS = 1e-9;

// ---------------------------------------------------------------- input loading
function loadTasks(path) {
  const d = JSON.parse(fs.readFileSync(path, 'utf8'));
  const tasks = d.tasks.map((t) => ({
    id: t.id,
    name: t.name || `tau${t.id + 1}`,
    period: Math.trunc(t.period),
    exec: t.exec,          // e^i_j at F_max
    temp: t.temp,          // Gamma_ss^{i,j} at F_max
    beta: t.beta === undefined ? 1.0 : t.beta,
  }));
  return { tasks, m: d.num_cores };
}

function loadPlatform(platformPath, freqPath) {
  const p = JSON.parse(fs.readFileSync(platformPath, 'utf8'));
  const f = JSON.parse(fs.readFileSync(freqPath, 'utf8'));
  return {
    ambient: p.ambient_temp,
    B: p.B,
    c: p.c,
    ctxSwitchUs: p.context_switch_us,
    horizon: p.simulation_time_slots,
    freqs: [...f.normalised_frequencies].sort((a, b) => a - b),
  };
}

const util = (t, j) => t.exec[j] / t.period;

// ------------------------------------------------ stage 0: frames and shares
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const lcm = (a, b) => (a / gcd(a, b)) * b;

function hyperperiod(tasks) {
  return tasks.map((t) => t.period).reduce(lcm);
}

function deadlinePartition(tasks, H) {
  const pts = new Set([0, H]);
  for (const t of tasks) for (let x = t.period; x < H; x += t.period) pts.add(x);
  const s = [...pts].sort((a, b) => a - b);
  const frames = [];
  for (let k = 0; k + 1 < s.length; k++) frames.push([s[k], s[k + 1] - s[k]]); // [start, length]
  return frames;
}

// Eqn. 3: shr[i][j] = ceil(u^i_j * |W_k|)
function shareMatrix(tasks, m, L) {
  return tasks.map((t) =>
    Array.from({ length: m }, (_, j) => Math.ceil((t.exec[j] * L) / t.period - EPS)));
}

// ------------------------------------------------ stage 1: CONSTRUCT-CLUSTERS
/**
 * demand: how a task's load is estimated in the spare-capacity test.
 *  'avg' = mean share over cluster cores (literal text of the paper)
 *  'min' = share on the preferred core (needed to reproduce the paper's example,
 *          whose cluster 2 needs 1700 under 'avg' but has capacity 1500).
 */
function constructClusters(n, m, shr, L, demand = 'min') {
  const dem = demand === 'avg' ? (v) => v.reduce((a, b) => a + b, 0) / v.length : (v) => Math.min(...v);
  const entries = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) entries.push([shr[i][j], i, j]);
  entries.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

  const coreCluster = new Array(m).fill(-1);
  const taskCluster = new Array(n).fill(-1);
  const clusters = [];

  for (const [, i, j1] of entries) {
    if (taskCluster[i] !== -1) continue;
    if (coreCluster[j1] === -1) {                       // new cluster (Line 7-13)
      const free = [];
      for (let j = 0; j < m; j++) if (j !== j1 && coreCluster[j] === -1) free.push([shr[i][j], j]);
      free.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      if (free.length) {
        const j2 = free[0][1];
        const avg = dem([shr[i][j1], shr[i][j2]]);
        if (avg <= 2 * L) {
          clusters.push({ cores: [j1, j2], tasks: [i], spare: 2 * L - avg });
          coreCluster[j1] = coreCluster[j2] = taskCluster[i] = clusters.length - 1;
        }
      } else if (shr[i][j1] <= L) {                     // odd core count: single-core cluster
        clusters.push({ cores: [j1], tasks: [i], spare: L - shr[i][j1] });
        coreCluster[j1] = taskCluster[i] = clusters.length - 1;
      }
    } else {                                            // join existing cluster (Line 14-17)
      const p = coreCluster[j1];
      const cl = clusters[p];
      const avg = dem(cl.cores.map((c) => shr[i][c]));
      if (avg <= cl.spare + EPS) {
        cl.tasks.push(i);
        cl.spare -= avg;
        taskCluster[i] = p;
      }
    }
  }
  if (taskCluster.some((c) => c === -1)) return null;   // infeasible task set
  return clusters;
}

// ------------------------------------------------ stage 2: CONSTRUCT-SCHEDULE
// Returns { fixed: {core: [[task, slots]]}, migr: [[task, core, slots]] } or null
function constructSchedule(tasks, shr, cl, L) {
  const cores = cl.cores;
  if (cores.length === 1) {
    const j = cores[0];
    const items = cl.tasks.map((i) => [i, shr[i][j]]);
    if (items.reduce((a, [, t]) => a + t, 0) > L) return null;
    return { fixed: { [j]: items }, migr: [] };
  }
  const [j1, j2] = cores;
  const ratio = (i) => {
    const u1 = util(tasks[i], j1), u2 = util(tasks[i], j2);
    return u2 > 0 ? u1 / u2 : Infinity;
  };
  const L1 = [...cl.tasks].sort((a, b) => ratio(a) - ratio(b));     // deque via head/tail idx
  let head = 0, tail = L1.length - 1;
  const work = {}, alloc = {}, order = { [j1]: [], [j2]: [] };
  const rcap = { [j1]: L, [j2]: L };
  for (const i of L1) { work[i] = 1.0; alloc[i] = { [j1]: 0, [j2]: 0 }; }

  const put = (i, j) => {
    const need = Math.ceil(work[i] * shr[i][j] - EPS);
    const t = Math.min(need, rcap[j]);
    if (t > 0) {
      alloc[i][j] += t;
      rcap[j] -= t;
      if (!order[j].includes(i)) order[j].push(i);
      work[i] = t === need ? 0.0 : work[i] - t / shr[i][j];
    }
  };

  // tasks preferring j1 -> j1 from the front (Line 7-10)
  while (head <= tail && ratio(L1[head]) <= 1 && rcap[j1] > 0) {
    const i = L1[head];
    put(i, j1);
    if (work[i] <= EPS) head++; else break;
  }
  // remaining tasks -> j2 from the rear (Line 11-14)
  while (head <= tail && rcap[j2] > 0) {
    const i = L1[tail];
    put(i, j2);
    if (work[i] <= EPS) tail--; else break;
  }
  // leftovers -> any core with capacity (Line 15-16)
  for (let k = head; k <= tail; k++) {
    const i = L1[k];
    if (work[i] > EPS) put(i, j1);
    if (work[i] > EPS) put(i, j2);
    if (work[i] > EPS) return null;                     // cluster overflow -> reject
  }

  const fixed = { [j1]: [], [j2]: [] };
  const migr = [];
  for (const i of cl.tasks) {
    const t1 = alloc[i][j1], t2 = alloc[i][j2];
    if (t1 > 0 && t2 > 0) {                             // migrating task
      if (t1 + t2 > L) return null;                     // would run in parallel
      migr.push([i, j1, t1], [i, j2, t2]);
    } else if (t1 > 0) fixed[j1].push([i, t1]);
    else if (t2 > 0) fixed[j2].push([i, t2]);
  }
  for (const j of [j1, j2]) {                           // keep assignment order
    const pos = new Map(order[j].map((i, k) => [i, k]));
    fixed[j].sort((a, b) => pos.get(a[0]) - pos.get(b[0]));
  }
  return { fixed, migr };
}

// ------------------------------------------------ stage 3: TA-ALLOCATE
function taOrder(items, tasks, j, avgTemp) {
  const L2 = [...items].sort((a, b) => tasks[b[0]].temp[j] - tasks[a[0]].temp[j]); // hottest first
  const hot = {};
  for (const [i] of L2) hot[i] = tasks[i].temp[j] >= avgTemp;
  const L3 = [];
  let lo = 0, hi = L2.length - 1, takeHot = true;
  while (lo <= hi) {
    if (takeHot) L3.push(L2[lo++]); else L3.push(L2[hi--]);
    takeHot = !takeHot;
  }
  return { order: L3, hot };
}

// ------------------------------------------------ per-frame schedule (stages 1-4)
function scheduleFrame(tasks, m, L, freqs, useTA = true, useEA = true, demand = 'min') {
  const n = tasks.length;
  const shr = shareMatrix(tasks, m, L);
  const clusters = constructClusters(n, m, shr, L, demand);
  if (!clusters) return null;

  const fixed = Array.from({ length: m }, () => []);
  const freeStart = new Array(m).fill(0);
  const freeEnd = new Array(m).fill(L);
  const head = Array.from({ length: m }, () => []);
  const tail = Array.from({ length: m }, () => []);

  for (const cl of clusters) {
    const res = constructSchedule(tasks, shr, cl, L);
    if (!res) return null;
    for (const [j, lst] of Object.entries(res.fixed)) fixed[Number(j)].push(...lst);
    const spans = {};
    for (const [i, j, t] of res.migr) {
      let s, e;
      if (j === cl.cores[0]) {                          // tail of first core
        e = freeEnd[j]; s = e - t; freeEnd[j] = s; tail[j].push([i, s, e]);
      } else {                                          // head of second core
        s = freeStart[j]; e = s + t; freeStart[j] = e; head[j].push([i, s, e]);
      }
      (spans[i] = spans[i] || []).push([s, e]);
    }
    for (const sp of Object.values(spans)) {            // never parallel
      const [[a1, b1], [a2, b2]] = sp;
      if (a1 < b2 && a2 < b1) return null;
    }
  }

  const segments = [], fRaw = [], fUsed = [], hotcold = [];
  for (let j = 0; j < m; j++) {
    let items = fixed[j];
    const avg = tasks.reduce((a, t) => a + t.temp[j], 0) / n;
    let hot;
    if (useTA && items.length) ({ order: items, hot } = taOrder(items, tasks, j, avg));
    else { hot = {}; for (const [i] of items) hot[i] = tasks[i].temp[j] >= avg; }
    hotcold.push(hot);

    const free = freeEnd[j] - freeStart[j];
    const tot = items.reduce((a, [, t]) => a + t, 0);
    const fr = free > 0 ? tot / free : (tot === 0 ? 0 : Infinity);   // Eqn. 4
    if (fr > 1 + EPS) return null;                                   // core overloaded
    const F = useEA ? (freqs.find((f) => f >= fr - EPS) ?? 1.0) : 1.0;
    fRaw.push(fr); fUsed.push(F);

    const segs = head[j].map(([i, s, e]) => [i, s, e, 1.0]);
    let cur = freeStart[j], cum = 0;
    for (const [i, t] of items) {
      cum += t;
      const end = Math.min(freeStart[j] + Math.round(cum / F), freeEnd[j]);
      if (end > cur) { segs.push([i, cur, end, F]); cur = end; }
    }
    if (cur < freeEnd[j]) segs.push([null, cur, freeEnd[j], F]);
    for (const [i, s, e] of tail[j]) segs.push([i, s, e, 1.0]);
    segs.sort((a, b) => a[1] - b[1]);
    segments.push(segs);
  }
  return { L, shares: shr, clusters, segments, fRaw, freq: fUsed, hot: hotcold };
}

// ------------------------------------------------ thermal / energy simulation
// Eqn. 2, clamped: slowing never heats and never drops below ambient.
function gammaSS(tasks, plat, i, j, F) {
  if (i === null) return plat.ambient;
  const g = tasks[i].temp[j];
  if (F >= 1 - EPS) return g;
  return Math.max(plat.ambient, Math.min(g, tasks[i].beta * F * g));
}

function runCetas(tasks, m, plat, horizon, useTA = true, useEA = true, demand = 'min') {
  const H = hyperperiod(tasks);
  const frames = deadlinePartition(tasks, H);
  const cache = new Map();
  for (const [, L] of frames) {                         // schedule depends only on |W_k|
    if (!cache.has(L)) {
      const s = scheduleFrame(tasks, m, L, plat.freqs, useTA, useEA, demand);
      if (!s) return { success: false, schedules: cache, H, frames };
      cache.set(L, s);
    }
  }
  const temp = new Array(m).fill(plat.ambient);
  const frameAvgs = [];
  let peak = plat.ambient, energy = 0, switches = 0, simulated = 0;
  const reps = Math.ceil(horizon / H);
  for (let r = 0; r < reps; r++) {
    for (const [st, L] of frames) {
      if (r * H + st >= horizon) break;
      const sch = cache.get(L);
      for (let j = 0; j < m; j++) {
        for (const [i, s, e, F] of sch.segments[j]) {
          const dt = e - s;
          const g = gammaSS(tasks, plat, i, j, F);
          temp[j] = g + (temp[j] - g) * Math.exp(-plat.B * dt);      // Eqn. 1
          if (temp[j] > peak) peak = temp[j];
          if (i !== null) { energy += plat.c * F ** 3 * dt; switches++; }
        }
      }
      frameAvgs.push(temp.reduce((a, b) => a + b, 0) / m);
      simulated += L;
    }
  }
  return {
    success: true, schedules: cache, H, frames,
    ATOC: frameAvgs.reduce((a, b) => a + b, 0) / frameAvgs.length,
    peakTemp: peak,
    NEC: energy / (plat.c * m * simulated),
    CSO: (switches * plat.ctxSwitchUs) / simulated,
  };
}

module.exports = { loadTasks, loadPlatform, hyperperiod, deadlinePartition, shareMatrix,
  constructClusters, constructSchedule, taOrder, scheduleFrame, runCetas };
