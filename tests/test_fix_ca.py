import numpy as np
from fix_ca import find_scale, fix, scale_about_center
from make_synthetic import make
from PIL import ImageFilter


def test_finds_radial_scale_of_misaligned_channel():
    # Real photos have strongly correlated channels: use one smooth luminance plane for both.
    g = np.asarray(make(1000, 1000, seed=4).convert("L").filter(ImageFilter.GaussianBlur(1.5)), dtype=np.float32) / 255
    r = scale_about_center(g, 1.0012)
    s, cost, identity = find_scale(r, g)
    assert abs(s - 1 / 1.0012) < 0.00015
    assert cost < identity


def test_fix_keeps_shape_and_range():
    a = np.asarray(make(200, 150, seed=4), dtype=np.float32) / 255
    out, best = fix(a, verbose=False)
    assert out.shape == a.shape
    assert set(best) == {"R", "B"}
    assert np.abs(out - a).mean() < 0.02
