# Fidelity harness

The yardstick behind `docs/fidelity-gaps.md`: the game and Google Street View at the same viewpoints, segmented with
Mask2Former (Mapillary Vistas), compared class by class. Every measurable "Fixed when" of the gap table is checked
here. Baseline numbers: `docs/fidelity-baseline.json`.

## Measure your gap

```sh
# your gap on both viewpoint sets, against the live tree (repo root)
node tools/realism/fidelity/run.mjs --set both --site current --criteria 1
# the frozen pre-gap game, for comparison
node tools/realism/fidelity/run.mjs --set both --site baseline --criteria 1
# a few views only (quick look; view-count thresholds scale with the number of views)
node tools/realism/fidelity/run.mjs --set main --only 04,12,46 --criteria 2
# re-segment renders you already have (no rendering)
node tools/realism/fidelity/run.mjs --set main --renders .fidelity/out/<run>/renders --criteria 5
```

Output: `.fidelity/out/<set>-<site>-<timestamp>/` with `renders/` (look at them), `masks/` (label ids),
`seg.json`, `compare.json` and `report.txt`; the table is also printed. Renders go through
`tools/realism/shot.mjs` in batches of at most 10 poses; each batch takes and releases the machine-wide GPU lock
(`.cache/gpu.lock`), and segmentation takes it per 10 images, so a run queues behind other renders. `seg.lock` keeps
one segmenter in memory at a time. The page is served from a free port unless `--port` is given.

A gap passes when its rows pass on BOTH sets and the regression guard (sky, road, buildings) passes.

## Pieces

| File | What |
| --- | --- |
| `viewpoints.json` | `sets.main` (the doc's 50) and `sets.heldout` (33); pose `v` for `__slop.look`, compass heading, Street View date |
| `seg.py` | Mask2Former segmentation: per image class/group shares, median colours, paint colour of markings and road |
| `compare.py` | Group-share table, median colours, every criterion with pass/fail (`--only`, `--criteria`, `--json`) |
| `run.mjs` | Serve a site, render a set, segment, compare |
| `points.mjs` | Builds the held-out set by rule |
| `sv.mjs` | Street View capture for a set (local only) |

Local data (gitignored, never commit): `.fidelity/sv/` and `.fidelity/sv-heldout/` (Street View captures),
`.fidelity/sv-seg.json`, `.fidelity/sv-heldout-seg.json` (their segmentation, made once by `run.mjs`),
`.fidelity/baseline-site/` (a frozen copy of the game before the gap work), `.fidelity/out/` (runs).

## Setup

```sh
python3 -m venv .cache/segenv && .cache/segenv/bin/pip install torch transformers pillow numpy scipy
```

The model `facebook/mask2former-swin-large-mapillary-vistas-semantic` loads from `~/.cache/huggingface` (runs on
`mps`). Rendering needs `.cache/node/node_modules/playwright-core` and system Chrome (see `tools/realism/shot.mjs`).

## How the viewpoints were chosen

**Main set (50, the doc's).** Road samples every 4 m along every non-highway road of `city-config.js` `ROADS`.
- 33 barri points: for each barri centre in `city-config.js` (`BARRIS`) inside `GEO.frame.detail`, the nearest
  sample on a street at least 7 m wide or pedestrian; the camera looks along the road (its point order).
- 17 pin points: for each `CITY_LANDMARKS` pin, the sample 45-140 m away whose distance is closest to 70 m; the
  camera looks at the landmark.
- Game pose: Street View's snapped pano position and heading when the Maps URL reported it (2 of 50: 04 and 46),
  else the point itself; eye 2.5 m up (the Street View car's camera), looking 30 m ahead at 2.3 m.

**Held-out set (33).** Same road samples, read from the frozen baseline game (`.fidelity/baseline-site/js`), so the
set does not move as the game changes. For each of the same 33 barri centres, the nearest sample on a street at least
7 m wide or pedestrian, on a DIFFERENT street from that barri's main point, at least 150 m from every main viewpoint
and from every held-out point already chosen (barris in `BARRIS` order); looking along the road. No pins (the
landmarks are already in the main set). All 33 land 92-189 m from their barri centre. Same pose rule.

**Street View.** `sv.mjs`: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=<lat>,<lon>&heading=<h>&pitch=0&fov=90`,
1280x720 headless Chrome, consent rejected, screenshot after the imagery loads. Capture dates are in
`viewpoints.json` (`svDate`). The held-out captures were taken 2026-11-05 with this script (imagery dated May 2012
to Sep 2026; none reported a snapped pano URL, so their poses are the points themselves, like 48 of the main 50); the
main ones in the earlier session the same day, with the same URL and steps (imagery 2012-2026).

## Google UI masks

Street View captures carry Google's overlays: the search box corner and the info panel (top left), place pins
(coloured discs with an icon), road-name labels painted along the road, and the navigation arrows. Mask2Former labels
them as real classes (the search-box corner alone is a "Traffic Sign (Front)" of > 0.2 % in every view; labels and
arrows land in lane markings). `svmask.mjs` re-opens each pano exactly as `sv.mjs` did and takes three shots: normal,
one with each WebGL draw program skipped in turn (the one where the panorama vanishes leaves only Google's canvas
overlays on black), and one with all HTML hidden (differs from normal exactly at the HTML UI). `svmask.py` turns them
into `.fidelity/uimask/<set>/<id>.png` (dilated 3 px), checks the fresh shot against the stored capture outside the
mask (same pano), and draws contact sheets for checking by eye. Where Google now serves a different pano than the
stored capture, the mask is drawn by hand instead (listed in `.fidelity/uimask/<set>.json`).

`seg.py --uimask` drops the masked pixels from every share, colour and paint count, and `run.mjs` applies the SAME
mask of a view to its game render, so both sides are measured over the same area. `run.mjs` uses the masks once
`.fidelity/uimask/<set>/READY` exists; re-scoring old renders (`--renders`) picks them up too.

## Corrected Street View numbers

Street View before and after the UI masks (main 50; held-out 33 below), with the re-derived targets:

| Main set | SV before | SV after | Target after |
| --- | --- | --- | --- |
| Traffic signs, views (front only, as in the doc) | 47 | 7 | |
| Traffic signs, views (front + back + frame) | 47 | 8 | 6+ (35/47 x 8) |
| Lane markings, views | 41 | 31 | 27+ (35/41 x 31) |
| Street furniture share | 2.8 % | 2.0 % | 1.4-2.1 % (x 2/2.8-3/2.8) |
| People, views | 19 | 17 | 15+ (unchanged) |
| Cars, views | 28 | 28 | 25+ (unchanged) |
| Fence, views | 24 | 24 | 20+ (unchanged) |
| Vehicle share | 4.9 % | 5.0 % | 4-5 % (unchanged) |
| Vegetation share | 10.6 % | 10.8 % | 9-11 % (unchanged) |
| Sidewalk share | 6.9 % | 7.0 % | <= 8 % (unchanged) |
| Road / sky / buildings share | 11.5 / 19.6 / 42.3 % | 10.9 / 20.0 / 43.0 % | guard |
| Asphalt colour | 136,133,133 | 134,133,132 | within 15 |
| Sidewalk / vegetation colour | 141,140,136 / 98,102,70 | unchanged | within 15 |

HELDOUT_TABLE

## Measurement rules (reproduce the doc on its 50 viewpoints)

- Crop: top 0, bottom 0.18, left 0.28, right 0.13 of the 1280x720 frame (clear of the Street View panels), then
  resized to 1280 px wide (1280x999), fed to the model at that size. Same crop for game and Street View.
- Groups (`seg.py` `GROUPS`): road includes lane markings, crosswalks, manholes, bike lane, parking; sidewalk includes
  curb and pedestrian area; building includes wall, fence, bridge; street furniture includes poles, lights, signs,
  bins, benches, etc.
- Share = mean over views of the group's pixel fraction. Colour = median over views (where the group covers > 1 %)
  of the group's per-view median sRGB. "Within 15 RGB" = every channel within 15.
- "X in a view" = the class covers more than 0.2 % of the cropped frame (`IN_VIEW = 0.002`). This threshold
  reproduces every count in the doc: cars 28/13, motorbikes 5/0, lane markings 41/10, fence 24/2, traffic signs
  47/2, bins 10/0, people 19/5 (Street View / game). Classes: Car; Lane Marking - General; Fence; Traffic Sign
  (Front); Person.
- Traffic signs (#5) count Traffic Sign (Front) + Traffic Sign (Back) + Traffic Sign Frame, on both sides: the
  cameras look along one-way streets, so many signs show their backs.
- Corrected targets. Three targets the doc derived from Street View counts are re-derived from the UI-masked Street
  View on the views compared, by the doc's proportion (no other target changes):
  - signs (#5): ceil(35 / 47 x SV views with signs) (doc: 35 of 47);
  - lane markings (#2): ceil(35 / 41 x SV views with markings) (doc: 35 of 41);
  - street-furniture share (#5): SV share x 2/2.8 to SV share x 3/2.8 (doc: 2-3 % against 2.8 %).
  `compare.py` prints the derived number in each row; the values per set are in "Corrected Street View numbers".
- Game-side mislabels: Mask2Former labels some game objects as traffic signs: the green glass igloo container (main
  22, 3.8 % of the frame), and at baseline a red barrier (09) and a kerb corner (32). None of the baseline game's
  "sign" views shows a sign. `compare.py` lists the game views it counts as having signs; check them by eye.
- View counts "N of 50" scale with the views compared: required = ceil(N / 50 x views) (held-out 33: cars 17,
  markings 24, fence 14, signs 24, people 10).
- Share ranges (vehicles 4-5 %, furniture 2-3 %, vegetation 9-11 %, sidewalk <= 8 %) are the doc's absolute numbers
  on every set; Street View's own value on the set is printed beside them.
- Paint colour (#2). Clarified rule: no yellow centre lines, no green paint, and yellow only where the city's
  markings dataset (*Senyalització horitzontal*) says yellow, with yellow-paint views not above Street View's count
  on each set. A view "has" a colour when strongly coloured pixels (HSV saturation >= 0.35, value >= 0.25; yellow hue
  35-70 deg, green 75-170) on the road surface (road, markings, crosswalks, bike lane, parking) cover more than
  `PAINT_IN_VIEW` (0.02 %) of the frame. Checks:
  - green road paint in 0 views;
  - yellow road paint in no more views than Street View on the set (main: 6 of 50);
  - yellow in the centre band (40-60 % of the uncropped width, where a centre line runs when looking along the
    street) in no more views than Street View (main: 2, both kerb-side yellow lines in narrow streets). This is only
    a proxy: thin, distant centre lines mostly fall under the pixel threshold, so the baseline's New York double
    yellow registers in 1 view (12) only and the check passes at baseline.
  - "Only where the dataset says yellow" can't be measured from pixels; the markings work has to show it from its
    data (every yellow line drawn comes from a yellow line in the dataset).
- Run-to-run noise (same site, two renders): moving traffic and shadows differ; shares move by up to 0.4 point
  (road 10.4 vs 10.0, sidewalk 11.9 vs 12.2, vehicles 0.8 vs 0.9) and view counts by 1-2 (cars 13 vs 15).
- Regression guard: sky, road and building shares within 10 % (relative) of Street View. Buildings are already
  10.7 % over at baseline on the main set (46.8 vs 42.3), so a set's allowance is max(10 %, its baseline deviation
  in `docs/fidelity-baseline.json` + 0.5 %): a change must not push them further off. On the main set that is
  sky 10 %, road 13.9 % (the fresh baseline render has 10.0 % road against the stored 10.4 %), buildings 11.2 %.

Rounding note: the doc's ratio column was computed from rounded shares (people 0.3/0.7 = 43 %); `compare.py`
divides the unrounded means (35 %). The shares and colours themselves match the doc exactly.
