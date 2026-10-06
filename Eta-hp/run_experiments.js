#!/usr/bin/env node
/**
 * Run ETA-HP over every  ${inputs}/experiments/uf_${uf}/case_*.json
 * and combine all results.
 *
 * Case file format (yours):
 *   { num_cores, target_UF, tasks: [ {id, name, period, beta, exec[], temp[]} ] }
 *   u_ij  = exec[j] / period          (share of core j the task needs)
 *   tss_j = temp[j]                   (steady-state temp on core j at fmax)
 *   cores: first --ooo cores out-of-order (default 4), the rest in-order
 *
 * Outputs
 *   ${dir}/results.json                        per-case + mean, for that UF
 *   ${inputs}/experiments/combined_results.json  every UF, every mode
 *   ${inputs}/experiments/combined_results.csv   mean per (UF, mode)
 *   ${inputs}/experiments/combined_per_case.csv  one row per (UF, case, mode)
 *
 * Usage:
 *   node run_experiments.js --inputs ./inputs
 *   node run_experiments.js --inputs ./inputs --ufs 0.5,0.6,0.7,0.8,0.9,1.0 \
 *        --max-cases 50 --slots 100000 --ooo 4
 */
const fs = require("fs");
const path = require("path");
const { simulate } = require("./eta_hp");

// ---- CLI -------------------------------------------------------------------
const opt = {
  inputs: "./inputs",
  ufs: [0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  maxCases: 50,
  slots: 100000,
  ooo: 4,
  ambient: 25.0,
  B: 0.005,
  gamma: 0.55,
};
const argv = process.argv.slice(2);
for (let k = 0; k < argv.length; k++) {
  const a = argv[k];
  if (a === "--inputs") opt.inputs = argv[++k];
  else if (a === "--ufs") opt.ufs = argv[++k].split(",").map(Number);
  else if (a === "--max-cases") opt.maxCases = parseInt(argv[++k], 10);
  else if (a === "--slots") opt.slots = parseInt(argv[++k], 10);
  else if (a === "--ooo") opt.ooo = parseInt(argv[++k], 10);
  else if (a === "--gamma") opt.gamma = parseFloat(argv[++k]);
  else if (a === "--B") opt.B = parseFloat(argv[++k]);
}
const inputs = opt.inputs;

const OOO_FREQS = [0.6, 0.7, 0.8, 0.9, 1.0]; // 1800..3000 MHz of 3000
const IO_FREQS = [0.5, 0.6667, 0.8333, 1.0]; // 900..1800 MHz of 1800

const MODES = [
  ["none (no TA, no EA)", false, false],
  ["TA only", true, false],
  ["EA only", false, true],
  ["ETA-HP (TA+EA)", true, true],
];
const METRICS = ["SRat_%", "ATOC_C", "PeakTemp_C", "NEC", "CSO_us_per_slot"];

// ---- helpers ---------------------------------------------------------------
// `uf_${1.0}` is "uf_1" in JS, so accept both spellings on disk.
function ufDir(uf) {
  const base = path.join(inputs, "experiments");
  for (const name of [`uf_${uf}`, `uf_${uf.toFixed(1)}`, `uf_${uf.toFixed(2)}`]) {
    const d = path.join(base, name);
    if (fs.existsSync(d)) return d;
  }
  return null;
}

function toInstance(c) {
  const m = c.num_cores || c.tasks[0].exec.length;
  const platform = [];
  for (let j = 0; j < m; j++) {
    const isOoo = j < opt.ooo;
    platform.push({
      id: j,
      type: isOoo ? "out-of-order" : "in-order",
      fmax_mhz: isOoo ? 3000 : 1800,
      freqs: isOoo ? OOO_FREQS : IO_FREQS,
    });
  }
  const tasks = c.tasks.map((t, i) => {
    const u = t.exec.map((e) => e / t.period);
    if (u.some((x) => x >= 1)) console.warn(`  warn: task ${t.name} has u >= 1`);
    return { id: i, name: t.name, period: t.period, u, tss: t.temp };
  });
  return {
    thermal: { ambient: opt.ambient, B: opt.B, gamma: opt.gamma },
    platform,
    tasks,
  };
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const std = (a) => {
  const mu = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - mu) ** 2)));
};

// ---- main ------------------------------------------------------------------
const combined = {}; // uf -> { cases, modes: {mode: {mean, std}} }
const perCaseRows = ["uf,case,mode,frames," + METRICS.join(",")];

for (const uf of opt.ufs) {
  const dir = ufDir(uf);
  if (!dir) { console.warn(`uf=${uf}: directory not found, skipping`); continue; }
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^case_.*\.json$/.test(f))
    .sort()
    .slice(0, opt.maxCases);
  if (!files.length) { console.warn(`uf=${uf}: no case_*.json in ${dir}`); continue; }

  console.log(`\nUF ${uf}: ${files.length} cases in ${dir}`);
  const perCase = {}; // mode -> [metrics...]
  MODES.forEach(([n]) => (perCase[n] = []));
  const caseResults = [];

  for (const f of files) {
    const inst = toInstance(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
    const row = { case: f, modes: {} };
    for (const [name, ta, ea] of MODES) {
      const r = simulate(inst, opt.slots, ta, ea);
      perCase[name].push(r);
      row.modes[name] = r;
      perCaseRows.push([uf, f, `"${name}"`, r.frames, ...METRICS.map((k) => r[k].toFixed(5))].join(","));
    }
    caseResults.push(row);
    process.stdout.write(".");
  }
  console.log();

  const summary = {};
  for (const [name] of MODES) {
    summary[name] = {};
    for (const k of METRICS) {
      const vals = perCase[name].map((r) => r[k]);
      summary[name][k] = { mean: mean(vals), std: std(vals) };
    }
  }
  combined[uf] = { dir, cases: files.length, modes: summary };
  fs.writeFileSync(
    path.join(dir, "results.json"),
    JSON.stringify({ uf, options: opt, summary, cases: caseResults }, null, 2)
  );
}

// ---- combine ---------------------------------------------------------------
const sortedResults = () => Object.entries(combined).sort((a, b) => Number(a[0]) - Number(b[0]));
const outDir = path.join(inputs, "experiments");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "combined_results.json"), JSON.stringify({ options: opt, results: combined }, null, 2));
fs.writeFileSync(path.join(outDir, "combined_per_case.csv"), perCaseRows.join("\n") + "\n");

const csv = ["uf,cases,mode," + METRICS.map((k) => `${k}_mean,${k}_std`).join(",")];
for (const [uf, r] of sortedResults())
  for (const [mode, s] of Object.entries(r.modes))
    csv.push([uf, r.cases, `"${mode}"`, ...METRICS.flatMap((k) => [s[k].mean.toFixed(5), s[k].std.toFixed(5)])].join(","));
fs.writeFileSync(path.join(outDir, "combined_results.csv"), csv.join("\n") + "\n");

// ---- console table: ETA-HP vs. baseline ------------------------------------
const pad = (s, w) => String(s).padStart(w);
console.log("\nETA-HP (mean over cases)   vs. no-TA/no-EA baseline");
console.log(pad("UF", 5) + pad("cases", 7) + pad("SRat %", 9) + pad("ATOC C", 9) +
  pad("dATOC C", 9) + pad("NEC", 8) + pad("saving %", 10) + pad("CSO us", 10));
for (const [uf, r] of sortedResults()) {
  const e = r.modes["ETA-HP (TA+EA)"], b = r.modes["none (no TA, no EA)"];
  console.log(pad(uf, 5) + pad(r.cases, 7) + pad(e["SRat_%"].mean.toFixed(2), 9) +
    pad(e.ATOC_C.mean.toFixed(2), 9) + pad((e.ATOC_C.mean - b.ATOC_C.mean).toFixed(2), 9) +
    pad(e.NEC.mean.toFixed(3), 8) + pad((100 * (1 - e.NEC.mean / b.NEC.mean)).toFixed(2), 10) +
    pad(e.CSO_us_per_slot.mean.toFixed(5), 10));
}
console.log(`\nwrote ${path.join(outDir, "combined_results.{json,csv}")} and combined_per_case.csv`);
