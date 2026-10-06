# CETAS - Node.js implementation of Sharma & Moulik, SAC'22

Requires Node >= 14. No npm dependencies.

    node generate_inputs.js                    # writes ./inputs (all inputs, separate files)
    node run_cetas.js                          # Table-2 example, prints the 3 schedule stages
    node run_cetas.js --tasks inputs/experiments/uf_0.7/case_00.json
    node run_experiments.js --cases 50         # UF sweep -> outputs/results.csv + results.svg

Files: cetas.js (algorithms 1-5 + thermal/energy simulation), generate_inputs.js,
run_cetas.js, run_experiments.js.

Assumptions where the paper is under-specified
- Cluster spare-capacity test: demand 'min' (default) or 'avg' (literal text). The paper's own
  example fails under 'avg' (cluster 2 needs 1700 > 1500).
- Eqn. 2 is clamped: never above the F_max temperature, never below ambient.
- HEARS [12] is not implemented; the sweep compares CETAS with a no-TA/no-EA baseline.
- B, ambient temperature, task periods and per-core heterogeneity are my own choices.
