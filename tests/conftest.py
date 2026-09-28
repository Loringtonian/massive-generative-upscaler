import json
import pathlib
import subprocess
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "tools"), str(ROOT / "refine"), str(ROOT / "print"), str(ROOT / "upscale")]


def run(*cmd, cwd=ROOT):
    r = subprocess.run([str(c) for c in cmd], cwd=cwd, capture_output=True, text=True)
    assert r.returncode == 0, f"{cmd} failed:\n{r.stdout}\n{r.stderr}"
    return r.stdout


@pytest.fixture(scope="session")
def pipeline(tmp_path_factory):
    """Synthetic image -> prepare -> fake redraw -> register -> assemble -> verify."""
    import make_synthetic

    work = tmp_path_factory.mktemp("pipeline")
    make_synthetic.make(900, 600, seed=3).save(work / "source.png")
    cfg = {
        "input": "source.png",
        "workDir": "refine",
        "target": {"width": 1350, "height": 900},
        "density": 300,
        "tile": {"size": 448, "overlap": 112},
        "protected": [[500, 350, 220, 160], [40, 700, 120, 120]],
        "transfer": {"feather": 50, "protectFeather": 20},
    }
    (work / "refine.json").write_text(json.dumps(cfg))
    out = {"work": work, "cfg": cfg, "refine": work / "refine"}
    out["prepare"] = run("node", "refine/prepare.mjs", work / "refine.json")
    run(sys.executable, "tools/fake_generate.py", work / "refine", "--scale", "0.9", "--angle", "0.6", "--shift", "3.2,-2.1")
    out["register"] = run(sys.executable, "refine/register.py", work / "refine.json")
    out["assemble"] = run("node", "refine/assemble.mjs", work / "refine.json")
    out["verify"] = run("node", "refine/verify.mjs", work / "refine.json")
    return out
