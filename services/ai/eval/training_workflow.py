# -*- coding: utf-8 -*-
"""Phase A — multi-floor Before/After training & evaluation over old_plans (no Mongo/S3).

Pipeline per project/floor:
  1. engineer ground truth  ← AFTER vector text (eval.extract_after)
  2. AI prediction + understanding metrics ← run the real pipeline on the BEFORE page
  3. per-floor / per-project / dataset evaluation (count-based P/R/F1 on engineer classes)
  4. recompute placement priors per room type AND floor type (PlacementPriors.perSpace shape)

AI analysis is cached per floor under eval/_cache so a full 34-page run completes across
resumable invocations (each call processes until --budget seconds, then exits 0/2).

  PYTHONPATH=. python -m eval.training_workflow --folder ../../old_plans --budget 40
  PYTHONPATH=. python -m eval.training_workflow --report     # build report from cache
"""
import argparse
import json
import os
import time
from collections import Counter, defaultdict

import numpy as np
from PIL import Image

from eval.old_plans import build_manifest, render_cached, CACHE
from eval.calibrate import _ai_analyze, ENGINEER_CLASSES, _prf
from eval.run_eval import CATEGORY

RESULTS = os.path.join(CACHE, "floor_results.json")


def _understanding(rooms, placements, texts_n):
    types = Counter(r["type"] for r in rooms)
    acc = len(rooms)
    bed = types.get("bedroom", 0) + types.get("master_bedroom", 0)
    return {
        "acceptedRooms": acc,
        "labelledRooms": sum(1 for r in rooms if (r.get("meta") or {}).get("classificationSource") == "ocr_label"),
        "unclassifiedRooms": types.get("unclassified", 0),
        "bedroomPct": round(100 * bed / acc, 1) if acc else 0.0,
        "ocrLabels": texts_n,
        "roomTypes": dict(types),
    }


def _analyze_before(pdf, page, priors=None, floor_type=None):
    """Run the pipeline on a BEFORE page → rooms, placements, understanding, doors.
    `priors`+`floor_type` close the learning loop (engine consumes them)."""
    from app.pipeline.preprocess import preprocess
    from app.pipeline.geometry import extract_walls, segment_rooms
    from app.pipeline.ocr import read_text
    from app.pipeline.fusion import fuse
    from app.pipeline import architecture as arch
    from app.pipeline.textfilter import filter_tokens
    from app.rules.engine import suggest
    from app.rules.quality import filter_rooms, apply_placement_qc

    png = render_cached(pdf, page)
    bgr = (np.array(Image.open(png).convert("RGB"))[:, :, ::-1]).copy()
    pp = preprocess(bgr)
    rooms_geo = segment_rooms(extract_walls(pp["binary"]), pp["extent"])
    geo = arch.geometry_layer(pp["binary"])
    for rg in rooms_geo:
        rg["polygon"] = arch.snap_orthogonal(rg["polygon"])
    texts = read_text(bgr)
    rooms_raw, zones = fuse(rooms_geo, texts, [])
    arch.type_rooms_by_geometry(rooms_raw, geo)
    zones = zones + arch.geometry_zones(geo)
    accepted, _, _ = filter_rooms(rooms_raw, None)
    # Baseline (rules only) vs loop-closed (rules + priors + floor-type policy).
    base, _, _ = apply_placement_qc(suggest(accepted, zones), accepted, None)
    withp, _, _ = apply_placement_qc(
        suggest(accepted, zones, priors=priors, floor_type=floor_type), accepted, None)
    return {
        "placements": [{"deviceCode": p["deviceCode"], "x": p["position"]["x"], "y": p["position"]["y"]} for p in withp],
        "deviceCounts": dict(Counter(p["deviceCode"] for p in base)),           # baseline
        "deviceCountsPriors": dict(Counter(p["deviceCode"] for p in withp)),    # loop-closed
        "understanding": _understanding(accepted, withp, len(filter_tokens(texts))),
        "doors": len(geo["doors"]),
        "rooms": [{"type": r["type"], "centroid": r["centroid"]} for r in accepted],
    }


def _load_priors():
    p = os.path.join(os.path.dirname(__file__), "_out", "priors.json")
    return json.load(open(p)) if os.path.exists(p) else None


def run(folder, budget=40.0):
    man = build_manifest(folder)
    cache = json.load(open(RESULTS)) if os.path.exists(RESULTS) else {}
    folder = os.path.abspath(folder)
    priors = _load_priors()
    t0 = time.time()
    done_now = 0
    for proj in man:
        before = os.path.join(folder, proj["before"])
        for fl in proj["floors"]:
            key = f"{proj['project']}|{fl['pageIndex']}"
            if key in cache and "deviceCountsPriors" in (cache[key].get("ai") or {}):
                continue
            if time.time() - t0 > budget:
                json.dump(cache, open(RESULTS, "w"))
                print(f"budget reached; cached {done_now} new floors; {len(cache)}/{sum(len(p['floors']) for p in man)} total")
                return False
            ai = _analyze_before(before, fl["pageIndex"], priors=priors, floor_type=fl["floorType"])
            cache[key] = {
                "project": proj["project"], "pageIndex": fl["pageIndex"], "floorType": fl["floorType"],
                "matchConfidence": fl["matchConfidence"],
                "engineerDeviceCounts": fl["engineerDeviceCounts"],
                "engineerDevices": fl["engineerDevices"],
                "ai": ai,
            }
            done_now += 1
    json.dump(cache, open(RESULTS, "w"))
    total = sum(len(p["floors"]) for p in man)
    print(f"complete: {len(cache)}/{total} floors cached ({done_now} new)")
    return True


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--folder", default=os.path.join(os.path.dirname(__file__), "..", "..", "..", "old_plans"))
    ap.add_argument("--budget", type=float, default=40.0)
    ap.add_argument("--report", action="store_true")
    a = ap.parse_args()
    if a.report:
        from eval.training_report import main as report_main
        report_main()
    else:
        ok = run(os.path.abspath(a.folder), a.budget)
        raise SystemExit(0 if ok else 2)
