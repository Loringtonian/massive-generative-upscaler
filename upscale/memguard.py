#!/usr/bin/env python3
"""Memory watchdog for a long-running job.

Usage: python3 memguard.py <pid> [floor_gb=1.6] [rss_cap_gb=3.5] [log=memguard.log]

Kills the target only for conditions it causes or that genuinely predict a crash:
  - available memory floor  -> the real crash predictor
  - target RSS cap          -> bounds the job's own contribution
Absolute swap is deliberately NOT a trigger: it can be high at baseline, driven by
other processes, and macOS grows the swap file dynamically."""

import os
import signal
import subprocess
import sys
import time

if len(sys.argv) < 2:
    sys.exit(__doc__)
PID = int(sys.argv[1])
FLOOR = float(sys.argv[2]) if len(sys.argv) > 2 else 1.6  # GB available
RSS_CAP = float(sys.argv[3]) if len(sys.argv) > 3 else 3.5  # GB our own RSS
LOG = sys.argv[4] if len(sys.argv) > 4 else "memguard.log"


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
    for l in o.splitlines():
        if "page size of" in l:
            ps = int(l.split("page size of")[1].split()[0])
        if ":" in l:
            k, x = l.split(":", 1)
            x = x.strip().rstrip(".")
            if x.isdigit():
                v[k.strip()] = int(x)
    return (v.get("Pages free", 0) + v.get("Pages inactive", 0) + v.get("Pages purgeable", 0) + v.get("Pages speculative", 0)) * ps / 1e9


def tree_rss_gb(p):
    pids = [str(p)] + subprocess.run(["pgrep", "-P", str(p)], capture_output=True, text=True).stdout.split()
    o = subprocess.run(["ps", "-o", "rss=", "-p", ",".join(pids)], capture_output=True, text=True).stdout
    return sum(int(x) for x in o.split() if x.isdigit()) / 1048576


def alive(p):
    try:
        os.kill(p, 0)
        return True
    except OSError:
        return False


def swap_gb():
    try:
        o = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True).stdout
        return float(o.split("used =")[1].split("M")[0].strip()) / 1024
    except Exception:
        return 0.0


with open(LOG, "a", buffering=1) as f:
    f.write(f"# armed pid {PID} floor={FLOOR}GB rss_cap={RSS_CAP}GB (swap observed, not enforced)\n")
    lo, hi = 99.0, 0.0
    while alive(PID):
        a, r, s = avail_gb(), tree_rss_gb(PID), swap_gb()
        lo, hi = min(lo, a), max(hi, r)
        why = "avail<floor" if a < FLOOR else ("rss>cap" if r > RSS_CAP else None)
        if why:
            f.write(f"!! TRIP {why} avail={a:.2f} rss={r:.2f} swap={s:.2f} -> SIGKILL {PID}\n")
            try:
                for c in subprocess.run(["pgrep", "-P", str(PID)], capture_output=True, text=True).stdout.split():
                    os.kill(int(c), signal.SIGKILL)
                os.kill(PID, signal.SIGKILL)
            except OSError:
                pass
            sys.exit(2)
        time.sleep(2)
    f.write(f"# clean exit; min avail {lo:.2f}GB, peak our-RSS {hi:.2f}GB\n")
