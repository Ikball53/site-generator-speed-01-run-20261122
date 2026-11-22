[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=makefun&utm_medium=badge&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Ikball53/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=makefun&utm_medium=badge&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Ikball53/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=makefun&utm_medium=badge&utm_campaign=site-generator-speed-01-run-20261122)

# Single-Pass Folded Site Builder

A faster drop-in for makefun-site 1.0.0: `solve.js` exports `run(input)` returning the
exact same output tree (path -> text) as the reference static site generator, byte for
byte, built with single-pass hand-scanned parsing, table-driven HTML escaping, cached
slugs/dates, and templates compiled once to plain JS functions. `main.ts` is the harness
driver that reads `/input/cases.json` and writes `/output/answers.json`.
