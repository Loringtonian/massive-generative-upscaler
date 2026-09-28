import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]


def orphan(cmd):
    """Start cmd detached from this process (so it is reaped when it ends) and return its pid."""
    out = subprocess.run(["sh", "-c", cmd + " >/dev/null 2>&1 & echo $!"], capture_output=True, text=True, check=True)
    return int(out.stdout.strip())


def test_exits_cleanly_when_target_finishes(tmp_path):
    pid = orphan("sleep 1")
    log = tmp_path / "mg.log"
    r = subprocess.run([sys.executable, str(ROOT / "upscale/memguard.py"), str(pid), "0.0", "100", str(log)], timeout=30)
    assert r.returncode == 0
    assert "clean exit" in log.read_text()


def test_trips_on_rss_cap(tmp_path):
    pid = orphan(f"{sys.executable} -c 'import time; x = bytearray(80_000_000); time.sleep(30)'")
    log = tmp_path / "mg.log"
    r = subprocess.run([sys.executable, str(ROOT / "upscale/memguard.py"), str(pid), "0.0", "0.01", str(log)], timeout=40)
    assert r.returncode == 2
    assert "rss>cap" in log.read_text()
