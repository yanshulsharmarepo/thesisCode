node generate_input.js --uf 0.8 --tasks 20 --seed 1 --out input.json
node eta_hp.js input.json --compare
node eta_hp.js input.json --slots 100000 --out metrics.json
node eta_hp.js input.json --dump-frames 2

node run_experiments.js --inputs ./inputs
