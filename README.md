# csv-reader-speed-01-run-20261121

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/NozartXE/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/NozartXE/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for csv-reader 1.0.0: reads broken CSV files (BOM, CRLF/LF/lone-CR, quoted fields, doubled quotes, quote junk, unterminated quotes, short/long rows) and returns exactly the same `{columns, rows, errors}`. Measured with interleaved A/B runs against the house baseline on the dev machine it is about 2.3–3.4x faster on the practice and realistic corpora (cold-process runs agree), by scanning between delimiters natively — a short character scan for the common short field, indexOf searches for longer ones — instead of stepping character by character, and by memoising failed closing-quote searches so unterminated quotes cannot trigger quadratic rescans. On files dense with stray CRs or malformed quotes it can still be slower than the baseline; on files of very short fields it is now about even.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node --no-incremental-marking main.ts
```

`main.ts` reads every case from `$MAKEFUN_INPUT_DIR/cases.json`, answers each with `run()` from `solve.js`, and writes `$MAKEFUN_OUTPUT_DIR/answers.json`. Requires Node 22.18+.

---

<sub>Entered on [make.fun](https://make.fun/?ref=b9zyas72&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
