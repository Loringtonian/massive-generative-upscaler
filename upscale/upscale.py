"""Standalone 4x RRDBNet (Real-ESRGAN x4plus architecture) tiled upscaler, no spandrel.

Usage: python3 upscale.py <input> <output> <weights.pth>
Holds the full output in RAM; prefer safe_upscale.py for large images.
"""

import math
import sys
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


class RDB(nn.Module):
    def __init__(s, nf=64, gc=32):
        super().__init__()
        for i in range(5):
            setattr(s, f"conv{i + 1}", nn.Conv2d(nf + i * gc, gc if i < 4 else nf, 3, 1, 1))
        s.l = nn.LeakyReLU(0.2, True)

    def forward(s, x):
        x1 = s.l(s.conv1(x))
        x2 = s.l(s.conv2(torch.cat((x, x1), 1)))
        x3 = s.l(s.conv3(torch.cat((x, x1, x2), 1)))
        x4 = s.l(s.conv4(torch.cat((x, x1, x2, x3), 1)))
        x5 = s.conv5(torch.cat((x, x1, x2, x3, x4), 1))
        return x5 * 0.2 + x


class RRDB(nn.Module):
    def __init__(s, nf=64, gc=32):
        super().__init__()
        s.rdb1 = RDB(nf, gc)
        s.rdb2 = RDB(nf, gc)
        s.rdb3 = RDB(nf, gc)

    def forward(s, x):
        return s.rdb3(s.rdb2(s.rdb1(x))) * 0.2 + x


class RRDBNet(nn.Module):
    def __init__(s, nf=64, nb=23, gc=32):
        super().__init__()
        s.conv_first = nn.Conv2d(3, nf, 3, 1, 1)
        s.body = nn.Sequential(*[RRDB(nf, gc) for _ in range(nb)])
        s.conv_body = nn.Conv2d(nf, nf, 3, 1, 1)
        s.conv_up1 = nn.Conv2d(nf, nf, 3, 1, 1)
        s.conv_up2 = nn.Conv2d(nf, nf, 3, 1, 1)
        s.conv_hr = nn.Conv2d(nf, nf, 3, 1, 1)
        s.conv_last = nn.Conv2d(nf, 3, 3, 1, 1)
        s.l = nn.LeakyReLU(0.2, True)

    def forward(s, x):
        f = s.conv_first(x)
        f = f + s.conv_body(s.body(f))
        f = s.l(s.conv_up1(F.interpolate(f, scale_factor=2, mode="nearest")))
        f = s.l(s.conv_up2(F.interpolate(f, scale_factor=2, mode="nearest")))
        return s.conv_last(s.l(s.conv_hr(f)))


if len(sys.argv) < 4:
    sys.exit(__doc__)
src, dst, wpath = sys.argv[1], sys.argv[2], sys.argv[3]
dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
net = RRDBNet()
sd = torch.load(wpath, map_location="cpu")
sd = sd.get("params_ema", sd.get("params", sd))
net.load_state_dict(sd, strict=True)
net.eval().to(dev)
print(f"model loaded on {dev}", flush=True)

im = Image.open(src).convert("RGB")
W, H = im.size
arr = np.asarray(im, dtype=np.float32) / 255.0
out = np.zeros((H * 4, W * 4, 3), dtype=np.uint8)
TILE, PAD = 320, 24
nx, ny = math.ceil(W / TILE), math.ceil(H / TILE)
t0 = time.time()
n = 0
with torch.no_grad():
    for j in range(ny):
        for i in range(nx):
            x0, y0 = i * TILE, j * TILE
            x1, y1 = min(x0 + TILE, W), min(y0 + TILE, H)
            px0, py0 = max(x0 - PAD, 0), max(y0 - PAD, 0)
            px1, py1 = min(x1 + PAD, W), min(y1 + PAD, H)
            t = torch.from_numpy(arr[py0:py1, px0:px1]).permute(2, 0, 1).unsqueeze(0).to(dev)
            o = net(t).clamp(0, 1).squeeze(0).permute(1, 2, 0).cpu().numpy()
            ox0, oy0 = (x0 - px0) * 4, (y0 - py0) * 4
            crop = o[oy0 : oy0 + (y1 - y0) * 4, ox0 : ox0 + (x1 - x0) * 4]
            out[y0 * 4 : y1 * 4, x0 * 4 : x1 * 4] = (crop * 255.0 + 0.5).astype(np.uint8)
            n += 1
            if n % 20 == 0:
                el = time.time() - t0
                print(f"  {n}/{nx * ny} tiles  {el:.0f}s elapsed  ETA {el / n * (nx * ny - n):.0f}s", flush=True)
Image.fromarray(out).save(dst, quality=97, subsampling=0, dpi=(300, 300))
print(f"DONE {W * 4}x{H * 4} = {W * 4 * H * 4 / 1e6:.1f} MP -> {dst}  ({time.time() - t0:.0f}s)", flush=True)
