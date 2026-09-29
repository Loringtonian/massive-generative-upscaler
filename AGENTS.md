# AGENTS.md: run the whole pipeline for a person

You are a coding agent. Someone has pointed you at this repository and said "go". Your job
is to take their photo to a large, lossless print file, doing every step yourself and
stopping only where this file says to ask them.

Read [README.md](README.md) once for what each tool does. This file is the order of work.

## Ground rules

- **Never modify the person's original photo.** Everything you make goes under `work/`.
- **Every file meant for printing is lossless** (TIFF or PNG, full size, colour profile
  kept). JPEGs are previews only.
- **Be honest about the AI.** The added detail is generated. When you describe results,
  say _AI-refined_, never _restored_ or _recovered_.
- **No paid API calls without the person's explicit go.** The default image route below
  runs on their ChatGPT plan through Codex, not on an API key.
- **Run long jobs in the background and check on them;** do not block the chat for an
  hour.

## Step 0: ask for these, all in one message

1. The photo (path or URL).
2. Final print size in inches or cm, and ppi (default 300).
3. A short, neutral description of the scene (e.g. "three pieces of industrial machinery
   in front of a corrugated wall"). It goes into the redraw prompt.
4. Anything that must stay exactly as it is: lettering, logos, faces, numbers.
5. Whether they have Codex logged in with a ChatGPT plan (`codex login status`). If not,
   which image model they want to use instead.

Then set up and prove the repo works:

```bash
pip install -r requirements-dev.txt && npm ci
pip install torch spandrel          # for the upscaler
make test
```

## Step 1: upscale 4×

```bash
mkdir -p models work
curl -L -o models/RealESRGAN_x4plus.pth \
  https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth
python3 upscale/safe_upscale.py <photo> work/upscaled.png models/RealESRGAN_x4plus.pth 128 &
python3 upscale/memguard.py $! 1.6 6 work/memguard.log     # kills the job before the machine swaps
python3 upscale/fix_ca.py work/upscaled.png work/upscaled_ca.png   # if edges show purple/green fringes
```

`safe_upscale.py` resumes if stopped: run the same command again. Do only **one** AI
upscale. Any further enlargement is a plain resize, which `prepare.mjs` does (a second AI
pass invents cracks and mesh patterns).

## Step 2: configure and cut the tiles

Copy `refine/config.example.json` to `work/refine.json` and set:

- `input`: the upscaled file (relative to the config).
- `target`: print inches × ppi, keeping the photo's aspect ratio.
- `tile`: `{"size": 1024, "overlap": 256}` is a good start. Smaller tiles get more
  detail per pixel from the image model, but cost more calls.
- `regions`: the areas worth redrawing. Leave out sky, plain walls and smooth
  backgrounds: they gain nothing and fail registration.
- `protected`: rectangles around everything from Step 0 item 4.

```bash
node refine/prepare.mjs work/refine.json
```

Tell the person how many tiles there are before going on.

## Step 3: redraw the tiles

### Default: Codex's built-in image tool (ChatGPT plan, no API key)

Codex's built-in image tool is documented as OpenAI's GPT Image 2. The tool does not report
a model name per call, so do not claim more than that.

**Pilot first.** Redraw three tiles, register them (Step 4), and show the person each
input next to its result. Ask: sharper and still faithful, or too much invented texture?
Adjust `--scene` or the prompt in `refine/redraw_codex.py` until they say go.

```bash
python3 refine/redraw_codex.py work/refine.json --scene "<Step 0 item 3>" --limit 3
```

Then the full run, in the background:

```bash
python3 refine/redraw_codex.py work/refine.json --scene "<Step 0 item 3>"
```

- Each tile is one fresh, short `codex exec` in its own temporary folder holding only the
  crop and the prompt. About one minute per tile.
- Progress is saved after every tile in `work/refine/redraw-state.json`. Re-running skips
  tiles already in `generated/`.
- **Exit code 30 means the plan's usage limit was reached.** That is a pause, not a
  failure. Tell the person, and run the same command again after the limit resets. Never
  switch to a paid API to get around it.
- Rough cost from one early measurement: about 5% of a Codex five-hour window per tile.
  Measure your own first batch before promising the person a timeline.
- The tool returns 1254 × 1254 images whatever size you ask for. That is fine:
  registration handles the scale.

### Any other image model

Send each `work/refine/inputs/<id>.png` with the prompt in
[`refine/prompt-template.txt`](refine/prompt-template.txt) and save the result as
`work/refine/generated/<id>.png`. The rest of the pipeline does not care which model drew
it.

## Step 4: register, assemble, verify

```bash
python3 refine/register.py work/refine.json
node refine/assemble.mjs work/refine.json
node refine/verify.mjs work/refine.json
```

If `register.py` rejects a tile, look at `registration.json`:

- **Few inliers on a flat area** (sky, plain paint): add the tile id to `skip`.
- **Large shift, rotation or wrong scale:** the model moved things. Delete that
  `generated/<id>.png` and redraw just it (`redraw_codex.py` picks up missing tiles).
- Do not loosen the thresholds to force a pass. A rejected tile stays as the upscaled
  base, which is always safe.

## Step 5: let the person review

```bash
cp review/review.config.example.json work/review.json   # versions: the upscale and exports/refined.tif
node review/server.mjs work/review.json                  # http://127.0.0.1:8779 (PORT=... if taken)
```

Give them the URL. They can drag the before/after slider at full zoom and drop pins on
anything wrong. Read their notes in the review data folder, then either redraw the
pinned tiles or add them to `protected` and assemble again (`--force`).

## Step 6: print files

Copy `print/print.example.json` to `work/print.json`, set the sheet sizes, bleed and ppi
the person's print shop asked for, and run:

```bash
python3 print/build.py work/print.json
```

Hand over the TIFFs with their `build.json`. Suggest a small test print at 100% scale on
the real paper before the full-size order.

## Where to stop and ask

- After Step 0 if anything is missing.
- After the three-tile pilot, before the full redraw.
- At a usage-limit pause, if they may want to wait or change plans.
- Before any paid API call, purchase, or upload anywhere.
- When the review screen is ready.
