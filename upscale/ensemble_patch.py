"""8-way geometric self-ensemble of an upscaler on one region (4 rotations x flip).

Usage: python3 ensemble_patch.py <input> <weights> <x> <y> <w> <h> <context, e.g. 48> <out_prefix>
Writes <out_prefix>_single.png and <out_prefix>_ensemble.png (region only, at model scale).
Device: UPS_DEV env (default cpu).
"""

import os
import sys

os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.5")
import numpy as np
import torch
from PIL import Image
from spandrel import ImageModelDescriptor, ModelLoader

Image.MAX_IMAGE_PIXELS = None

if len(sys.argv) < 9:
    sys.exit(__doc__)
src, wpath = sys.argv[1], sys.argv[2]
X, Y, W, H = [int(v) for v in sys.argv[3:7]]  # native region
CTX = int(sys.argv[7])
out_pref = sys.argv[8]

d = ModelLoader().load_from_file(wpath)
assert isinstance(d, ImageModelDescriptor)
S = d.scale
dev = torch.device(os.environ.get("UPS_DEV", "cpu"))
m = d.model.eval().to(dev)

im = Image.open(src).convert("RGB")
x0, y0 = max(X - CTX, 0), max(Y - CTX, 0)
x1, y1 = min(X + W + CTX, im.width), min(Y + H + CTX, im.height)
patch = np.asarray(im.crop((x0, y0, x1, y1)), dtype=np.float32) / 255.0
t0 = torch.from_numpy(patch).permute(2, 0, 1).unsqueeze(0).to(dev)


def fwd(t):
    with torch.no_grad():
        return m(t).clamp(0, 1)


# 8-way geometric self-ensemble: 4 rotations x {identity, hflip}
acc, n = None, 0
for k in range(4):
    for flip in (False, True):
        t = torch.rot90(t0, k, dims=(-2, -1))
        if flip:
            t = torch.flip(t, dims=(-1,))
        o = fwd(t)
        if flip:
            o = torch.flip(o, dims=(-1,))
        o = torch.rot90(o, -k, dims=(-2, -1))
        acc = o if acc is None else acc + o
        n += 1
        print(f"  pass {n}/8", flush=True)
ens = (acc / n).squeeze(0).permute(1, 2, 0).cpu().numpy()
single = fwd(t0).squeeze(0).permute(1, 2, 0).cpu().numpy()

# crop back to the requested region in model-scale space
cx, cy = (X - x0) * S, (Y - y0) * S
for name, a in (("single", single), ("ensemble", ens)):
    arr = (a[cy : cy + H * S, cx : cx + W * S] * 255 + 0.5).astype(np.uint8)
    Image.fromarray(arr).save(f"{out_pref}_{name}.png")
    print(f"wrote {out_pref}_{name}.png {arr.shape[1]}x{arr.shape[0]}", flush=True)
