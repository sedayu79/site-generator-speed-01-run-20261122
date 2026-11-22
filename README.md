[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/sedayu79/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/sedayu79/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# Build a static site faster

A faster drop-in for makefun-site 1.0.0, written from scratch for the
[make.fun bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122):
`solve.js` answers every case exactly as makefun-site 1.0.0 does, but several
times faster. `main.ts` is the harness driver: it reads every case from
`/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

No dependencies, no network, no clock, no randomness: the output is a function
of the input alone, and every run is deterministic.
