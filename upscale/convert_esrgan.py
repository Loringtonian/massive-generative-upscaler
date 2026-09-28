"""Convert an old-style ESRGAN (model.N.sub...) checkpoint to RRDBNet key names.

Usage: python3 convert_esrgan.py <old.pth> <new.pth>
"""

import re
import sys

import torch

if len(sys.argv) < 3:
    sys.exit(__doc__)
src, dst = sys.argv[1], sys.argv[2]
sd = torch.load(src, map_location="cpu")
sd = sd.get("params_ema", sd.get("params", sd))
out = {}
for k, v in sd.items():
    n = k
    n = n.replace("model.0.", "conv_first.")
    m = re.match(r"model\.1\.sub\.(\d+)\.RDB(\d)\.conv(\d)\.0\.(weight|bias)$", k)
    if m:
        n = f"body.{m.group(1)}.rdb{m.group(2)}.conv{m.group(3)}.{m.group(4)}"
    elif k.startswith("model.1.sub.23."):
        n = k.replace("model.1.sub.23.", "conv_body.")
    else:
        for a, b in (("model.3.", "conv_up1."), ("model.6.", "conv_up2."), ("model.8.", "conv_hr."), ("model.10.", "conv_last.")):
            if k.startswith(a):
                n = k.replace(a, b)
    out[n] = v
torch.save(out, dst)
print("converted", len(out), "keys ->", dst)
