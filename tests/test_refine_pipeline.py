import json

import cv2
import numpy as np
from PIL import Image


def load(p):
    return np.asarray(Image.open(p).convert("RGB")).astype(np.int16)


def test_tiles_cover_the_image(pipeline):
    m = json.loads((pipeline["refine"] / "manifest.json").read_text())
    assert (m["width"], m["height"]) == (1350, 900)
    covered = np.zeros((m["height"], m["width"]), bool)
    for t in m["tiles"]:
        assert t["x"] >= 0 and t["y"] >= 0 and t["x"] + t["width"] <= m["width"] and t["y"] + t["height"] <= m["height"]
        assert (pipeline["refine"] / "inputs" / f"{t['id']}.png").exists()
        covered[t["y"] : t["y"] + t["height"], t["x"] : t["x"] + t["width"]] = True
    assert covered.all()
    assert len(m["tiles"]) == 4 * 3


def test_registration_recovers_known_transform(pipeline):
    regs = json.loads((pipeline["refine"] / "registration.json").read_text())
    truth = json.loads((pipeline["refine"] / "generated" / "_truth.json").read_text())
    assert regs and all(r["pass"] for r in regs)
    for r in regs:
        a = np.vstack([np.array(truth[r["id"]]), [0, 0, 1]])
        expected = np.linalg.inv(a)[:2]
        got = np.array(r["matrix"])
        assert abs(r["scale"] - 1 / 0.9) < 0.002
        expected_deg = np.degrees(np.arctan2(expected[1, 0], expected[0, 0]))
        assert abs(expected_deg) > 0.5
        assert abs(r["rotationDeg"] - expected_deg) < 0.05
        # Compare where the four corners of the source crop land.
        tile = next(t for t in json.loads((pipeline["refine"] / "manifest.json").read_text())["tiles"] if t["id"] == r["id"])
        corners = np.array([[0, 0, 1], [tile["width"], 0, 1], [0, tile["height"], 1], [tile["width"], tile["height"], 1]], float)
        gen_pts = (a[:2] @ corners.T).T
        err = np.abs(np.c_[gen_pts, np.ones(4)] @ got.T - np.c_[gen_pts, np.ones(4)] @ expected.T).max()
        assert err < 0.5, f"{r['id']} corner error {err:.2f}px"


def test_aligned_crops_match_their_source(pipeline):
    for f in sorted((pipeline["refine"] / "aligned").glob("r??_c??.png")):
        src = cv2.imread(str(pipeline["refine"] / "inputs" / f.name)).astype(np.float32)
        al = cv2.imread(str(f)).astype(np.float32)
        inner = (slice(20, -20), slice(20, -20))
        assert np.abs(cv2.GaussianBlur(src, (0, 0), 2)[inner] - cv2.GaussianBlur(al, (0, 0), 2)[inner]).mean() < 6


def test_output_size_ppi_and_bounded_change(pipeline):
    out = pipeline["refine"] / "exports" / "refined.tif"
    im = Image.open(out)
    assert im.size == (1350, 900)
    assert round(im.info["dpi"][0]) == 300
    base, ref = load(pipeline["refine"] / "base.tif"), load(out)
    diff = np.abs(ref - base)
    t = {"strength": 0.45, "maxDelta": 18}
    assert diff.max() <= int(t["strength"] * t["maxDelta"]) + 2
    assert (diff > 0).mean() > 0.05, "refinement should change a noticeable share of pixels"


def test_protected_regions_pixel_identical(pipeline):
    base = load(pipeline["refine"] / "base.tif")
    ref = load(pipeline["refine"] / "exports" / "refined.tif")
    for x, y, w, h in pipeline["cfg"]["protected"]:
        assert np.array_equal(base[y : y + h, x : x + w], ref[y : y + h, x : x + w])
    report = json.loads((pipeline["refine"] / "qa" / "verification.json").read_text())
    assert report["ok"] and all(r["identical"] for r in report["protectedRegions"])


def test_colour_stays_on_base(pipeline):
    """Only luminance detail moves: per-pixel channel deltas are equal (before clipping)."""
    base = load(pipeline["refine"] / "base.tif")
    ref = load(pipeline["refine"] / "exports" / "refined.tif")
    d = ref - base
    unclipped = (base > 12).all(-1) & (base < 243).all(-1) & (np.abs(d).max(-1) > 0)
    spread = d[unclipped].max(-1) - d[unclipped].min(-1)
    assert np.percentile(spread, 99) <= 2
