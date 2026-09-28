"""Chromatic-aberration fix + edge defringe.

Usage: python3 fix_ca.py <input> <output>

1. Channel alignment: searches radial scale factors 0.9985..1.0015 for the red and blue
   channels against green, keeping the one that minimises the gradient of their difference.
2. Defringe: reduces chroma around strong luminance edges (up to 55%), suppressing
   purple/green outlines. An image-based approximation, not a calibrated lens correction.
"""

import sys

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def scale_about_center(ch, s):
    h, w = ch.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    cy, cx = (h - 1) / 2.0, (w - 1) / 2.0
    sy = (yy - cy) / s + cy
    sx = (xx - cx) / s + cx
    y0 = np.clip(np.floor(sy), 0, h - 1).astype(np.int32)
    y1 = np.clip(y0 + 1, 0, h - 1)
    x0 = np.clip(np.floor(sx), 0, w - 1).astype(np.int32)
    x1 = np.clip(x0 + 1, 0, w - 1)
    fy = (sy - y0)[..., None].squeeze()
    fx = (sx - x0)[..., None].squeeze()
    return ch[y0, x0] * (1 - fy) * (1 - fx) + ch[y1, x0] * fy * (1 - fx) + ch[y0, x1] * (1 - fy) * fx + ch[y1, x1] * fy * fx


def grad_energy(a, b):
    # alignment cost between two channels: gradient of their difference
    d = a - b
    return np.abs(np.diff(d, axis=0)).mean() + np.abs(np.diff(d, axis=1)).mean()


def find_scale(ch, ref, lo=0.9985, hi=1.0015, n=31):
    cands = np.linspace(lo, hi, n)
    costs = [grad_energy(scale_about_center(ch, s), ref) for s in cands]
    k = int(np.argmin(costs))
    return float(cands[k]), costs[k], costs[len(cands) // 2]


def fix(a, verbose=True):
    """a: float32 HxWx3 in 0..1. Returns corrected array and the chosen scales."""
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    best = {}
    for name, ch in (("R", R), ("B", B)):
        s, c, c0 = find_scale(ch, G)
        best[name] = s
        if verbose:
            print(f"  {name} radial scale vs G: {s:.5f}  (cost {c:.6f} vs identity {c0:.6f})", flush=True)
    out = np.stack([scale_about_center(R, best["R"]), G, scale_about_center(B, best["B"])], axis=-1)
    # defringe: clamp chroma excursions on high-contrast edges
    lum = out.mean(axis=2, keepdims=True)
    chroma = out - lum
    gy = np.abs(np.gradient(lum[..., 0], axis=0))
    gx = np.abs(np.gradient(lum[..., 0], axis=1))
    edge = np.clip((gy + gx) * 6.0, 0, 1)[..., None]
    return lum + chroma * (1.0 - 0.55 * edge), best


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    a = np.asarray(Image.open(src).convert("RGB"), dtype=np.float32) / 255.0
    out, _ = fix(a)
    Image.fromarray(np.clip(out * 255 + 0.5, 0, 255).astype(np.uint8)).save(dst, quality=98, subsampling=0)
    print("wrote", dst, flush=True)


if __name__ == "__main__":
    main()
