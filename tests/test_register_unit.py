import cv2
import numpy as np
from make_synthetic import make
from register import DEFAULTS, passes, register_pair


def crop():
    return cv2.cvtColor(np.asarray(make(500, 500, seed=11)), cv2.COLOR_RGB2BGR)


def test_recovers_pure_shift():
    src = crop()
    m = np.float32([[1, 0, 4.5], [0, 1, -3.0]])
    gen = cv2.warpAffine(src, m, (500, 500), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
    got, stats = register_pair(src, gen, DEFAULTS)
    assert np.allclose(got[:, 2], [-4.5, 3.0], atol=0.15)
    assert abs(stats["scale"] - 1) < 0.002
    assert passes(stats, 1.0, DEFAULTS)


def test_rejects_unrelated_image():
    src = crop()
    other = cv2.cvtColor(np.asarray(make(500, 500, seed=99)), cv2.COLOR_RGB2BGR)
    got, stats = register_pair(src, other, DEFAULTS)
    assert got is None or not passes(stats, 1.0, DEFAULTS)


def test_gate_rejects_wrong_scale():
    stats = {"inliers": 500, "medianErrorPx": 0.3, "scale": 1.2, "translationPx": 1}
    assert not passes(stats, 1.0, DEFAULTS)
    assert passes({**stats, "scale": 1.0}, 1.0, DEFAULTS)
