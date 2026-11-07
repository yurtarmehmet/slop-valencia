#!/usr/bin/env python3
"""Build the Google UI masks from svmask.mjs's screenshots (see there).

usage: python svmask.py --set main [--stored .fidelity/sv] [--sheet out.jpg]
mask = pixels of the overlay-only shot (panorama skipped, canvas cleared to magenta) that are not magenta, dilated 3 px, as a 1280x720 PNG
(255 = Google UI). Also reports, per view, the masked fraction (whole frame and inside the analysis crop) and the
mean absolute difference between the fresh normal shot and the stored capture outside the mask (same pano check).
"""
import argparse, json, os
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
CROP = (0, 0.18, 0.28, 0.13)


def rgb(p):
    return np.asarray(Image.open(p).convert("RGB")).astype(np.int16)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default="main")
    ap.add_argument("--stored", default="")
    ap.add_argument("--sheet", default="")
    a = ap.parse_args()
    d = os.path.join(ROOT, ".fidelity", "uimask", a.set)
    stored = a.stored or os.path.join(ROOT, ".fidelity", "sv" if a.set == "main" else f"sv-{a.set}")
    ids = sorted({f.split("-")[0] for f in os.listdir(os.path.join(d, "raw")) if f.endswith("-n.png")})
    H, W = 720, 1280
    t, b, l, r = CROP
    crop = np.zeros((H, W), bool)
    crop[round(H * t):round(H * (1 - b)), round(W * l):round(W * (1 - r))] = True
    hand = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "handmasks.json"))).get(a.set, {})
    ids = sorted(set(ids) | set(hand))
    report, tiles = {}, []
    for i in ids:
        if i in hand:  # different pano served now: hand-drawn mask on the stored capture
            from PIL import ImageDraw
            hm = Image.new("L", (W, H), 0)
            dr = ImageDraw.Draw(hm)
            for x0, y0, x1, y1 in hand[i].get("rects", []):
                dr.rectangle([x0, y0, x1, y1], fill=255)
            for poly in hand[i].get("polys", []):
                dr.polygon([tuple(q) for q in poly], fill=255)
            m = np.asarray(hm) > 0
            Image.fromarray((m * 255).astype(np.uint8)).save(os.path.join(d, f"{i}.png"))
            s = rgb(os.path.join(stored, f"{i}.png"))
            report[i] = {"hand": hand[i]["why"], "maskedFrame": round(float(m.mean()), 4),
                         "maskedCrop": round(float(m[crop].mean()), 4)}
            if a.sheet:
                v = s.astype(np.uint8).copy()
                v[m] = (0.4 * v[m] + 0.6 * np.array([255, 0, 255])).astype(np.uint8)
                im = Image.fromarray(v).crop((round(W * l), 0, round(W * (1 - r)), round(H * (1 - b))))
                tiles.append((i, im.resize((im.width // 2, im.height // 2))))
            continue
        n = rgb(os.path.join(d, "raw", f"{i}-n.png"))
        ovs = [f for f in os.listdir(os.path.join(d, "raw")) if f.startswith(f"{i}-ov")]
        # the overlay-only shot: the one where the panorama vanished (most magenta inside the crop)
        mag = lambda x: np.abs(x - np.array([255, 0, 255])).max(2) <= 12
        black = {f: float(mag(rgb(os.path.join(d, "raw", f)))[crop].mean()) for f in ovs}
        best = max(black, key=black.get)
        ov = rgb(os.path.join(d, "raw", best))
        m = ~mag(ov)
        m = ndi.binary_dilation(m, iterations=3)
        Image.fromarray((m * 255).astype(np.uint8)).save(os.path.join(d, f"{i}.png"))
        s = rgb(os.path.join(stored, f"{i}.png"))
        keep = crop & ~m
        diff = float(np.abs(n - s).mean(2)[keep].mean())
        report[i] = {"overlayShot": best, "magentaInCrop": round(black[best], 3), "maskedFrame": round(float(m.mean()), 4), "maskedCrop": round(float(m[crop].mean()), 4),
                     "diffVsStored": round(diff, 2)}
        if a.sheet:
            v = s.astype(np.uint8).copy()
            v[m] = (0.4 * v[m] + 0.6 * np.array([255, 0, 255])).astype(np.uint8)
            im = Image.fromarray(v).crop((round(W * l), 0, round(W * (1 - r)), round(H * (1 - b))))
            tiles.append((i, im.resize((im.width // 2, im.height // 2))))
    with open(os.path.join(ROOT, ".fidelity", "uimask", f"{a.set}.json"), "w") as f:
        json.dump(report, f, indent=1)
    for i, v in report.items():
        print(i, v)
    if a.sheet and tiles:  # contact sheets of 12 (UI mask in magenta), <sheet>-1.jpg, -2.jpg...
        from PIL import ImageDraw
        tw, th = tiles[0][1].size
        cols, per = 4, 12
        for start in range(0, len(tiles), per):
            chunk = tiles[start:start + per]
            sheet = Image.new("RGB", (tw * cols, th * ((len(chunk) + cols - 1) // cols)))
            for k, (i, im) in enumerate(chunk):
                sheet.paste(im, ((k % cols) * tw, (k // cols) * th))
                ImageDraw.Draw(sheet).text(((k % cols) * tw + 30, (k // cols) * th + 4), i, fill=(255, 255, 0))
            sheet.save(f"{os.path.splitext(a.sheet)[0]}-{start // per + 1}.jpg", quality=85)


if __name__ == "__main__":
    main()
