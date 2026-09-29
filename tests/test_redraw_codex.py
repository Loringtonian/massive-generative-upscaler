import json
import stat
import sys

import pytest
import redraw_codex
from PIL import Image

FAKE_CODEX = """#!{python}
import os, pathlib, sys
from PIL import Image
args = sys.argv[1:]
job = pathlib.Path(args[args.index("--cd") + 1])
last = pathlib.Path(args[args.index("--output-last-message") + 1])
prompt = sys.stdin.read()
assert "built-in image-generation tool" in prompt
assert "OPENAI_API_KEY" not in os.environ and "CODEX_API_KEY" not in os.environ
assert sorted(p.name for p in job.iterdir()) == ["input.png", "prompt.txt"]
if os.environ.get("FAKE_CODEX_MODE") == "limit":
    last.write_text("USAGE_LIMIT")
    sys.exit(0)
Image.open(job / "input.png").resize((64, 64)).save(job / "output.png")
last.write_text(str(job / "output.png") + " 64x64")
"""


@pytest.fixture
def work(tmp_path, monkeypatch):
    refine = tmp_path / "refine"
    (refine / "inputs").mkdir(parents=True)
    tiles = []
    for i in range(3):
        Image.new("RGB", (32, 32), (40 * i, 80, 120)).save(refine / "inputs" / f"r01_c0{i}.png")
        tiles.append({"id": f"r01_c0{i}"})
    (refine / "manifest.json").write_text(json.dumps({"tiles": tiles}))
    (tmp_path / "refine.json").write_text(json.dumps({"workDir": "refine", "skip": ["r01_c02"]}))
    fake = tmp_path / "codex"
    fake.write_text(FAKE_CODEX.format(python=sys.executable))
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-reach-the-worker")
    return {"root": tmp_path, "refine": refine, "codex": str(fake)}


def test_redraws_pending_tiles_and_skips_listed_ones(work):
    rc = redraw_codex.main([str(work["root"] / "refine.json"), "--codex", work["codex"]])
    assert rc == 0
    generated = sorted(p.name for p in (work["refine"] / "generated").iterdir())
    assert generated == ["r01_c00.png", "r01_c01.png"]
    state = json.loads((work["refine"] / "redraw-state.json").read_text())
    assert state["tiles"]["r01_c00"]["status"] == "generated"
    assert state["tiles"]["r01_c00"]["size"] == [64, 64]


def test_resume_skips_tiles_already_generated(work):
    redraw_codex.main([str(work["root"] / "refine.json"), "--codex", work["codex"], "--limit", "1"])
    redraw_codex.main([str(work["root"] / "refine.json"), "--codex", work["codex"]])
    state = json.loads((work["refine"] / "redraw-state.json").read_text())
    assert state["tiles"]["r01_c00"]["attempts"] == 1
    assert state["tiles"]["r01_c01"]["attempts"] == 1


def test_usage_limit_pauses_with_exit_30(work, monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "limit")
    rc = redraw_codex.main([str(work["root"] / "refine.json"), "--codex", work["codex"]])
    assert rc == redraw_codex.PAUSED
    assert not (work["refine"] / "generated").exists()
    state = json.loads((work["refine"] / "redraw-state.json").read_text())
    assert state["tiles"]["r01_c00"]["status"] == "paused"
    assert "r01_c01" not in state["tiles"]


def test_prompt_carries_scene_and_guard_rails():
    p = redraw_codex.build_prompt("a lineup of industrial machinery")
    assert "The scene: a lineup of industrial machinery." in p
    assert "Do not use an API key" in p
    assert "output.png" in p
