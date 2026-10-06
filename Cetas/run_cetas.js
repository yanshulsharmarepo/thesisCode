/**
 * Run CETAS on one task-set file and print / save the schedule tables.
 * node run_cetas.js [--tasks inputs/example/example_tasks.json] [--horizon N] [--out outputs]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadPlatform, loadTasks, runCetas } = require('./cetas');

const STAGES = [
  ['Stage 2 - initial schedule (Alg.3, F=1)', false, false],
  ['Stage 3 - temperature-aware schedule (Alg.4)', true, false],
  ['Stage 4 - energy-aware schedule (Alg.5, DVFS)', true, true],
];

function printFrame(tasks, sch) {
  sch.clusters.forEach((cl, k) =>
    console.log(`  cluster ${k + 1}: cores [${cl.cores.map((c) => c + 1)}]  tasks [${cl.tasks.map((i) => tasks[i].name)}]`));
  sch.segments.forEach((segs, j) => {
    const line = segs.map(([i, s, e, F]) =>
      `[${s}-${e}) ${i === null ? 'IDLE' : tasks[i].name}${F >= 1 ? '' : '@' + F.toFixed(1)}`).join('  ');
    console.log(`  Core${j + 1}: ${line}`);
  });
  console.log('  F_opt (Eqn.4):', JSON.stringify(sch.fRaw.map((x) => +x.toFixed(2))),
    '| frequency used:', JSON.stringify(sch.freq));
  const m = sch.freq.length;
  const saving = (100 * (m - sch.fRaw.reduce((a, b) => a + b, 0))) / m;
  console.log(`  frequency saving (paper metric): ${saving.toFixed(2)}%`);
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const x = args.indexOf(`--${k}`); return x >= 0 ? args[x + 1] : d; };
  const tasksFile = opt('tasks', 'inputs/example/example2_tasks.json');
  const { tasks, m } = loadTasks(tasksFile);
  const plat = loadPlatform(opt('platform', 'inputs/platform.json'), opt('freqs', 'inputs/frequencies.json'));
  const horizon = Number(opt('horizon', plat.horizon));
  const outDir = opt('out', 'outputs');

  let final = null;
  for (const [title, ta, ea] of STAGES) {
    const r = runCetas(tasks, m, plat, horizon, ta, ea);
    console.log(`\n=== ${title} ===`);
    if (!r.success) { console.log('  Task set rejected (infeasible under CETAS constraints)'); return; }
    const L = r.frames[0][1];
    console.log(`  (showing frame of length ${L}; hyper-period ${r.H}, ${r.frames.length} frames/hyper-period)`);
    printFrame(tasks, r.schedules.get(L));
    console.log(`  ATOC=${r.ATOC.toFixed(2)} C  peak=${r.peakTemp.toFixed(2)} C  NEC=${r.NEC.toFixed(3)}  CSO=${r.CSO.toFixed(5)} us/slot`);
    final = r;
  }
  const out = {};
  for (const [L, s] of final.schedules) {
    out[L] = {
      clusters: s.clusters, shares: s.shares, freq: s.freq, F_opt: s.fRaw,
      segments: s.segments.map((core) => core.map(([i, st, en, F]) =>
        ({ task: i === null ? null : tasks[i].name, start: st, end: en, freq: F }))),
    };
  }
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, path.basename(tasksFile).replace('.json', '_schedule.json'));
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nSchedule tables saved to ${file}`);
}
main();
