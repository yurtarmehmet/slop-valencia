#!/usr/bin/env python3
"""Write docs/fidelity-baseline.json from baseline-site runs (their compare.json).

usage: python baseline.py <main compare.json> [<heldout compare.json>] [--out docs/fidelity-baseline.json]
Numbers only (shares, colours, view counts, thresholds); no imagery.
"""
import json, os, sys, datetime

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
args = [a for a in sys.argv[1:] if not a.startswith("--")]
out = os.path.join(ROOT, "docs", "fidelity-baseline.json")
if "--out" in sys.argv:
    out = sys.argv[sys.argv.index("--out") + 1]
    args.remove(out)
doc = {
    "about": "Fidelity harness baseline: the game before the gap work (.fidelity/baseline-site), rendered at each "
             "viewpoint set and segmented with Mask2Former (Mapillary Vistas). See tools/realism/fidelity/README.md. "
             "Shares are % of the cropped frame (mean over views); 'sv' is Street View on the same set.",
    "date": datetime.date.today().isoformat(),
    "model": "facebook/mask2former-swin-large-mapillary-vistas-semantic",
    "crop": {"top": 0, "bottom": 0.18, "left": 0.28, "right": 0.13},
    "thresholds": {
        "inView": "class share > 0.2 % of the cropped frame",
        "viewCounts": "N of 50 scaled: ceil(N / 50 * views)",
        "colour": "every channel within 15 of Street View's median",
        "paint": "a view has yellow (green) paint when yellow (green) road-surface pixels > 0.02 % of the frame; #2: green views = 0, yellow views and centre-band yellow views <= Street View on the set",
        "guard": "sky, road, building share within max(10 %, guardDeviation + 0.5 %) of Street View",
        "uiMask": "Google UI pixels (svmask.py) excluded from Street View and from the game render of the same view",
        "signs": "Traffic Sign (Front) + (Back) + Frame; target ceil(35/47 x SV views with signs)",
        "markings": "Lane Marking - General; target ceil(35/41 x SV views with markings)",
        "furniture": "street furniture share within SV share x [2/2.8, 3/2.8]",
    },
    "sets": {},
}
for p in args:
    c = json.load(open(p))
    dev = {g: round(abs(v["game"] / v["sv"] - 1), 4) for g, v in c["groupSharePct"].items()
           if g in ("sky", "road", "building") and v["sv"]}
    doc["sets"][c["set"]] = {"views": c["views"], "run": os.path.relpath(os.path.dirname(os.path.abspath(p)), ROOT),
                             "groupSharePct": c["groupSharePct"], "medianColor": c["medianColor"],
                             "guardDeviation": dev, "criteria": c["criteria"]}
with open(out, "w") as f:
    json.dump(doc, f, indent=1)
print("wrote", out, list(doc["sets"]))
