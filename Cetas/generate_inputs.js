
'use strict';
const fs = require('fs');
const path = require('path');

const UF_VALUES = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const PERIODS = [1000, 2000, 2500, 5000];

const BENCHMARKS = [
  ['Bodytrack', 3824, 85], ['Canneal', 1007, 80], ['Dedup', 6455, 91], ['Fluid', 4090, 81],
  ['x264', 1203, 85], ['Swaptions', 4535, 76], ['Streamcluster', 6156, 68], ['Freqmine', 11082, 84],
];

const TABLE2 = [
  [[100, 90], [200, 70], [500, 60], [400, 60]],
  [[600, 64], [200, 76], [100, 50], [300, 90]],
  [[300, 75], [200, 50], [600, 80], [500, 75]],
  [[500, 65], [300, 80], [400, 75], [500, 60]],
  [[600, 80], [700, 75], [400, 65], [400, 60]],
  [[400, 60], [1000, 68], [500, 80], [600, 72]],
  [[400, 40], [400, 70], [600, 90], [700, 80]],
  [[200, 70], [100, 75], [300, 70], [400, 65]],
  [[400, 67], [300, 75], [200, 65], [200, 73]],
  [[600, 65], [500, 70], [400, 65], [300, 80]],
];

const EX2 = {
  e:   [[100, 600, 300, 500, 600, 800, 400, 200, 400, 600],
        [200, 500, 200, 300, 700, 1000, 400, 100, 800, 500],
        [500, 99, 600, 400, 451, 499, 600, 300, 200, 251],
        [400, 100, 500, 500, 450, 500, 700, 400, 200, 250]],
  gss: [[90, 64, 75, 65, 80, 60, 40, 70, 67, 65],
        [70, 76, 50, 80, 75, 68, 70, 75, 75, 70],
        [60, 50, 80, 75, 65, 80, 90, 70, 65, 65],
        [60, 90, 75, 60, 60, 72, 80, 65, 73, 80]],
};

function makeRng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = (() => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return (h ^= h >>> 16) >>> 0; })();
  const rnd = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { random: rnd, uniform: (lo, hi) => lo + (hi - lo) * rnd(), choice: (arr) => arr[Math.floor(rnd() * arr.length)] };
}

function dump(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function writeStatic(root) {
  dump(`${root}/platform.json`, {
    ambient_temp: 25.0,            // deg C, initial and idle temperature
    B: 0.003,                      // thermal constant of Eqn. 1 (per time slot)
    c: 1.0,                        // power P = c * F^3
    context_switch_us: 5.24,       // Bastoni et al.
    simulation_time_slots: 100000,
    beta_range: [1.0, 1.25],       // Eqn. 2
    alpha_max_percent: 10,         // temp variation across cores
  });
  dump(`${root}/frequencies.json`, {
    frequency_GHz: [0.9, 1.2, 1.5, 1.8, 2.1, 2.4, 2.7, 3.0],
    normalised_frequencies: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  });
  const rows = ['program,execution_requirement_ms,steady_state_temp_C', ...BENCHMARKS.map((b) => b.join(','))];
  fs.writeFileSync(`${root}/benchmarks.csv`, rows.join('\n') + '\n');
}

function writeExample(root) {
  const tasks = TABLE2.map((row, i) => ({
    id: i, name: `tau${i + 1}`, period: 750, beta: 1.0,
    exec: row.map((x) => x[0]), temp: row.map((x) => x[1]),
  }));
  dump(`${root}/example/example_tasks.json`, { num_cores: 4, tasks });
  const head = ['task', 'period', ...[1, 2, 3, 4].flatMap((j) => [`e_core${j}`, `Tss_core${j}`])].join(',');
  const lines = tasks.map((t) => [t.name, t.period, ...t.exec.flatMap((e, j) => [e, t.temp[j]])].join(','));
  fs.writeFileSync(`${root}/example/example_tasks.csv`, [head, ...lines].join('\n') + '\n');
}

function writeExample2(root) {
  const tasks = Array.from({ length: 10 }, (_, i) => ({
    id: i, name: `tau${i + 1}`, period: 750, beta: 1.0,
    exec: EX2.e.map((c) => c[i]), temp: EX2.gss.map((c) => c[i]),
  }));
  dump(`${root}/example/example2_tasks.json`, { num_cores: 4, tasks });
  const head = ['task', 'period', ...[1, 2, 3, 4].flatMap((j) => [`e_core${j}`, `Tss_core${j}`])].join(',');
  const lines = tasks.map((t) => [t.name, t.period, ...t.exec.flatMap((e, j) => [e, t.temp[j]])].join(','));
  fs.writeFileSync(`${root}/example/example2_tasks.csv`, [head, ...lines].join('\n') + '\n');
}

function genTaskset(rng, n, m, uf) {
  const meanExec = BENCHMARKS.reduce((a, b) => a + b[1], 0) / BENCHMARKS.length;
  const base = [], weights = [];
  for (let i = 0; i < n; i++) { const b = rng.choice(BENCHMARKS); base.push(b); weights.push(b[1] / meanExec); }
  const raw = weights.map((w) => Array.from({ length: m }, () => w * rng.uniform(0.5, 1.5)));

  let scale = 1.0, u = raw;
  for (let it = 0; it < 100; it++) {                     // scale to hit UF, clip u <= 0.98
    u = raw.map((r) => r.map((x) => Math.min(0.98, x * scale)));
    const cur = u.reduce((a, r) => a + r.reduce((x, y) => x + y, 0) / m, 0) / m;
    if (Math.abs(cur - uf) < 1e-3) break;
    scale *= uf / cur;
  }
  const tasks = [];
  for (let i = 0; i < n; i++) {
    const d = rng.choice(PERIODS);
    const alpha = rng.uniform(0, 0.10);
    tasks.push({
      id: i, name: `${base[i][0]}_${i}`, period: d,
      beta: Math.round(rng.uniform(1.0, 1.25) * 1e4) / 1e4,
      exec: u[i].map((x) => Math.max(1, Math.round(x * d))),
      temp: u[i].map(() => Math.round(base[i][2] * (1 + rng.uniform(-alpha, alpha)) * 100) / 100),
    });
  }
  return { num_cores: m, target_UF: uf, tasks };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const x = args.indexOf(`--${k}`); return x >= 0 ? args[x + 1] : d; };
  const out = opt('out', 'inputs');
  const cases = Number(opt('cases', 50)), n = Number(opt('tasks', 20));
  const m = Number(opt('cores', 8)), seed = opt('seed', '42');

  writeStatic(out);
  writeExample(out);
  writeExample2(out);
  for (const uf of UF_VALUES)
    for (let k = 0; k < cases; k++)
      dump(`${out}/experiments/uf_${uf}/case_${String(k).padStart(2, '0')}.json`,
        genTaskset(makeRng(`${seed}-${uf}-${k}`), n, m, uf));
  console.log(`Inputs written to ./${out}  (${UF_VALUES.length} UF values x ${cases} cases)`);
}
main();
