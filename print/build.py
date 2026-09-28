"""Print prep: extend the canvas from real pixels, add bleed, set ppi, write lossless TIFFs.

Usage: python3 print/build.py <print.json>

Steps (all optional except the cut):
1. extend  - widen/heighten the canvas by copying a strip from `period` px inward (so a
             repeating pattern continues; nothing is mirrored), registered along the seam,
             evened out row by row for brightness, and blended over `blend` px.
2. label   - draw a text label at a position given as a fraction of the canvas.
3. prints  - for each sheet: the largest centred trim of the sheet's aspect that still
             leaves room for the bleed, cut with bleed, optionally resampled to an exact
             ppi, saved as deflate TIFF with the source ICC profile and ppi metadata.
The input file is never modified. Paths are relative to the config file.
"""

import hashlib
import json
import pathlib
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

Image.MAX_IMAGE_PIXELS = None


def lum(x):
    x = x.astype(np.float32)
    return x[..., 0] * 0.299 + x[..., 1] * 0.587 + x[..., 2] * 0.114


def best_shift(a, seam, src, search):
    """Vertical offset (px) that best lines the copied strip `src` (cols) up with `seam` (cols)."""
    h = a.shape[0]
    lo, hi = search, h - search
    if hi - lo < 16:
        return 0
    o = lum(a[lo:hi, seam[0] : seam[1]])
    best = (None, 0)
    for dy in range(-search, search + 1):
        s = lum(a[lo - dy : hi - dy, src[0] : src[1]])
        e = float(np.abs(o - s).mean())
        if best[0] is None or e < best[0]:
            best = (e, dy)
    return best[1]


def row_offset(orig, fill, smooth=151):
    d = (orig.astype(np.float32) - fill).mean(1)
    k = np.ones(smooth) / smooth
    pad = smooth // 2
    return np.stack([np.convolve(np.pad(d[:, c], pad, mode="edge"), k, "valid") for c in range(3)], 1)[:, None, :]


def extend_left(a, width, period=None, blend=160, search=40):
    """Return `a` with `width` new columns on the left, continued from real pixels."""
    if width <= 0:
        return a
    h, w, _ = a.shape
    period = period or width
    blend = min(blend, w - period)
    if period < width or period + blend > w:
        raise ValueError(f"extend: need width <= period and period + blend <= image width ({width}, {period}, {blend}, {w})")
    dy = best_shift(a, (0, blend), (period, period + blend), search)
    rows = np.clip(np.arange(h) - dy, 0, h - 1)
    fill = a[rows, period - width : period + blend].astype(np.float32)
    fill += row_offset(a[:, :blend], fill[:, width:])
    out = np.empty((h, w + width, 3), np.uint8)
    out[:, width:] = a
    out[:, :width] = np.round(fill[:, :width]).clip(0, 255)
    t = np.linspace(0, 1, blend, dtype=np.float32)[None, :, None]
    out[:, width : width + blend] = np.round(fill[:, width:] * (1 - t) + a[:, :blend] * t).clip(0, 255)
    return out


def extend(a, cfg):
    """cfg: {left,right,top,bottom: px, period: {side: px}, blend, search}."""
    period = cfg.get("period", {}) or {}
    kw = {"blend": cfg.get("blend", 160), "search": cfg.get("search", 40)}
    a = extend_left(a, cfg.get("left", 0), period.get("left"), **kw)
    a = extend_left(a[:, ::-1], cfg.get("right", 0), period.get("right"), **kw)[:, ::-1]
    t = np.ascontiguousarray(a.transpose(1, 0, 2))
    t = extend_left(t, cfg.get("top", 0), period.get("top"), **kw)
    t = extend_left(t[:, ::-1], cfg.get("bottom", 0), period.get("bottom"), **kw)[:, ::-1]
    return np.ascontiguousarray(t.transpose(1, 0, 2))


def trim_box(img_w, img_h, sheet_w, sheet_h, bleed_in, offset=(0.5, 0.5)):
    """Largest trim of the sheet's aspect with bleed room, placed by `offset` (0..1).
    Returns dict(trim=(x, y, w, h), bleed_px, ppi, box=(x0, y0, x1, y1))."""
    tw = min(img_w / (1 + 2 * bleed_in / sheet_w), img_h * sheet_w / (sheet_h + 2 * bleed_in))
    tw = int(tw)
    th = int(round(tw * sheet_h / sheet_w))
    ppi = tw / sheet_w
    b = int(round(ppi * bleed_in))
    while tw + 2 * b > img_w or th + 2 * b > img_h:
        tw -= 1
        th = int(round(tw * sheet_h / sheet_w))
        ppi = tw / sheet_w
        b = int(round(ppi * bleed_in))
    x = b + int(round((img_w - tw - 2 * b) * offset[0]))
    y = b + int(round((img_h - th - 2 * b) * offset[1]))
    return {"trim": (x, y, tw, th), "bleed_px": b, "ppi": ppi, "box": (x - b, y - b, x + tw + b, y + th + b)}


def draw_label(im, cfg):
    d = ImageDraw.Draw(im)
    size = int(cfg.get("sizePx", max(12, im.height // 40)))
    try:
        font = ImageFont.truetype(cfg["font"], size) if cfg.get("font") else ImageFont.load_default(size)
    except (OSError, TypeError):
        font = ImageFont.load_default()
    xy = (cfg.get("x", 0.5) * im.width, cfg.get("y", 0.05) * im.height)
    d.text(xy, cfg["text"], fill=tuple(cfg.get("color", [255, 255, 255])), font=font, anchor=cfg.get("anchor", "mm"))
    return im


def cut(full, icc, spec, out_dir):
    sw, sh = spec["sheetInches"]
    bleed = spec.get("bleedInches", 0.125)
    g = trim_box(full.width, full.height, sw, sh, bleed, tuple(spec.get("offset", (0.5, 0.5))))
    im = full.crop(g["box"])
    ppi = g["ppi"]
    if spec.get("ppi"):
        ppi = float(spec["ppi"])
        size = (round((sw + 2 * bleed) * ppi), round((sh + 2 * bleed) * ppi))
        im = im.resize(size, Image.LANCZOS)
        g["bleed_px"] = int(round(bleed * ppi))
    path = out_dir / f"{spec['name']}.tif"
    im.save(path, compression="tiff_adobe_deflate", icc_profile=icc, dpi=(round(ppi, 3),) * 2)
    info = {
        "file": path.name,
        "sheetInches": [sw, sh],
        "bleedInches": bleed,
        "bleedPx": g["bleed_px"],
        "ppi": round(ppi, 1),
        "pixels": list(im.size),
        "boxInCanvas": list(g["box"]),
        "resampled": bool(spec.get("ppi")),
    }
    if spec.get("minPpi") and ppi < spec["minPpi"]:
        info["warning"] = f"ppi {ppi:.0f} is below minPpi {spec['minPpi']}"
    print(info, flush=True)
    return info


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cfg_path = pathlib.Path(sys.argv[1]).resolve()
    cfg = json.loads(cfg_path.read_text())
    src_path = (cfg_path.parent / cfg["input"]).resolve()
    out_dir = (cfg_path.parent / cfg.get("outputDir", "print_out")).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    src = Image.open(src_path)
    icc = src.info.get("icc_profile")
    a = np.array(src.convert("RGB"))
    print("loaded", a.shape[1], a.shape[0], flush=True)
    if cfg.get("extend"):
        a = extend(a, cfg["extend"])
        print("extended to", a.shape[1], a.shape[0], flush=True)
    full = Image.fromarray(a)
    if cfg.get("label", {}).get("text"):
        full = draw_label(full, cfg["label"])
    if cfg.get("saveCanvas", True):
        full.save(out_dir / "canvas.tif", compression="tiff_adobe_deflate", icc_profile=icc)
    prints = [cut(full, icc, spec, out_dir) for spec in cfg.get("prints", [])]
    sha = hashlib.sha256(src_path.read_bytes()).hexdigest()
    report = {"input": src_path.name, "inputSha256": sha, "canvas": list(full.size), "extend": cfg.get("extend"), "prints": prints}
    (out_dir / "build.json").write_text(json.dumps(report, indent=1) + "\n")
    print("done", flush=True)


if __name__ == "__main__":
    main()
