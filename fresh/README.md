node generate_inputs.js                       # regenerate inputs/
node fresh.js inputs/example_paper.json --windows 4 --verbose
node fresh.js inputs/random_uf0.8_n40_m4.json --compare --runs 50
node generate_inputs.js --n 40 --m 4 --uf 0.8 --out inputs/my.json