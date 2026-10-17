"""One Rain Alarm data cycle (what GitHub Actions runs every 10 minutes).

The radar engine is NOT copied into this repo. The workflow checks out the
public MasRainman radar repo (goldenvenkatesh-sys/masrainman-nowcast) into
./radar, read-only, and this script:

  1. runs its engine (nowcast_bot.run_pipeline) inside that throw-away copy:
     fetch IMD radars, track cells, write output/nowcast_bot.json + grid
  2. copies the result into docs/data/ for the web app and keeps a rolling
     2-hour history of the observed radar picture for the loop

Nothing is ever written back to the radar repo, so the radar bot and its
Telegram/Facebook/WhatsApp posting are not touched.

  python scripts/cycle.py --radar radar            # full cycle
  python scripts/cycle.py --radar radar --no-run   # only export what is in radar/output
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import shutil
import sys
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
DATA = DOCS / "data"
HIST = DATA / "history"
HISTORY_HOURS = 2.0
HISTORY_MAX_FRAMES = 14

RADAR_NAMES = {
    "niot": "Chennai NIOT (X-band)", "chennai": "Chennai DWR", "karaikal": "Karaikal DWR",
    "kochi": "Kochi DWR", "mangalore": "Mangaluru DWR", "trivandrum": "Thiruvananthapuram DWR",
}
RANGE_KM = {"niot": 150}          # range ring drawn on the map; IMD DWRs default to 250 km


def write_json(path: Path, obj) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


def run_engine(radar: Path):
    """Run the radar engine inside the radar checkout. Returns the module (or None)."""
    os.chdir(radar)                       # the engine uses paths relative to its repo
    sys.path.insert(0, str(radar))
    try:
        import nowcast_bot as engine
    except Exception:
        traceback.print_exc()
        return None
    try:
        engine.run_pipeline()
    except Exception:
        traceback.print_exc()
        print("[alarm] radar engine failed this cycle -- app keeps the previous data")
    return engine


def export_static(radar: Path, engine=None) -> None:
    """places.json (towns, EN + Tamil), boundaries.json, radars.json."""
    try:
        sys.path.insert(0, str(radar))
        from masrainman.places import PLACES
        write_json(DATA / "places.json", [{"en": en, "ta": ta, "lat": lat, "lon": lon, "p": pr, "st": st}
                                          for en, ta, lat, lon, pr, st in PLACES])
    except Exception as exc:
        print(f"[alarm] places not updated: {exc!r}")
    src = radar / "assets" / "boundaries.json"
    if src.exists():
        shutil.copyfile(src, DATA / "boundaries.json")
    sites = getattr(engine, "RADAR_SITES", None) or {}
    radars = []
    for key, s in sites.items():
        try:
            radars.append({"id": key, "name": RADAR_NAMES.get(key, key.title()),
                           "lat": round(float(s["site_lat"]), 4), "lon": round(float(s["site_lon"]), 4),
                           "range_km": RANGE_KM.get(key, 250)})
        except (KeyError, TypeError, ValueError):
            continue
    if radars:
        write_json(DATA / "radars.json", radars)


def export_nowcast(radar: Path) -> None:
    src_json = radar / "output" / "nowcast_bot.json"
    src_grid = radar / "output" / "nowcast_bot_grid.bin.gz"
    if not src_json.exists():
        print("[alarm] no engine export this cycle -- app keeps the previous data")
        return
    doc = json.loads(src_json.read_text())
    g = doc.get("grid")
    write_json(DATA / "nowcast.json", doc)
    if not g or not src_grid.exists():
        print("[alarm] engine export has no grid (no fresh radar) -- json only")
        return
    shutil.copyfile(src_grid, DATA / "nowcast_grid.bin.gz")

    # rolling history of the observed layer (layer 0) for the past loop
    raw = gzip.decompress(src_grid.read_bytes())
    observed = raw[: g["nrows"] * g["ncols"]]
    geom = [g["lat_north"], g["lon_west"], g["step_deg"], g["nrows"], g["ncols"]]
    ver = doc["version"]
    hist_path = DATA / "history.json"
    hist = json.loads(hist_path.read_text()) if hist_path.exists() else {"frames": []}
    frames = [f for f in hist.get("frames", []) if f.get("version") != ver and f.get("geom") == geom]
    with open(HIST / f"{ver}.bin.gz", "wb") as fh:
        with gzip.GzipFile(fileobj=fh, mode="wb", mtime=0) as gz:
            gz.write(observed)
    frames.append({"version": ver, "time_utc": doc["generated_utc"], "geom": geom})
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=HISTORY_HOURS + 0.2)
    frames = [f for f in frames if datetime.fromisoformat(f["time_utc"]) >= cutoff][-HISTORY_MAX_FRAMES:]
    keep = {f"{f['version']}.bin.gz" for f in frames}
    for p in HIST.glob("*.bin.gz"):
        if p.name not in keep:
            p.unlink()
    write_json(hist_path, {"frames": frames, "updated_utc": now.isoformat(timespec="seconds")})
    print(f"[alarm] exported nowcast {ver} + {len(frames)} history frame(s)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--radar", default="radar", help="path to a checkout of masrainman-nowcast")
    ap.add_argument("--no-run", action="store_true", help="skip the engine, only export radar/output")
    a = ap.parse_args()
    radar = Path(a.radar).resolve()
    DATA.mkdir(parents=True, exist_ok=True)
    HIST.mkdir(parents=True, exist_ok=True)
    engine = None if a.no_run else run_engine(radar)
    export_static(radar, engine)
    export_nowcast(radar)


if __name__ == "__main__":
    main()
