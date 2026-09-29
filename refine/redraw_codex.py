"""Step 2 (optional): redraw every crop with Codex's built-in image tool.

Usage: python3 refine/redraw_codex.py <config.json> [--limit N] [--scene "..."] [--dry-run]

For each tile in manifest.json that has no generated/<id>.png yet (and is not in `skip`),
this runs one short, fresh `codex exec` in its own temporary folder holding only the
crop and the prompt. Codex calls its built-in image tool once and saves output.png,
which is copied to generated/<id>.png. Progress is written to redraw-state.json after
every tile, so a re-run resumes where it stopped.

Codex must be logged in with a ChatGPT plan (`codex login`). OPENAI_API_KEY and
CODEX_API_KEY are removed from the worker's environment so nothing is billed to an API
key. When the plan's usage limit is reached the script stops and exits 30; run the same
command again after the limit resets.
"""

import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time

from PIL import Image

PAUSED = 30
LIMIT_MARKERS = ("usage_limit", "usage limit", "rate limit", "limit reached")

WORKER_PREAMBLE = """Use the built-in image-generation tool once to edit the attached image. \
Do not use an API key, paid image API, image-generation CLI fallback, alternative model or \
external provider. If the built-in tool is unavailable or usage is exhausted, stop and reply \
with the single word USAGE_LIMIT or TOOL_UNAVAILABLE. Do not read any files other than \
input.png and prompt.txt in the current directory.
"""

WORKER_SUFFIX = """
Copy the generated image to output.png in the current directory. Reply with only the saved \
path and the actual pixel dimensions. Do not print base64 image data.
"""

EDIT_PROMPT = """Edit this exact photograph crop for a larger fine-detail print. It is an \
edit target, not a style reference.{scene} Refine soft edges and existing fine detail with \
restrained natural sharpness. Preserve every object's geometry, count, position, framing, \
lighting, colour, shadows and material character. Keep smooth surfaces smooth; do not invent \
texture, mesh, grain, cracks, extra objects, inscriptions or halos. Output one image of the \
same aspect ratio preserving the entire input composition. No borders or text."""


def load(config_path):
    config_path = pathlib.Path(config_path).resolve()
    cfg = json.loads(config_path.read_text())
    work = (config_path.parent / cfg.get("workDir", "work/refine")).resolve()
    return cfg, work


def sha256(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def build_prompt(scene):
    scene = f" The scene: {scene.strip()}." if scene else ""
    return WORKER_PREAMBLE + "\n" + EDIT_PROMPT.format(scene=scene) + "\n" + WORKER_SUFFIX


def codex_command(codex, job):
    return [
        codex,
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "-c",
        'forced_login_method="chatgpt"',
        "-c",
        "project_doc_max_bytes=0",
        "--sandbox",
        "workspace-write",
        "--cd",
        str(job),
        "--image",
        str(job / "input.png"),
        "--json",
        "--output-last-message",
        str(job / "result.txt"),
        "-",
    ]


def hit_limit(*texts):
    blob = " ".join(t.lower() for t in texts if t)
    return any(m in blob for m in LIMIT_MARKERS)


def save_state(path, state):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2) + "\n")
    tmp.replace(path)


def redraw_tile(codex, tile_id, src, dest, prompt, timeout):
    env = {k: v for k, v in os.environ.items() if k not in ("OPENAI_API_KEY", "CODEX_API_KEY")}
    with tempfile.TemporaryDirectory(prefix=f"redraw-{tile_id}-") as tmp:
        job = pathlib.Path(tmp)
        shutil.copyfile(src, job / "input.png")
        (job / "prompt.txt").write_text(prompt)
        with open(job / "prompt.txt") as stdin:
            proc = subprocess.run(
                codex_command(codex, job),
                stdin=stdin,
                capture_output=True,
                text=True,
                env=env,
                timeout=timeout,
            )
        result = (job / "result.txt").read_text() if (job / "result.txt").exists() else ""
        out = job / "output.png"
        if not out.exists():
            status = "paused" if hit_limit(result, proc.stdout, proc.stderr) else "failed"
            return {"status": status, "exit": proc.returncode, "message": result.strip()[:500]}
        with Image.open(out) as im:
            im.verify()
        with Image.open(out) as im:
            size = list(im.size)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(out, dest)
        return {"status": "generated", "size": size, "sha256": sha256(dest)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("config")
    ap.add_argument("--limit", type=int, default=0, help="stop after N tiles (0 = all)")
    ap.add_argument("--scene", default="", help="short neutral description of the scene")
    ap.add_argument("--codex", default=shutil.which("codex") or "codex")
    ap.add_argument("--timeout", type=int, default=900, help="seconds per tile")
    ap.add_argument("--dry-run", action="store_true", help="list the tiles and the prompt only")
    args = ap.parse_args(argv)

    cfg, work = load(args.config)
    manifest = json.loads((work / "manifest.json").read_text())
    skip = set(cfg.get("skip", []))
    state_path = work / "redraw-state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {"tiles": {}}
    prompt = build_prompt(args.scene)

    todo = [t["id"] for t in manifest["tiles"] if t["id"] not in skip and not (work / "generated" / f"{t['id']}.png").exists()]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(todo)} tile(s) to redraw", flush=True)
    if args.dry_run:
        print(prompt)
        print("\n".join(todo))
        return 0

    for tile_id in todo:
        started = time.time()
        entry = state["tiles"].setdefault(tile_id, {"attempts": 0})
        entry["attempts"] += 1
        outcome = redraw_tile(
            args.codex,
            tile_id,
            work / "inputs" / f"{tile_id}.png",
            work / "generated" / f"{tile_id}.png",
            prompt,
            args.timeout,
        )
        entry.update(outcome, seconds=round(time.time() - started))
        save_state(state_path, state)
        print(f"{tile_id}: {outcome['status']} {outcome.get('size', '')}", flush=True)
        if outcome["status"] == "paused":
            print("Usage limit reached. Run the same command again after it resets.")
            return PAUSED
        if outcome["status"] == "failed":
            print(f"Codex did not produce an image: {outcome.get('message', '')}")
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
