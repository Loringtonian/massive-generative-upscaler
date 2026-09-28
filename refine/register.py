"""Step 3: register each redrawn crop back onto its source crop.

Usage: python3 refine/register.py <config.json>

For every generated/<id>.png: SIFT features, a ratio test, then RANSAC estimates a
similarity transform (translation, rotation, uniform scale) that maps the generated
crop onto its source crop. The crop is warped into the source frame (edge pixels
replicated) as aligned/<id>.png, and the numbers go to registration.json.
A tile passes only if it has enough inliers, a small median residual, a scale close to
the expected one (source size / generated size) and a small translation.
"""

import json
import pathlib
import sys

import cv2
import numpy as np

DEFAULTS = {
    "minInliers": 50,
    "maxMedianErrorPx": 1.5,
    "maxScaleDeviation": 0.025,
    "maxTranslationPx": 25,
    "ratio": 0.7,
    "ransacThreshold": 3,
    "nfeatures": 8000,
    "contrastThreshold": 0.012,
}


def load(config_path):
    config_path = pathlib.Path(config_path).resolve()
    cfg = json.loads(config_path.read_text())
    work = (config_path.parent / cfg.get("workDir", "work/refine")).resolve()
    reg = {**DEFAULTS, **cfg.get("registration", {})}
    return work, reg


def register_pair(src, candidate, reg):
    """Return (matrix, stats) mapping candidate pixel coords onto src pixel coords."""
    detector = cv2.SIFT_create(nfeatures=reg["nfeatures"], contrastThreshold=reg["contrastThreshold"])
    g1 = cv2.cvtColor(candidate, cv2.COLOR_BGR2GRAY)
    g2 = cv2.cvtColor(src, cv2.COLOR_BGR2GRAY)
    k1, d1 = detector.detectAndCompute(g1, None)
    k2, d2 = detector.detectAndCompute(g2, None)
    if d1 is None or d2 is None or len(k1) < 3 or len(k2) < 3:
        return None, {"inliers": 0, "matches": 0}
    pairs = cv2.BFMatcher().knnMatch(d1, d2, k=2)
    matches = [p[0] for p in pairs if len(p) == 2 and p[0].distance < reg["ratio"] * p[1].distance]
    if len(matches) < 3:
        return None, {"inliers": 0, "matches": len(matches)}
    p1 = np.float32([k1[m.queryIdx].pt for m in matches])
    p2 = np.float32([k2[m.trainIdx].pt for m in matches])
    matrix, inliers = cv2.estimateAffinePartial2D(p1, p2, method=cv2.RANSAC, ransacReprojThreshold=reg["ransacThreshold"], maxIters=5000)
    if matrix is None:
        return None, {"inliers": 0, "matches": len(matches)}
    keep = inliers.ravel().astype(bool)
    residual = np.linalg.norm(p1 @ matrix[:, :2].T + matrix[:, 2] - p2, axis=1)
    return matrix, {
        "inliers": int(keep.sum()),
        "matches": len(matches),
        "medianErrorPx": float(np.median(residual[keep])),
        "scale": float(np.linalg.norm(matrix[:, 0])),
        "rotationDeg": float(np.degrees(np.arctan2(matrix[1, 0], matrix[0, 0]))),
        "translationPx": float(np.linalg.norm(matrix[:, 2])),
    }


def passes(stats, expected_scale, reg):
    return bool(
        stats.get("inliers", 0) >= reg["minInliers"]
        and stats["medianErrorPx"] <= reg["maxMedianErrorPx"]
        and abs(stats["scale"] / expected_scale - 1) <= reg["maxScaleDeviation"]
        and stats["translationPx"] <= reg["maxTranslationPx"]
    )


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    work, reg = load(sys.argv[1])
    manifest = json.loads((work / "manifest.json").read_text())
    (work / "aligned").mkdir(exist_ok=True)
    results = []
    for row in manifest["tiles"]:
        candidate_path = work / "generated" / (row["id"] + ".png")
        if not candidate_path.exists():
            continue
        src = cv2.imread(str(work / "inputs" / (row["id"] + ".png")), cv2.IMREAD_COLOR)
        candidate = cv2.imread(str(candidate_path), cv2.IMREAD_COLOR)
        expected = row["width"] / candidate.shape[1]
        matrix, stats = register_pair(src, candidate, reg)
        result = {"id": row["id"], "expectedScale": expected, **stats}
        if matrix is None:
            result["pass"] = False
        else:
            result["matrix"] = matrix.tolist()
            result["pass"] = passes(stats, expected, reg)
            aligned = cv2.warpAffine(
                candidate,
                matrix,
                (row["width"], row["height"]),
                flags=cv2.INTER_CUBIC,
                borderMode=cv2.BORDER_REPLICATE,
            )
            cv2.imwrite(str(work / "aligned" / (row["id"] + ".png")), aligned)
        results.append(result)
        flag = "ok  " if result["pass"] else "FAIL"
        print(
            f"{flag} {row['id']}: inliers {stats.get('inliers', 0)}, "
            f"median error {stats.get('medianErrorPx', float('nan')):.2f}px, "
            f"scale {stats.get('scale', float('nan')):.4f} (expected {expected:.4f})"
        )
    (work / "registration.json").write_text(json.dumps(results, indent=2) + "\n")
    failed = [r["id"] for r in results if not r["pass"]]
    print(f"{len(results) - len(failed)}/{len(results)} crops registered")
    if failed:
        print("failed: " + ", ".join(failed) + " (redraw them, or delete the generated file to leave the tile unchanged)")
        sys.exit(1)


if __name__ == "__main__":
    main()
