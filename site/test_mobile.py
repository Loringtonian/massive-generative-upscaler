# Phone checks (Playwright) for the local preview at 127.0.0.1:8781: tap sizes, errors, "Get yours",
# deep zoom, reload persistence. Start `node site/serve.mjs` first.
# Usage: python3 site/test_mobile.py <screenshot folder>
import glob
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

S = sys.argv[1] if len(sys.argv) > 1 else "."
URL = "http://127.0.0.1:8781/"
with sync_playwright() as p:
    exe = sorted(glob.glob(os.path.expanduser("~/Library/Caches/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell")))
    b = p.chromium.launch(executable_path=exe[-1]) if exe else p.chromium.launch()
    out = {}
    for name, dev in [("iphone15", "iPhone 15"), ("iphone15_land", "iPhone 15 landscape"), ("pixel7", "Pixel 7")]:
        d = dict(p.devices[dev])
        d.pop("default_browser_type", None)
        ctx = b.new_context(**d)
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(URL)
        page.wait_for_load_state("networkidle")
        time.sleep(5)
        page.locator("label.check", has_text="Get yours").tap()
        time.sleep(0.4)
        page.screenshot(path=f"{S}/n_{name}_getyours.png")
        out[name] = {
            "chips": [
                page.evaluate("(s)=>{const r=document.querySelector(s).getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]}", s)
                for s in ["#dl-jpeg", "#dl-tiff", "#tip", "#print"]
            ],
            "panelScrolls": page.evaluate("()=>{const p=document.getElementById('panel');return p.scrollHeight>p.clientHeight}"),
            "errors": errs,
        }
        if name == "iphone15_land":
            page.locator("label.check", has_text="Get yours").tap()
            time.sleep(0.3)
            vw, vh = page.viewport_size["width"], page.viewport_size["height"]
            h = page.locator("#handle").bounding_box()
            page.mouse.move(h["x"] + h["width"] / 2, h["y"] + h["height"] / 2)
            page.mouse.down()
            page.mouse.move(vw * 0.5, h["y"] + h["height"] / 2, steps=8)
            page.mouse.up()
            page.mouse.move(vw * 0.36, vh * 0.35)
            for i in range(30):
                page.mouse.wheel(0, -120)
                time.sleep(0.03)
            time.sleep(2.5)
            page.wait_for_load_state("networkidle")
            time.sleep(0.5)
            page.screenshot(path=f"{S}/n_land_zoom_off.png")
            page.locator("label.check", has_text="Pixel smoothing").tap()
            time.sleep(0.4)
            page.screenshot(path=f"{S}/n_land_zoom_on.png")
            page.reload()
            page.wait_for_load_state("networkidle")
            time.sleep(1)
            out["after_reload"] = page.evaluate(
                "()=>({smoothing:document.getElementById('smoothing').checked,"
                " getYours:document.getElementById('get-yours').checked,"
                " split:document.getElementById('divider').getAttribute('aria-valuenow')})"
            )
        ctx.close()
    b.close()
    print(json.dumps(out))
