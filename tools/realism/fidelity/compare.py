#!/usr/bin/env python3
"""Game vs Street View, per viewpoint set: the group-share table of docs/fidelity-gaps.md, median colours, and every
"Fixed when" criterion segmentation can measure, with pass/fail.

usage: python compare.py --game <seg.json> --sv <seg.json> [--set main] [--only 01,02] [--criteria 1,5]
                         [--json out.json]

Both seg.json files come from seg.py (same model, crop and resize). Images are matched by file name (NN.png).

Rules (reproduce the doc's numbers on its 50 viewpoints, see README.md):
- share   = mean over the views of a group's pixel fraction of the cropped frame
- colour  = median over the views (those where the group covers > 1 %) of the group's per-view median sRGB
- "in a view" = the class covers more than 0.2 % of the cropped frame (IN_VIEW)
- view counts "N of 50" scale with the number of views compared: required = ceil(N / 50 * views)
- colour "within 15 RGB" = every channel within 15
- share ranges are the doc's absolute numbers on every set; Street View's value on the set is printed beside them,
  except the targets the doc derived from Street View (signs, markings, furniture share): see SIGN_PROP etc.
- pixels Google draws over Street View (UI masks, svmask.py) are excluded on both sides (seg.py --uimask)
"""
import argparse, json, math, os, sys
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
IN_VIEW = 0.002          # class share of the cropped frame for "X in a view"
PAINT_IN_VIEW = 0.0002   # yellow or green road-surface pixels (fraction of frame) for "coloured paint in a view"
GROUPS = ["vehicle", "street furniture", "person", "vegetation", "road", "sky", "building", "sidewalk"]
LABEL = {"vehicle": "Parked and moving vehicles", "street furniture": "Street furniture and signs", "person": "People",
         "vegetation": "Trees and plants", "road": "Road", "sky": "Sky", "building": "Buildings", "sidewalk": "Sidewalk"}
SIGN_LABELS = ["Traffic Sign (Front)", "Traffic Sign (Back)", "Traffic Sign Frame"]
# Targets the doc derived from Street View counts, re-derived from the UI-masked Street View by the same proportion
# (see README.md "Corrected targets"): signs 35 of 47 SV views, markings 35 of 41, furniture 2-3 % against 2.8 %.
SIGN_PROP, MARKING_PROP, FURN_BAND = 35 / 47, 35 / 41, (2 / 2.8, 3 / 2.8)
COLOR_GROUPS = {"road": "asphalt (road)", "sidewalk": "sidewalk", "vegetation": "vegetation", "building": "building"}


def load(p):
    with open(p) as f:
        return json.load(f)["images"]


def share(D, g):
    return float(np.mean([im["groupShare"][g] for im in D.values()])) if D else 0.0


def color(D, g):
    cs = [im["groupColor"][g] for im in D.values() if g in im.get("groupColor", {})]
    return [int(round(v)) for v in np.median(cs, axis=0)] if cs else None


def views(D, labels, th=IN_VIEW):
    return sum(1 for im in D.values() if sum(im["classShare"].get(l, 0) for l in labels) > th)


def paint_views(D, keys):
    return sum(1 for im in D.values() if sum(im.get("markingPaint", {}).get(k, 0) for k in keys) > PAINT_IN_VIEW)


def need(n50, nviews):
    return math.ceil(n50 / 50 * nviews)


def close(a, b, tol=15):
    return a is not None and b is not None and max(abs(x - y) for x, y in zip(a, b)) <= tol


def criteria(G, V, guard_allow=None):
    """Every measurable "Fixed when" of the gap table. Each check: (gap, text, game value, street view value, pass)."""
    n = len(G)
    pct = lambda x: f"{x * 100:.1f} %"
    rgb = lambda c: "n/a" if c is None else ",".join(map(str, c))
    out = {}
    s = share(G, "vehicle"); cv, cs = views(G, ["Car"]), views(V, ["Car"])
    out[1] = [("vehicle share 4-5 %", pct(s), pct(share(V, "vehicle")), 0.04 <= s <= 0.05),
              (f"cars in {need(25, n)}+ of {n} views", cv, cs, cv >= need(25, n)),
              ("(info) motorbikes in views", views(G, ["Motorcycle"]), views(V, ["Motorcycle"]), None)]
    lv, ls = views(G, ["Lane Marking - General"]), views(V, ["Lane Marking - General"])
    yv, yvs = paint_views(G, ("roadYellow",)), paint_views(V, ("roadYellow",))
    yc, ycs = paint_views(G, ("roadYellowCentre",)), paint_views(V, ("roadYellowCentre",))
    gv, gvs = paint_views(G, ("roadGreen",)), paint_views(V, ("roadGreen",))
    pv = lambda D, ks: "/".join(str(paint_views(D, (k,))) for k in ks)
    ln = math.ceil(MARKING_PROP * ls)
    out[2] = [(f"lane markings in {ln}+ of {n} views (35/41 of SV)", lv, ls, lv >= ln),
              ("views with green road paint = 0", gv, gvs, gv == 0),
              ("views with yellow road paint <= Street View", yv, yvs, yv <= yvs),
              ("views with yellow in centre band <= SV", yc, ycs, yc <= ycs),
              ("(info) views w/ yellow/green/red road paint", pv(G, ("roadYellow", "roadGreen", "roadRed")),
               pv(V, ("roadYellow", "roadGreen", "roadRed")), None),
              ("(info) same, lane-marking pixels only", pv(G, ("yellow", "green", "red")), pv(V, ("yellow", "green", "red")), None),
              ("(info) crosswalks in views", views(G, ["Lane Marking - Crosswalk"]), views(V, ["Lane Marking - Crosswalk"]), None)]
    out[3] = [(f"{g} median colour within 15 RGB", rgb(color(G, g)), rgb(color(V, g)), close(color(G, g), color(V, g)))
              for g in ("road", "sidewalk")]
    fv, fs = views(G, ["Fence"]), views(V, ["Fence"])
    out[4] = [(f"fence (railings) in {need(20, n)}+ of {n} views", fv, fs, fv >= need(20, n))]
    s, sf = share(G, "street furniture"), share(V, "street furniture")
    lo, hi = sf * FURN_BAND[0], sf * FURN_BAND[1]
    tv, ts = views(G, SIGN_LABELS), views(V, SIGN_LABELS)
    tn = math.ceil(SIGN_PROP * ts)
    out[5] = [(f"street furniture share {lo * 100:.1f}-{hi * 100:.1f} % (SV x 2/2.8-3/2.8)", pct(s), pct(sf), lo <= s <= hi),
              (f"traffic signs (front/back/frame) in {tn}+ of {n} (35/47 SV)", tv, ts, tv >= tn),
              ("(info) signs, front only", views(G, ["Traffic Sign (Front)"]), views(V, ["Traffic Sign (Front)"]), None),
              ("(check by eye) game views counted as signs", ",".join(k[:-4] for k, im in G.items()
               if sum(im["classShare"].get(l, 0) for l in SIGN_LABELS) > IN_VIEW) or "-", "", None),
              ("(info) bins in views", views(G, ["Trash Can"]), views(V, ["Trash Can"]), None)]
    s = share(G, "vegetation")
    out[6] = [("vegetation share 9-11 %", pct(s), pct(share(V, "vegetation")), 0.09 <= s <= 0.11),
              ("vegetation median colour within 15 RGB", rgb(color(G, "vegetation")), rgb(color(V, "vegetation")),
               close(color(G, "vegetation"), color(V, "vegetation")))]
    s = share(G, "sidewalk")
    out[7] = [("sidewalk share <= 8 %", pct(s), pct(share(V, "sidewalk")), s <= 0.08)]
    pv, ps = views(G, ["Person"]), views(V, ["Person"])
    out[10] = [(f"people in {need(15, n)}+ of {n} views", pv, ps, pv >= need(15, n))]
    guard = []
    for g in ("sky", "road", "building"):
        a, b = share(G, g), share(V, g)
        allow = max(0.10, (guard_allow or {}).get(g, -1) + 0.005)  # baseline deviation + 0.5 % for rounding
        guard.append((f"{g} within {allow * 100:.1f} % of Street View", pct(a), pct(b), b > 0 and abs(a / b - 1) <= allow + 1e-9))
    out["guard"] = guard
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--sv", required=True)
    ap.add_argument("--set", default="main")
    ap.add_argument("--only", default="")
    ap.add_argument("--criteria", default="", help="gap numbers, e.g. 1,5 (the regression guard is always shown)")
    ap.add_argument("--json", default="")
    ap.add_argument("--baseline", default=os.path.join(ROOT, "docs", "fidelity-baseline.json"),
                    help="baseline numbers: the guard allows max(10 %%, the baseline's deviation) per group")
    a = ap.parse_args()
    G, V = load(a.game), load(a.sv)
    ug, uv = json.load(open(a.game)).get("uiMask"), json.load(open(a.sv)).get("uiMask")
    if bool(ug) != bool(uv):
        print(f"WARNING: Google UI mask applied to {'game' if ug else 'Street View'} only; re-run seg.py with --uimask "
              "on both (run.mjs does this)", file=sys.stderr)
    ids = sorted(set(G) & set(V))
    if a.only:
        keep = {i if i.endswith(".png") else i + ".png" for i in a.only.split(",")}
        ids = [i for i in ids if i in keep]
    missing = sorted(set(V) - set(G))
    if missing and not a.only:
        print(f"warning: {len(missing)} Street View images have no game render: {', '.join(missing[:10])}", file=sys.stderr)
    G, V = {i: G[i] for i in ids}, {i: V[i] for i in ids}
    if not ids:
        sys.exit("no matching images")

    print(f"\n== set '{a.set}': {len(ids)} views ==\n")
    print(f"{'Category':28} {'Game/SV':>8} {'Game':>8} {'SV':>8}")
    shares = {}
    for g in GROUPS:
        gs, vs = share(G, g), share(V, g)
        shares[g] = {"game": round(gs * 100, 2), "sv": round(vs * 100, 2)}
        print(f"{LABEL[g]:28} {(gs / vs * 100 if vs else float('nan')):7.0f}% {gs * 100:7.1f}% {vs * 100:7.1f}%")
    print(f"\n{'Median colour':28} {'Game':>14} {'SV':>14}")
    colors = {}
    for g, name in COLOR_GROUPS.items():
        c1, c2 = color(G, g), color(V, g)
        colors[g] = {"game": c1, "sv": c2}
        print(f"{name:28} {str(c1):>14} {str(c2):>14}")

    allow = None
    if a.baseline and os.path.exists(a.baseline) and not a.only:
        b = json.load(open(a.baseline)).get("sets", {}).get(a.set, {}).get("guardDeviation")
        allow = b
    C = criteria(G, V, allow)
    want = [int(x) for x in a.criteria.split(",") if x] if a.criteria else [k for k in C if k != "guard"]
    print(f"\n{'Gap':4} {'Fixed when':58} {'Game':>12} {'SV':>12}  Result")
    res = {}
    for k in want + ["guard"]:
        rows = []
        for text, gv, sv, ok in C[k]:
            r = "" if ok is None else ("PASS" if ok else "FAIL")
            print(f"{('#' + str(k)) if k != 'guard' else 'grd':4} {text:58} {str(gv):>12} {str(sv):>12}  {r}")
            rows.append({"check": text, "game": gv, "sv": sv, "pass": ok})
        res[str(k)] = {"rows": rows, "pass": all(r["pass"] for r in rows if r["pass"] is not None)}
    if not want or 5 in want:
        print("\nnote #5: Mask2Former labels some game objects as traffic signs (the green glass igloo in main 22; at "
              "baseline a red barrier in 09 and a kerb corner in 32, none of them signs). Open masks/ and renders/ of the "
              "views listed above before trusting the sign count.")
    print("\nsummary: " + "  ".join(f"{'#' + k if k != 'guard' else 'guard'} {'PASS' if v['pass'] else 'FAIL'}"
                                    for k, v in res.items()))
    if a.json:
        with open(a.json, "w") as f:
            json.dump({"set": a.set, "views": len(ids), "uiMask": {"game": ug, "sv": uv}, "inViewThreshold": IN_VIEW, "paintThreshold": PAINT_IN_VIEW,
                       "groupSharePct": shares, "medianColor": colors, "criteria": res}, f, indent=1, default=str)


if __name__ == "__main__":
    main()
