# Amp Plan

A planner for L-Acoustics amplified controllers on live shows: pick speakers, get the amps and racks they need, lay the amps out in racks (the "Amp plan") and give every unit an IP address.

Live version: https://claude.ai/artifact/5h43CQ7UuqFMJdFoqXVjxU

## What's in it
- **Speakers & amps:** choose a speaker type and quantity; the app adds the amps L-Acoustics specifies and shows how many racks they fill.
- **Devices & IPs → Racks (Amp plan):** Left / Center / Right racks; each slot reads `preset - last IP number` (e.g. `K2 - 11`). Click an amp to pick its preset and IP last number, drag to rearrange, *Add 1 amp* or *+ Amp* per side for a single amp, export the plan as PNG/SVG.
- **Devices & IPs → List**, IP map, checks against L-Acoustics network rules, patch sheet, CSV and JSON backup.

## Layout
```
src/core.js              logic (IP maths, speakers → amps, racks, checks, exports); works in the browser and in Node
src/app.js               user interface
src/style.css            styles
src/index.template.html  page shell
build.py                 inlines everything into dist/index.html (one self-contained file)
test/core.test.js        unit tests:   node test/core.test.js
test/smoke.py            browser test: python3 test/smoke.py   (Playwright + Chrome)
```

## Build and run
```
python3 build.py
open dist/index.html
```
Opened as a plain file, plans are kept in the browser's local storage. In the Claude artifact they are kept in the artifact's database.
