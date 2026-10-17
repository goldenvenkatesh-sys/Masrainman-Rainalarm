"""Fake radar data with a storm line moving towards Chennai, for testing the
Rain Alarm app without the real radar engine:

    python scripts/make_demo_nowcast.py          # fills docs/data with 2 h of demo frames
    python -m http.server -d docs                # then open http://localhost:8000
"""
import gzip
import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DEMO = ROOT / "demo_radar"          # stands in for the radar checkout
OUT = DEMO / "output"
IST = timezone(timedelta(hours=5, minutes=30))
LAT_N, LON_W, STEP, NR, NC = 15.5, 73.5, 0.02, 400, 450
SITES = [(12.945, 80.235, 150), (13.084, 80.288, 250), (10.925, 79.838, 250),
         (9.926, 76.268, 250), (12.95, 74.83, 250), (8.537, 76.86, 250)]
lat = LAT_N - np.arange(NR) * STEP
lon = LON_W + np.arange(NC) * STEP
LAT, LON = np.meshgrid(lat, lon, indexing="ij")


def coverage():
    cov = np.zeros(LAT.shape, bool)
    for la, lo, rk in SITES:
        d = np.hypot((LAT - la) * 111, (LON - lo) * 111 * np.cos(np.radians(la)))
        cov |= d <= rk
    return cov


def storms(t_min):
    """dBZ field at t_min minutes from 'now' (negative = past)."""
    f = np.zeros(LAT.shape)
    # squall line moving WSW -> ENE towards Chennai at ~30 km/h
    cx, cy = 79.80 + 0.0052 * t_min, 12.80 + 0.0018 * t_min
    for k, (dx, dy, pk, r) in enumerate([(0, 0, 52, 9), (0.06, 0.12, 46, 8), (-0.05, -0.14, 42, 10),
                                         (0.1, 0.26, 38, 9), (-0.1, -0.3, 35, 11)]):
        d = np.hypot((LAT - (cy + dy)) * 111, (LON - (cx + dx)) * 111 * 0.97)
        f = np.maximum(f, np.maximum(pk * np.exp(-(d / r) ** 2), 31 * np.exp(-(d / (r * 3.2)) ** 2)))
    # scattered Kerala showers (stationary-ish)
    for la, lo, pk, r in [(9.93, 78.10 - 0.0012 * t_min, 47, 9), (10.0, 76.35, 44, 7), (9.6, 76.6, 36, 6), (11.25, 75.85, 40, 8), (8.75, 77.1, 33, 6)]:
        d = np.hypot((LAT - la) * 111, (LON - (lo + 0.001 * t_min)) * 111)
        f = np.maximum(f, pk * np.exp(-(d / r) ** 2))
    f[f < 20] = 0
    return f


def to_bytes(f, cov):
    out = np.full(f.shape, 255, np.uint8)
    out[cov] = 0
    e = cov & (f > 0)
    out[e] = np.clip(np.round(f[e]), 1, 254)
    return out


def main(age_min=0):
    cov = coverage()
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0) - timedelta(minutes=age_min)
    layers, blobs = [{"name": "observed", "lead_min": 0}], [to_bytes(storms(0), cov)]
    for lead in (10, 20, 30, 40, 50, 60, 70, 80, 90):
        v = now + timedelta(minutes=lead)
        layers.append({"name": f"plus_{lead}", "lead_min": lead, "valid_utc": v.isoformat(timespec="seconds"),
                       "valid_ist": v.astimezone(IST).strftime("%d %b %H:%M IST")})
        blobs.append(to_bytes(storms(lead), cov))
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / "nowcast_bot_grid.bin.gz", "wb") as fh:
        with gzip.GzipFile(fileobj=fh, mode="wb", mtime=0) as gz:
            gz.write(b"".join(b.tobytes() for b in blobs))
    doc = {"schema": 1, "version": now.strftime("%Y%m%dT%H%M%SZ"), "generated_utc": now.isoformat(timespec="seconds"),
           "generated_ist": now.astimezone(IST).strftime("%d %b %Y %H:%M IST"), "stale_after_min": 30, "radars": {},
           "grid": {"file": "nowcast_bot_grid.bin.gz", "compression": "gzip", "lat_north": LAT_N, "lon_west": LON_W,
                    "step_deg": STEP, "nrows": NR, "ncols": NC, "layers": layers},
           "motion": {"available": True, "overall_speed_kmh": 31.0, "overall_bearing_deg": 70.0},
           "cells": [], "rain_areas": [], "demo": True}
    (OUT / "nowcast_bot.json").write_text(json.dumps(doc, indent=1))
    return now


if __name__ == "__main__":
    sys.path.insert(0, str(ROOT / "scripts"))
    import cycle
    cycle.DATA.mkdir(parents=True, exist_ok=True)
    cycle.HIST.mkdir(parents=True, exist_ok=True)
    cov = coverage()
    for back in range(120, -1, -10):          # past 2 h, then "now"
        main(age_min=back)
        if back:                              # past frames: observed = storms where they were then
            raw = bytearray(gzip.decompress((OUT / "nowcast_bot_grid.bin.gz").read_bytes()))
            raw[:NR * NC] = to_bytes(storms(-back), cov).tobytes()
            with open(OUT / "nowcast_bot_grid.bin.gz", "wb") as fh:
                with gzip.GzipFile(fileobj=fh, mode="wb", mtime=0) as gz:
                    gz.write(bytes(raw))
        cycle.export_nowcast(DEMO)
