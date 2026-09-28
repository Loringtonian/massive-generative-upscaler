"""Stand-in for an image model, for tests and dry runs.

Usage: python3 tools/fake_generate.py <workDir> [--scale 0.9] [--angle 0.6] [--shift 3.2,-2.1]

For each inputs/<id>.png it writes generated/<id>.png: the crop sharpened, then slightly
rotated, shifted and resized, the way a real model's redraw drifts. The exact forward
transform (source pixel -> generated pixel) goes to generated/_truth.json so tests can
check that registration recovers it.
"""

import argparse
import json
import pathlib

import cv2
import numpy as np


def forward_matrix(w, h, scale, angle_deg, shift):
    """2x3 matrix mapping source crop coords to generated coords."""
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle_deg, 1.0)
    m[:, 2] += shift
    m = np.vstack([m, [0, 0, 1]])
    s = np.diag([scale, scale, 1.0])
    return (s @ m)[:2]


def fake(src, scale=0.9, angle=0.6, shift=(3.2, -2.1)):
    h, w = src.shape[:2]
    blur = cv2.GaussianBlur(src, (0, 0), 2.0)
    sharp = cv2.addWeighted(src, 1.8, blur, -0.8, 0)
    a = forward_matrix(w, h, scale, angle, np.array(shift, dtype=np.float64))
    out = cv2.warpAffine(sharp, a, (round(w * scale), round(h * scale)), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
    return out, a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("work")
    ap.add_argument("--scale", type=float, default=0.9)
    ap.add_argument("--angle", type=float, default=0.6)
    ap.add_argument("--shift", default="3.2,-2.1")
    args = ap.parse_args()
    work = pathlib.Path(args.work)
    shift = tuple(float(v) for v in args.shift.split(","))
    (work / "generated").mkdir(exist_ok=True)
    truth = {}
    for f in sorted((work / "inputs").glob("*.png")):
        out, a = fake(cv2.imread(str(f), cv2.IMREAD_COLOR), args.scale, args.angle, shift)
        cv2.imwrite(str(work / "generated" / f.name), out)
        truth[f.stem] = a.tolist()
    (work / "generated" / "_truth.json").write_text(json.dumps(truth, indent=2))
    print(f"faked {len(truth)} generated crops in {work / 'generated'}")


if __name__ == "__main__":
    main()
