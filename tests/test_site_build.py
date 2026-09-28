import json

from conftest import run


def test_site_build_from_refined_output(pipeline):
    work = pipeline["work"]
    cfg = {
        "version": "t1",
        "title": "Synthetic <test>",
        "masterTiff": "refine/exports/refined.tif",
        "masterJpeg": "refine/exports/refined.jpg",
        "original": "source.png",
        "downloadName": "synthetic",
        "distDir": "dist",
        "protectedDownloads": True,
    }
    (work / "site.json").write_text(json.dumps(cfg))
    run("node", "site/build.mjs", work / "site.json")
    dist = work / "dist"
    b = json.loads((dist / "build.json").read_text())
    assert (b["width"], b["height"]) == (1350, 900)
    assert (b["originalWidth"], b["originalHeight"]) == (900, 600)
    assert b["downloads"]["tiff"]["name"] == "synthetic_t1.tif"
    html = (dist / "index.html").read_text()
    assert "<title>Synthetic &lt;test&gt;</title>" in html and "{{" not in html
    assert (dist / "tiles" / "poster.dzi").exists() and (dist / "vendor" / "OPENSEADRAGON-LICENSE.txt").exists()
