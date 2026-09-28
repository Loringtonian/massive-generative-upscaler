"""Draw a synthetic test photograph (no real photos needed).

Usage: python3 tools/make_synthetic.py <out.png> [width=1600] [height=1000] [seed=7]

Gradients, overlapping shapes, thin lines, dot grids and fine noise give the feature
detector plenty to lock on to, the way real texture would.
"""

import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def make(width=1600, height=1000, seed=7):
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    base = np.stack(
        [
            90 + 60 * xx / width,
            80 + 50 * yy / height,
            120 + 40 * np.sin(xx / 97.0) * np.cos(yy / 131.0),
        ],
        axis=-1,
    )
    im = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))
    d = ImageDraw.Draw(im)
    for _ in range(int(width * height / 9000)):
        x, y = int(rng.integers(0, width)), int(rng.integers(0, height))
        r = int(rng.integers(6, 70))
        c = tuple(int(v) for v in rng.integers(20, 235, 3))
        kind = rng.integers(0, 4)
        if kind == 0:
            d.ellipse([x - r, y - r, x + r, y + r], fill=c, outline=(250, 250, 250))
        elif kind == 1:
            d.rectangle([x, y, x + r * 2, y + r], fill=c, outline=(10, 10, 10))
        elif kind == 2:
            d.line([x, y, x + int(rng.integers(-200, 200)), y + int(rng.integers(-200, 200))], fill=c, width=int(rng.integers(1, 5)))
        else:
            d.polygon([(x, y), (x + r, y + r // 2), (x + r // 3, y + r)], fill=c)
    for gx in range(40, width, 160):
        for gy in range(40, height, 160):
            for k in range(4):
                d.ellipse([gx + k * 9, gy, gx + k * 9 + 4, gy + 4], fill=(240, 240, 240))
    im = im.filter(ImageFilter.GaussianBlur(0.8))
    a = np.asarray(im).astype(np.float32) + rng.normal(0, 4, (height, width, 3))
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    w = int(sys.argv[2]) if len(sys.argv) > 2 else 1600
    h = int(sys.argv[3]) if len(sys.argv) > 3 else 1000
    seed = int(sys.argv[4]) if len(sys.argv) > 4 else 7
    make(w, h, seed).save(sys.argv[1])
    print(f"wrote {sys.argv[1]} ({w}x{h})")
