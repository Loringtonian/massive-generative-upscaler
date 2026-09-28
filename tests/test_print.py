import json
import subprocess
import sys

import numpy as np
import pytest
from build import extend, extend_left, trim_box
from make_synthetic import make
from PIL import Image


@pytest.mark.parametrize(
    "img,sheet,bleed",
    [((20000, 12500), (70, 40), 0.125), ((20000, 12500), (50, 30), 0.125), ((4000, 6000), (24, 36), 0.25), ((1800, 1200), (12, 8), 0)],
)
def test_trim_box_fits_and_keeps_aspect(img, sheet, bleed):
    g = trim_box(*img, *sheet, bleed)
    x, y, w, h = g["trim"]
    x0, y0, x1, y1 = g["box"]
    assert 0 <= x0 and 0 <= y0 and x1 <= img[0] and y1 <= img[1]
    assert abs(w / h - sheet[0] / sheet[1]) < 2 / h
    assert abs(g["ppi"] - w / sheet[0]) < 1e-9
    assert g["bleed_px"] == round(g["ppi"] * bleed)
    assert (x1 - x0, y1 - y0) == (w + 2 * g["bleed_px"], h + 2 * g["bleed_px"])
    # Largest possible: one more pixel of trim width would not fit.
    assert w + 1 + 2 * round((w + 1) / sheet[0] * bleed) > img[0] or round((w + 1) * sheet[1] / sheet[0]) + 2 * round((w + 1) / sheet[0] * bleed) > img[1]


def test_trim_box_70x40_numbers():
    g = trim_box(21000, 12500, 70, 40, 0.125)
    assert g["ppi"] == pytest.approx(298.9, abs=0.1)
    assert g["bleed_px"] == 37


def test_extend_keeps_original_pixels():
    a = np.asarray(make(400, 300, seed=5))
    out = extend_left(a, 80, period=120, blend=40, search=10)
    assert out.shape == (300, 480, 3)
    assert np.array_equal(out[:, 80 + 40 :], a[:, 40:])


def test_extend_all_sides_shape():
    a = np.asarray(make(400, 300, seed=5))
    out = extend(a, {"left": 50, "right": 30, "top": 20, "bottom": 10, "blend": 20, "search": 5})
    assert out.shape == (330, 480, 3)
    assert np.array_equal(out[20 + 20 : 20 + 300 - 20, 50 + 20 : 50 + 400 - 20], a[20:-20, 20:-20])


def test_extend_rejects_short_period():
    a = np.zeros((100, 200, 3), np.uint8)
    with pytest.raises(ValueError):
        extend_left(a, 80, period=40)


def test_build_cli_writes_prints_with_ppi(tmp_path):
    make(900, 600, seed=2).save(tmp_path / "in.png")
    cfg = {
        "input": "in.png",
        "outputDir": "out",
        "extend": {"left": 60, "right": 60, "blend": 30, "search": 5},
        "label": {"text": "SAMPLE", "x": 0.5, "y": 0.1, "sizePx": 40},
        "prints": [
            {"name": "a", "sheetInches": [6, 4], "bleedInches": 0.125},
            {"name": "b", "sheetInches": [3, 2], "bleedInches": 0.125, "ppi": 300},
        ],
    }
    (tmp_path / "p.json").write_text(json.dumps(cfg))
    subprocess.run([sys.executable, "print/build.py", str(tmp_path / "p.json")], check=True, capture_output=True)
    rep = json.loads((tmp_path / "out" / "build.json").read_text())
    assert rep["canvas"] == [1020, 600]
    a = Image.open(tmp_path / "out" / "a.tif")
    assert round(a.info["dpi"][0], 1) == rep["prints"][0]["ppi"]
    b = Image.open(tmp_path / "out" / "b.tif")
    assert b.size == (round(3.25 * 300), round(2.25 * 300))
    assert round(b.info["dpi"][0]) == 300
    canvas = np.asarray(Image.open(tmp_path / "out" / "canvas.tif").convert("L"))
    assert canvas[40:80, 450:570].max() == 255, "label should be drawn near the top centre"
