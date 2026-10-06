/**
 * Metrics vs. utilisation factor (Section 6). Compares CETAS (clustering + TA + EA)
 * with an ablated baseline (clustering + initial schedule at F_max).
 * HEARS [12] is a different published algorithm and is NOT included.
 *
 * node run_experiments.js [--cases 50] [--horizon 100000] [--inputs inputs] [--out outputs]
 * Output: outputs/results.csv and outputs/results.svg
 */
'use strict';
const fs = require('fs');
const { loadPlatform, loadTasks, runCetas } = require('./cetas');

const UF_VALUES = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const VARIANTS = { Baseline: [false, false], CETAS: [true, true] };

function svgChart(rows) {
  const metrics = [['ATOC_C', 'ATOC (C)'], ['SRat_%', 'SRat (%)'], ['NEC', 'NEC'], ['CSO_us_per_slot', 'CSO (us/slot)']];
  const W = 340, H = 260, pad = 46, colors = { Baseline: '#d95f02', CETAS: '#1b7837' };
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 4}" height="${H + 30}" font-family="sans-serif" font-size="11">`;
  metrics.forEach(([key, label], k) => {
    const ox = k * W;
    const vals = rows.map((r) => r[key]);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi === lo) { hi += 1; lo -= 1; }
    const span = hi - lo; lo -= span * 0.1; hi += span * 0.1;
    const x = (uf) => ox + pad + ((uf - 0.5) / 0.5) * (W - pad - 20);
    const y = (v) => H - pad - ((v - lo) / (hi - lo)) * (H - pad - 25);
    svg += `<text x="${ox + W / 2}" y="16" text-anchor="middle" font-weight="bold">${label}</text>`;
    svg += `<line x1="${ox + pad}" y1="${H - pad}" x2="${ox + W - 20}" y2="${H - pad}" stroke="#333"/>`;
    svg += `<line x1="${ox + pad}" y1="25" x2="${ox + pad}" y2="${H - pad}" stroke="#333"/>`;
    UF_VALUES.forEach((uf) => { svg += `<text x="${x(uf)}" y="${H - pad + 15}" text-anchor="middle">${uf}</text>`; });
    for (let t = 0; t <= 4; t++) {
      const v = lo + ((hi - lo) * t) / 4;
      svg += `<text x="${ox + pad - 5}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(v < 1 ? 3 : 1)}</text>`;
    }
    svg += `<text x="${ox + W / 2}" y="${H - 8}" text-anchor="middle">Utilisation Factor</text>`;
    Object.keys(VARIANTS).forEach((name, s) => {
      const pts = rows.filter((r) => r.algorithm === name).map((r) => [x(r.UF), y(r[key])]);
      svg += `<polyline fill="none" stroke="${colors[name]}" stroke-width="2" points="${pts.map((p) => p.join(',')).join(' ')}"/>`;
      pts.forEach((p) => { svg += `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="${colors[name]}"/>`; });
      svg += `<text x="${ox + W - 90}" y="${34 + s * 14}" fill="${colors[name]}">${name}</text>`;
    });
  });
  return svg + '</svg>';
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const x = args.indexOf(`--${k}`); return x >= 0 ? args[x + 1] : d; };
  const inputs = opt('inputs', 'inputs'), outDir = opt('out', 'outputs');
  const plat = loadPlatform(`${inputs}/platform.json`, `${inputs}/frequencies.json`);
  const horizon = Number(opt('horizon', plat.horizon));
  const maxCases = opt('cases', null) === null ? Infinity : Number(opt('cases'));

  const rows = [];
  for (const uf of UF_VALUES) {
    const dir = `${inputs}/experiments/uf_${uf}`;
    const files = fs.readdirSync(dir).filter((f) => /^case_.*\.json$/.test(f)).sort().slice(0, maxCases);
    for (const [name, [ta, ea]] of Object.entries(VARIANTS)) {
      const acc = { ATOC: 0, NEC: 0, CSO: 0, peak: 0 };
      let ok = 0;
      for (const f of files) {
        const { tasks, m } = loadTasks(`${dir}/${f}`);
        const r = runCetas(tasks, m, plat, horizon, ta, ea);
        if (r.success) { ok++; acc.ATOC += r.ATOC; acc.NEC += r.NEC; acc.CSO += r.CSO; acc.peak += r.peakTemp; }
      }
      const d = Math.max(ok, 1), rd = (x, p) => Math.round(x * 10 ** p) / 10 ** p;
      rows.push({
        UF: uf, algorithm: name, 'SRat_%': rd((100 * ok) / files.length, 2),
        ATOC_C: rd(acc.ATOC / d, 3), peak_C: rd(acc.peak / d, 3),
        NEC: rd(acc.NEC / d, 4), CSO_us_per_slot: rd(acc.CSO / d, 6),
      });
      console.log(JSON.stringify(rows[rows.length - 1]));
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  const cols = Object.keys(rows[0]);
  fs.writeFileSync(`${outDir}/results.csv`, [cols.join(','), ...rows.map((r) => cols.map((c) => r[c]).join(','))].join('\n') + '\n');
  fs.writeFileSync(`${outDir}/results.svg`, svgChart(rows));
  console.log(`\nSaved ${outDir}/results.csv and ${outDir}/results.svg`);
}
main();
