#!/usr/bin/env python3
"""Build unpacked extensions and ZIP packages; standard library only."""
import argparse
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED, ZipInfo

ROOT = Path(__file__).resolve().parent
FILES = ("core.js", "engine.js", "popup.js", "popup.html", "popup.css")

def build(browser):
    manifest = json.loads((ROOT / "manifests" / (browser + ".json")).read_text())
    version = manifest["version"]
    dest = ROOT / "dist" / browser
    dest.mkdir(parents=True, exist_ok=True)
    payload = {name: (ROOT / "src" / name).read_bytes() for name in FILES}
    payload["manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    for name, data in payload.items():
        (dest / name).write_bytes(data)
    archive = ROOT / "dist" / ("virtual-page-find-" + browser + "-" + version + ".zip")
    with ZipFile(archive, "w", compression=ZIP_DEFLATED) as z:
        for name, data in sorted(payload.items()):
            info = ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            z.writestr(info, data)
    print(dest)
    print(archive)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("browser", nargs="?", choices=["firefox", "chrome", "all"], default="all")
    args = parser.parse_args()
    for browser in ("firefox", "chrome") if args.browser == "all" else (args.browser,):
        build(browser)
