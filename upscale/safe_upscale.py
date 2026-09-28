#!/usr/bin/env python3
"""Memory-bounded, resumable, tiled upscaler (any spandrel-supported model).

Usage: python3 safe_upscale.py <input> <output> <weights.pth|.safetensors> [tile=128] [max_tiles=0]

Guarantees: MPS hard-capped (errors, never swaps); allocator cache freed per tile;
output written to an on-disk memmap so a kill loses at most the in-flight tile;
re-invocation resumes from the checkpoint."""

import os
import sys

# MUST be set before torch is imported
os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.5")
os.environ.setdefault("PYTORCH_MPS_LOW_WATERMARK_RATIO", "0.4")
import json
import math
import signal
import subprocess
import time

import numpy as np
import torch
from PIL import Image
from spandrel import ImageModelDescriptor, ModelLoader

Image.MAX_IMAGE_PIXELS = None

if len(sys.argv) < 4:
    sys.exit(__doc__)
src, dst, wpath = sys.argv[1], sys.argv[2], sys.argv[3]
TILE = int(sys.argv[4]) if len(sys.argv) > 4 else 128
MAX_TILES = int(sys.argv[5]) if len(sys.argv) > 5 else 0  # 0 = all (measurement mode if >0)
PAD = 32
run = dst + ".work"
os.makedirs(run, exist_ok=True)
state_p = os.path.join(run, "state.json")


def avail_gb():
    """Available memory in GB (macOS vm_stat, Linux /proc/meminfo)."""
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) / 1e6
    except OSError:
        pass
    try:
        o = subprocess.run(["vm_stat"], capture_output=True, text=True).stdout
    except OSError:
        return 99.0
    ps, v = 16384, {}
    for line in o.splitlines():
        if "page size of" in line:
            ps = int(line.split("page size of")[1].split()[0])
        if ":" in line:
            k, val = line.split(":", 1)
            val = val.strip().rstrip(".")
            if val.isdigit():
                v[k.strip()] = int(val)
    return (v.get("Pages free", 0) + v.get("Pages inactive", 0) + v.get("Pages purgeable", 0) + v.get("Pages speculative", 0)) * ps / 1e9


d = ModelLoader().load_from_file(wpath)
assert isinstance(d, ImageModelDescriptor)
S = d.scale
dev = torch.device(os.environ.get("UPS_DEV") or ("mps" if torch.backends.mps.is_available() else "cpu"))
model = d.model.eval().to(dev)
mult = getattr(d.size_requirements, "multiple_of", 1) or 1
print(f"arch={d.architecture.name} scale={S} tile={TILE} pad={PAD} cap={os.environ['PYTORCH_MPS_HIGH_WATERMARK_RATIO']} dev={dev}", flush=True)

im = Image.open(src).convert("RGB")
W, H = im.size
arr = np.asarray(im, dtype=np.float32) / 255.0
mm_p = os.path.join(run, "out.raw")
out = np.memmap(mm_p, dtype=np.uint8, mode=("r+" if os.path.exists(mm_p) else "w+"), shape=(H * S, W * S, 3))

nx, ny = math.ceil(W / TILE), math.ceil(H / TILE)
total = nx * ny
done = set()
if os.path.exists(state_p):
    done = set(json.load(open(state_p))["done"])
    print(f"resuming: {len(done)}/{total} tiles already complete", flush=True)

stop = {"v": False}
signal.signal(signal.SIGTERM, lambda *a: stop.__setitem__("v", True))
signal.signal(signal.SIGINT, lambda *a: stop.__setitem__("v", True))

t0, n, peak, min_avail = time.time(), 0, 0.0, 99.0
todo = [k for k in range(total) if k not in done]
if MAX_TILES:
    todo = todo[:MAX_TILES]

with torch.no_grad():
    for k in todo:
        if stop["v"]:
            print("PAUSED on signal — checkpoint written, re-run to resume", flush=True)
            break
        j, i = divmod(k, nx)
        x0, y0 = i * TILE, j * TILE
        x1, y1 = min(x0 + TILE, W), min(y0 + TILE, H)
        px0, py0 = max(x0 - PAD, 0), max(y0 - PAD, 0)
        px1, py1 = min(x1 + PAD, W), min(y1 + PAD, H)
        t = torch.from_numpy(arr[py0:py1, px0:px1]).permute(2, 0, 1).unsqueeze(0).to(dev)
        ph, pw = t.shape[-2], t.shape[-1]
        nh, nw = math.ceil(ph / mult) * mult, math.ceil(pw / mult) * mult
        if (nh, nw) != (ph, pw):
            t = torch.nn.functional.pad(t, (0, nw - pw, 0, nh - ph), mode="reflect")
        o = model(t)[..., : ph * S, : pw * S].clamp(0, 1).squeeze(0).permute(1, 2, 0).float().cpu().numpy()
        ox0, oy0 = (x0 - px0) * S, (y0 - py0) * S
        out[y0 * S : y1 * S, x0 * S : x1 * S] = (o[oy0 : oy0 + (y1 - y0) * S, ox0 : ox0 + (x1 - x0) * S] * 255 + 0.5).astype(np.uint8)
        del t, o
        peak = max(peak, torch.mps.driver_allocated_memory() / 1e9 if dev.type == "mps" else 0)
        torch.mps.empty_cache() if dev.type == "mps" else None
        done.add(k)
        n += 1
        a = avail_gb()
        min_avail = min(min_avail, a)
        if n % 10 == 0 or n == len(todo):
            out.flush()
            json.dump({"done": sorted(done), "total": total}, open(state_p, "w"))
            el = time.time() - t0
            print(
                f"  {len(done)}/{total}  peakMPS {peak:.2f}GB  sysAvail {a:.2f}GB (min {min_avail:.2f})  {el:.0f}s  ETA {el / n * (len(todo) - n):.0f}s",
                flush=True,
            )

out.flush()
json.dump({"done": sorted(done), "total": total}, open(state_p, "w"))
print(f"SUMMARY tiles_done={len(done)}/{total} peak_mps={peak:.2f}GB min_sys_avail={min_avail:.2f}GB", flush=True)
if len(done) == total:
    Image.fromarray(np.array(out)).save(dst, quality=97, subsampling=0, dpi=(300, 300))
    print(f"COMPLETE {W * S}x{H * S} = {W * S * H * S / 1e6:.1f}MP -> {dst}", flush=True)
else:
    print("INCOMPLETE — re-run same command to resume", flush=True)
    sys.exit(30)
