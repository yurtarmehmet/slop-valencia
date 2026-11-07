#!/usr/bin/env python3
"""Semantic segmentation stats for street-level images (Street View vs game screenshots).

Ported from the session that produced docs/fidelity-gaps.md; the model, groups, crop and resize are unchanged, so
its numbers reproduce. Run it with the venv at .cache/segenv (see README.md).

usage: python seg.py <input_dir> <out.json> [--crop top,bottom,left,right] [--overlay] [--masks]
                     [--only 01,02] [--model NAME] [--device mps|cpu] [--long 1280]

Default crop = the doc's (top 0, bottom 0.18, left 0.28, right 0.13 of a 1280x720 frame: clear of the Street View
controls), resized to 1280 px wide (1280x999).

Per image: classShare (fine label -> pixel fraction), classColor (median sRGB for
classes > 1%), groupShare (coarse groups), groupColor. Crop fractions are removed
from each edge BEFORE resizing to --long px on the long side.
"""
import argparse, json, os, sys, time
import numpy as np
import torch
from PIL import Image, ImageDraw
import warnings; warnings.filterwarnings("ignore")
from transformers.utils import logging as _hl; _hl.set_verbosity_error()

DEFAULT_MODEL = "facebook/mask2former-swin-large-mapillary-vistas-semantic"

# Coarse groups. Keys are lowercase fine labels (Mapillary Vistas v1.2, 65 classes;
# Cityscapes names included so the segformer fallback maps too).
GROUPS = {
    "sky": ["sky"],
    "building": ["building", "wall", "fence", "bridge", "tunnel"],
    "vegetation": ["vegetation", "terrain"],
    "road": ["road", "lane marking - general", "lane marking - crosswalk", "crosswalk - plain",
             "manhole", "pothole", "bike lane", "service lane", "parking", "rail track"],
    "sidewalk": ["sidewalk", "curb", "pedestrian area", "curb cut"],
    "person": ["person", "bicyclist", "motorcyclist", "other rider", "rider"],
    "vehicle": ["car", "bus", "truck", "motorcycle", "bicycle", "other vehicle", "trailer",
                "caravan", "boat", "on rails", "train", "wheeled slow"],
    "street furniture": ["pole", "street light", "traffic light", "traffic sign (front)",
                         "traffic sign (back)", "traffic sign frame", "traffic sign",
                         "utility pole", "bench", "bike rack", "billboard", "fire hydrant",
                         "junction box", "mailbox", "phone booth", "trash can", "banner",
                         "catch basin", "cctv camera", "signage"],
}
GROUP_ORDER = list(GROUPS) + ["other"]
LABEL_TO_GROUP = {l: g for g, ls in GROUPS.items() for l in ls}


ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))


class DirLock:
    """The machine-wide lock protocol of tools/realism/shot.mjs: a directory holding the owner's pid; a lock whose
    owner is gone is taken over. gpu.lock is shared with the renderers (held per batch of images, so fps measurements
    stay fair); seg.lock keeps a single segmenter in memory at a time."""

    def __init__(self, name):
        self.path = os.path.join(ROOT, ".cache", name)

    @staticmethod
    def _alive(pid):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            pass
        return True

    def _my_turn(self):
        live = []
        for t in sorted(os.listdir(self.queue)):
            try:
                pid = int(t.split("-")[1])
            except (IndexError, ValueError):
                continue
            if self._alive(pid):
                live.append(t)
            else:
                try: os.remove(os.path.join(self.queue, t))
                except OSError: pass
        return bool(live) and live[0] == os.path.basename(self.ticket)

    def __enter__(self):
        # first-come first-served: a ticket <ms>-<pid> in <name>.queue/, lock taken only by the oldest live ticket
        self.queue = self.path + ".queue"
        os.makedirs(self.queue, exist_ok=True)
        self.ticket = os.path.join(self.queue, f"{int(time.time() * 1000):015d}-{os.getpid()}")
        open(self.ticket, "w").close()
        waited = 0.0
        while True:
            if self._my_turn():
                try:
                    os.mkdir(self.path)
                    with open(os.path.join(self.path, "pid"), "w") as f:
                        f.write(str(os.getpid()))
                    try: os.remove(self.ticket)
                    except OSError: pass
                    return self
                except FileExistsError:
                    owner = 0
                    try:
                        owner = int(open(os.path.join(self.path, "pid")).read() or 0)
                    except (OSError, ValueError):
                        pass
                    if owner and not self._alive(owner):
                        import shutil; shutil.rmtree(self.path, ignore_errors=True); continue
            if waited % 60 == 0:
                print(f"waiting for {os.path.basename(self.path)} ({len(os.listdir(self.queue))} queued), {waited:.0f}s", file=sys.stderr)
            time.sleep(0.5); waited += 0.5

    def __exit__(self, *exc):
        try:
            if int(open(os.path.join(self.path, "pid")).read()) == os.getpid():
                import shutil; shutil.rmtree(self.path, ignore_errors=True)
        except (OSError, ValueError):
            pass


def group_of(label):
    return LABEL_TO_GROUP.get(label.lower(), "other")


def palette(n, seed=7):
    rng = np.random.default_rng(seed)
    p = rng.integers(40, 256, size=(n, 3), dtype=np.uint8)
    return p


GROUP_COLORS = {"sky": (70, 130, 230), "building": (200, 70, 60), "vegetation": (60, 170, 50),
                "road": (110, 110, 110), "sidewalk": (230, 200, 60), "person": (255, 0, 200),
                "vehicle": (0, 220, 230), "street furniture": (255, 120, 0), "other": (20, 20, 20)}


class Segmenter:
    def __init__(self, model_name, device, long_side):
        from transformers import AutoImageProcessor
        self.device = device
        self.long = long_side
        self.name = model_name
        self.proc = AutoImageProcessor.from_pretrained(model_name)
        if "mask2former" in model_name:
            from transformers import Mask2FormerForUniversalSegmentation as M
            self.kind = "m2f"
        else:
            from transformers import SegformerForSemanticSegmentation as M
            self.kind = "segformer"
        self.model = M.from_pretrained(model_name).to(device).eval()
        self.id2label = {int(k): v for k, v in self.model.config.id2label.items()}

    @torch.no_grad()
    def __call__(self, img):
        w, h = img.size
        # Feed at native (already resized) resolution; the default 384x384 squash
        # in the hub config destroys small street furniture.
        if self.kind == "m2f":
            inp = self.proc(images=img, do_resize=False, return_tensors="pt")
        else:
            inp = self.proc(images=img, size={"height": h, "width": w}, return_tensors="pt")
        inp = {k: v.to(self.device) for k, v in inp.items() if torch.is_tensor(v)}
        out = self.model(**inp)
        seg = self.proc.post_process_semantic_segmentation(out, target_sizes=[(h, w)])[0]
        return seg.to("cpu").numpy().astype(np.int32)


def load(path, crop, long_side):
    img = Image.open(path).convert("RGB")
    W, H = img.size
    t, b, l, r = crop
    box = (round(W * l), round(H * t), round(W * (1 - r)), round(H * (1 - b)))
    img = img.crop(box)
    w, h = img.size
    s = long_side / max(w, h)
    return img.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)


MARKING_LABELS = ("lane marking - general", "lane marking - crosswalk")
ROAD_PAINT_LABELS = MARKING_LABELS + ("road", "bike lane", "service lane", "parking", "crosswalk - plain")


def _hue_classes(p):
    """p: (n,3) sRGB 0..1 -> boolean masks yellow, green, red (saturation >= 0.35, value >= 0.25;
    hue yellow 35-70 deg, green 75-170, red < 15 or > 340)."""
    mx, mn = p.max(1), p.min(1)
    d = mx - mn
    sat = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    r, g, b = p[:, 0], p[:, 1], p[:, 2]
    dd = np.maximum(d, 1e-6)
    h = np.where(mx == r, ((g - b) / dd) % 6, np.where(mx == g, (b - r) / dd + 2, (r - g) / dd + 4)) * 60
    col = (sat >= 0.35) & (mx >= 0.25)
    return col & (h >= 35) & (h <= 70), col & (h >= 75) & (h <= 170), col & ((h < 15) | (h > 340))


CENTRE_BAND = (0.40, 0.60)  # of the uncropped frame width: where a centre line runs when looking along the street


def marking_paint(seg, rgb, id2label, crop=(0, 0.18, 0.28, 0.13)):
    """Paint colour. yellow/green/red: lane-marking pixels of that hue; roadYellow/roadGreen/roadRed: the same over
    every road-surface pixel (road, markings, bike lane, parking...), which also catches painted surfaces such as
    green bike lanes that segment as road. roadYellowCentre: yellow road-surface pixels in the central band of the
    view (CENTRE_BAND of the uncropped width), a proxy for yellow centre lines; kerb-side yellow lines fall outside
    it. All are fractions of the whole (cropped) frame, UI pixels excluded."""
    n = int((seg != UI).sum())
    out = {}
    _, _, l, r = crop
    w = seg.shape[1]
    x0 = int(round((CENTRE_BAND[0] - l) / (1 - l - r) * w))
    x1 = int(round((CENTRE_BAND[1] - l) / (1 - l - r) * w))
    ids = [i for i, lab in id2label.items() if lab.lower() in ROAD_PAINT_LABELS]
    mc = np.zeros(seg.shape, bool)
    mc[:, max(0, x0):min(w, x1)] = True
    mc &= np.isin(seg, ids)
    out["roadYellowCentre"] = (round(float(_hue_classes(rgb[mc].astype(np.float32) / 255)[0].sum()) / n, 6)
                               if mc.any() else 0.0)
    for key, labels in (("", MARKING_LABELS), ("road", ROAD_PAINT_LABELS)):
        ids = [i for i, l in id2label.items() if l.lower() in labels]
        m = np.isin(seg, ids)
        if key == "":
            out["marking"] = round(float(m.sum()) / n, 6)
        names = [key + c if key else c.lower() for c in ("Yellow", "Green", "Red")]
        if not m.any():
            out.update({k: 0.0 for k in names})
            continue
        p = rgb[m].astype(np.float32) / 255
        for k, mk in zip(names, _hue_classes(p)):
            out[k] = round(float(mk.sum()) / n, 6)
        if key == "":
            out["color"] = [int(v) for v in np.median(rgb[m], axis=0)]
    return out


UI = 255  # label of pixels masked as Google UI (excluded from every share and colour)


def ui_mask(mask_dir, f, crop, size):
    """The view's Google UI mask (svmask.py, 1280x720, 255 = UI), cropped and resized like the image; None if none."""
    if not mask_dir:
        return None
    p = os.path.join(mask_dir, os.path.splitext(f)[0] + ".png")
    if not os.path.exists(p):
        return None
    m = Image.open(p).convert("L")
    W, H = m.size
    t, b, l, r = crop
    m = m.crop((round(W * l), round(H * t), round(W * (1 - r)), round(H * (1 - b)))).resize(size, Image.NEAREST)
    return np.asarray(m) > 127


def stats(seg, rgb, id2label):
    n = int((seg != UI).sum())
    ids, counts = np.unique(seg, return_counts=True)
    share, color, gshare, gpix = {}, {}, {g: 0.0 for g in GROUP_ORDER}, {g: [] for g in GROUP_ORDER}
    for i, c in sorted(zip(ids, counts), key=lambda x: -x[1]):
        if i == UI:
            continue
        lab = id2label.get(int(i), str(i))
        f = c / n
        share[lab] = round(float(f), 5)
        g = group_of(lab)
        gshare[g] += f
        m = seg == i
        if f > 0.01:
            color[lab] = [int(v) for v in np.median(rgb[m], axis=0)]
        gpix[g].append(m)
    gcolor = {}
    for g, ms in gpix.items():
        if gshare[g] > 0.01:
            m = np.logical_or.reduce(ms)
            gcolor[g] = [int(v) for v in np.median(rgb[m], axis=0)]
    gshare = {g: round(float(v), 5) for g, v in gshare.items()}
    return share, color, gshare, gcolor


def save_overlay(path, img, seg, id2label, share):
    rgb = np.asarray(img)
    pal = palette(max(id2label) + 2)
    fine = pal[seg]
    grp = np.zeros_like(rgb)
    for i, lab in id2label.items():
        grp[seg == i] = GROUP_COLORS[group_of(lab)]
    blend = (0.45 * rgb + 0.55 * fine).astype(np.uint8)
    h, w = seg.shape
    # top: photo | fine-class blend ; bottom: coarse groups | legend
    canvas = Image.new("RGB", (w * 2, h * 2), (255, 255, 255))
    canvas.paste(img, (0, 0))
    canvas.paste(Image.fromarray(blend), (w, 0))
    canvas.paste(Image.fromarray(grp), (0, h))
    d = ImageDraw.Draw(canvas)
    y = h + 10
    for g in GROUP_ORDER:
        d.rectangle([w + 10, y, w + 30, y + 16], fill=GROUP_COLORS[g])
        d.text((w + 38, y + 2), f"[group] {g}", fill=(0, 0, 0))
        y += 20
    y += 10
    lab2id = {v: k for k, v in id2label.items()}
    for lab, f in share.items():
        if f < 0.003 or y > 2 * h - 20:
            continue
        d.rectangle([w + 10, y, w + 30, y + 16], fill=tuple(int(x) for x in pal[lab2id[lab]]))
        d.text((w + 38, y + 2), f"{lab}  {f*100:.1f}%  ({group_of(lab)})", fill=(0, 0, 0))
        y += 20
    canvas.save(path)


def restat(json_path, input_dir, mask_dir=None):
    """Recompute every per-image statistic of an existing seg.json from its masks/ (no model needed), optionally
    excluding the Google UI pixels of mask_dir."""
    from transformers import AutoConfig
    with open(json_path) as fh:
        res = json.load(fh)
    id2label = {int(k): v for k, v in AutoConfig.from_pretrained(res["model"]).id2label.items()}
    mdir = os.path.join(os.path.dirname(os.path.abspath(json_path)), "masks")
    res["uiMask"] = os.path.relpath(mask_dir, ROOT) if mask_dir else None
    for f in list(res["images"]):
        seg = np.asarray(Image.open(os.path.join(mdir, os.path.splitext(f)[0] + ".png"))).astype(np.int32)
        img = load(os.path.join(input_dir, f), res["crop"], res["longSide"])
        res["images"][f] = describe(seg, img, id2label, res["crop"], ui_mask(mask_dir, f, res["crop"], img.size),
                                    res["images"][f].get("seconds"))
    with open(json_path, "w") as fh:
        json.dump(res, fh, indent=1)
    print("restat", json_path, len(res["images"]), "uimask", mask_dir, file=sys.stderr)


def describe(seg, img, id2label, crop, ui, seconds=None):
    seg = seg.copy()
    if ui is not None:
        seg[ui] = UI
    rgb = np.asarray(img)
    share, color, gshare, gcolor = stats(seg, rgb, id2label)
    return {"size": list(img.size), "seconds": seconds, "uiMasked": round(float(ui.mean()), 5) if ui is not None else 0.0,
            "groupShare": gshare, "groupColor": gcolor, "classShare": share, "classColor": color,
            "markingPaint": marking_paint(seg, rgb, id2label, crop)}


def main():
    if len(sys.argv) in (4, 5) and sys.argv[1] == "--restat":
        return restat(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) == 5 else None)
    ap = argparse.ArgumentParser()
    ap.add_argument("input_dir")
    ap.add_argument("out_json")
    ap.add_argument("--crop", default="0,0.18,0.28,0.13", help="top,bottom,left,right fractions to cut away")
    ap.add_argument("--only", default="", help="comma-separated image ids (file stems) to segment")
    ap.add_argument("--masks", action="store_true", help="write label-id PNGs to <out_dir>/masks/")
    ap.add_argument("--uimask", default="", help="dir of Google UI masks (<id>.png): those pixels are excluded")
    ap.add_argument("--overlay", action="store_true", help="write overlays to <out_dir>/overlays/")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--device", default="mps" if torch.backends.mps.is_available() else "cpu")
    ap.add_argument("--long", type=int, default=1280)
    ap.add_argument("--no-lock", action="store_true", help="don't take .cache/seg.lock and .cache/gpu.lock")
    ap.add_argument("--batch", type=int, default=10, help="images per gpu.lock hold")
    a = ap.parse_args()
    if a.no_lock:
        run(a)
    else:
        with DirLock("seg.lock"):
            run(a)


def run(a):
    crop = [float(x) for x in a.crop.split(",")]
    assert len(crop) == 4 and all(0 <= c < 1 for c in crop)

    files = sorted(f for f in os.listdir(a.input_dir) if f.lower().endswith((".png", ".jpg", ".jpeg")))
    if a.only:
        keep = set(a.only.split(","))
        files = [f for f in files if os.path.splitext(f)[0] in keep]
    if not files:
        sys.exit("no images in " + a.input_dir)
    import contextlib
    gpu = (lambda: contextlib.nullcontext()) if a.no_lock else (lambda: DirLock("gpu.lock"))
    t0 = time.time()
    with gpu():
        S = Segmenter(a.model, a.device, a.long)
        S(Image.new("RGB", (a.long, a.long * 9 // 16), (128, 128, 128)))  # warm-up (MPS kernel compile)
    print(f"model {a.model} on {a.device} loaded+warmed in {time.time()-t0:.1f}s", file=sys.stderr)
    print("label -> group mapping:", file=sys.stderr)
    for g in GROUP_ORDER:
        print(f"  {g}: " + ", ".join(l for l in S.id2label.values() if group_of(l) == g), file=sys.stderr)

    ovdir = os.path.join(os.path.dirname(os.path.abspath(a.out_json)), "overlays")
    if a.overlay:
        os.makedirs(ovdir, exist_ok=True)
    mkdir = os.path.join(os.path.dirname(os.path.abspath(a.out_json)), "masks")
    if a.masks:
        os.makedirs(mkdir, exist_ok=True)
    result = {"model": a.model, "device": a.device, "crop": crop, "longSide": a.long,
              "groupMapping": {g: [l for l in S.id2label.values() if group_of(l) == g] for g in GROUP_ORDER},
              "uiMask": os.path.relpath(a.uimask, ROOT) if a.uimask else None, "images": {}}
    lock, held = None, 0
    for f in files:
        if lock is None:
            lock = gpu(); lock.__enter__()
        img = load(os.path.join(a.input_dir, f), crop, a.long)
        t = time.time()
        seg = S(img)
        if a.device == "mps":
            torch.mps.synchronize()
        dt = time.time() - t
        held += 1
        if held >= a.batch:
            lock.__exit__(None, None, None); lock, held = None, 0
        result["images"][f] = describe(seg, img, S.id2label, crop, ui_mask(a.uimask, f, crop, img.size), round(dt, 2))
        gshare = result["images"][f]["groupShare"]
        if a.masks:
            Image.fromarray(seg.astype(np.uint8)).save(os.path.join(mkdir, os.path.splitext(f)[0] + ".png"))
        print(f"{f} {img.size[0]}x{img.size[1]} {dt:.2f}s  " +
              " ".join(f"{g}={v*100:.1f}%" for g, v in gshare.items()), file=sys.stderr)
        if a.overlay:
            save_overlay(os.path.join(ovdir, os.path.splitext(f)[0] + "_seg.png"), img, seg, S.id2label,
                         result["images"][f]["classShare"])
    if lock is not None:
        lock.__exit__(None, None, None)
    with open(a.out_json, "w") as fh:
        json.dump(result, fh, indent=1)


if __name__ == "__main__":
    main()
