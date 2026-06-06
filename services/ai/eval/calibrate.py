# -*- coding: utf-8 -*-
"""Placement calibration harness — AI device suggestions vs engineer AFTER drawings.

For each BEFORE/AFTER villa pair and each floor page:
  • render the BEFORE sheet, run the full CV pipeline → predicted device placements
  • read engineer placements from the AFTER vector text layer (eval.extract_after)
  • compute count-based precision / recall / F1 per device class
  • bucket engineer devices into room types (room detection on the AFTER sheet) to learn
    the engineer's typical devices-per-room-type priors

Positions on BEFORE and AFTER are different rasters, so per-class COUNT matching is the
honest metric (same approach the rule-vs-truth eval already used). Reported aggregate and
per-floor so calibration changes are measurable, not eyeballed.

Usage:
  PYTHONPATH=. python -m eval.calibrate --pairs auto         # discover *BEFORE*/*AFTER* in repo root
  PYTHONPATH=. python -m eval.calibrate --learn-priors        # also print per-room-type priors
"""
import argparse
import glob
import os
import subprocess
import tempfile
from collections import Counter, defaultdict

import numpy as np
from PIL import Image

from eval.extract_after import extract as extract_after

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))

# Device classes the engineer ELV/smart-home sheets actually use. P/R/F1 is reported on
# these (apples-to-apples). Customer-rule devices on other disciplines (CCTV, data sockets,
# light switches, curtain motors, projector) are reported separately, never as silent FPs.
ENGINEER_CLASSES = {
    "WIFI_AP", "SPEAKER", "VOLUME_CONTROL", "SENSOR", "INTERCOM_SCREEN",
    "INTERCOM_BELL", "THERMOSTAT", "GATE_MOTOR", "SMART_LOCK", "ELV_RACK",
}


def _render(pdf: str, page: int, dpi: int = 150) -> np.ndarray:
    with tempfile.TemporaryDirectory() as d:
        base = os.path.join(d, "p")
        subprocess.run(["pdftoppm", "-r", str(dpi), "-f", str(page), "-l", str(page),
                        "-png", pdf, base], check=True, capture_output=True)
        png = glob.glob(base + "*")[0]
        return (np.array(Image.open(png).convert("RGB"))[:, :, ::-1]).copy()


def _ai_analyze(bgr: np.ndarray):
    """Run the pipeline → (accepted_rooms, accepted_placements)."""
    from app.pipeline.preprocess import preprocess
    from app.pipeline.geometry import extract_walls, segment_rooms
    from app.pipeline.ocr import read_text
    from app.pipeline.fusion import fuse
    from app.pipeline import architecture as arch
    from app.rules.engine import suggest
    from app.rules.quality import filter_rooms, apply_placement_qc

    pp = preprocess(bgr)
    rooms_geo = segment_rooms(extract_walls(pp["binary"]), pp["extent"])
    geo = arch.geometry_layer(pp["binary"])
    for rg in rooms_geo:
        rg["polygon"] = arch.snap_orthogonal(rg["polygon"])
    rooms_raw, zones = fuse(rooms_geo, read_text(bgr), [])
    arch.type_rooms_by_geometry(rooms_raw, geo)
    zones = zones + arch.geometry_zones(geo)
    accepted, _, _ = filter_rooms(rooms_raw, None)
    acc_p, _, _ = apply_placement_qc(suggest(accepted, zones), accepted, None)
    return accepted, acc_p


def _prf(truth: Counter, pred: Counter, classes):
    rows = {}
    tp = fp = fn = 0
    for c in sorted(classes):
        t, p = truth.get(c, 0), pred.get(c, 0)
        ctp = min(t, p); cfp = max(0, p - t); cfn = max(0, t - p)
        tp += ctp; fp += cfp; fn += cfn
        prec = ctp / (ctp + cfp) if (ctp + cfp) else None
        rec = ctp / (ctp + cfn) if (ctp + cfn) else None
        f1 = (2 * prec * rec / (prec + rec)) if prec and rec else (0.0 if (t or p) else None)
        rows[c] = {"truth": t, "pred": p, "P": prec, "R": rec, "F1": f1}
    micro_p = tp / (tp + fp) if (tp + fp) else None
    micro_r = tp / (tp + fn) if (tp + fn) else None
    micro_f1 = (2 * micro_p * micro_r / (micro_p + micro_r)) if micro_p and micro_r else None
    return rows, {"P": micro_p, "R": micro_r, "F1": micro_f1, "tp": tp, "fp": fp, "fn": fn}


def _assign_room_type(devs, rooms):
    """Bucket engineer device positions into the nearest detected room → per-type counts."""
    out = defaultdict(Counter)
    for d in devs:
        if not rooms:
            out["(no rooms)"][d["deviceCode"]] += 1
            continue
        best, bd = None, 1e9
        for r in rooms:
            cx, cy = r["centroid"]
            dist = (cx - d["x"]) ** 2 + (cy - d["y"]) ** 2
            if dist < bd:
                bd, best = dist, r
        out[best["type"]][d["deviceCode"]] += 1
    return out


def _discover_pairs():
    befores = sorted(glob.glob(os.path.join(REPO, "*BEFORE*.pdf")) + glob.glob(os.path.join(REPO, "*before*.pdf")))
    pairs = []
    for b in befores:
        a = b.replace("BEFORE", "AFTER").replace("before", "after")
        if os.path.exists(a):
            pairs.append((b, a))
    return pairs


def run(pairs, learn_priors=False):
    agg_truth, agg_pred = Counter(), Counter()
    agg_all_pred = Counter()           # all AI device codes (incl. non-engineer)
    priors = defaultdict(Counter)
    floor_rows = []

    for before, after in pairs:
        gt = extract_after(after)
        for f in gt["floors"]:
            page = f["page"]
            truth = Counter(f["deviceCounts"])
            if sum(truth.values()) == 0:
                continue                # skip empty floors (roof) for P/R/F1
            bgr = _render(before, page)
            rooms, placements = _ai_analyze(bgr)
            pred_all = Counter(p["deviceCode"] for p in placements)
            pred_eng = Counter({c: n for c, n in pred_all.items() if c in ENGINEER_CLASSES})
            agg_truth.update(truth); agg_pred.update(pred_eng); agg_all_pred.update(pred_all)
            floor_rows.append((os.path.basename(before), f["floor"], dict(truth), dict(pred_all)))
            if learn_priors:
                a_bgr = _render(after, page)
                a_rooms, _ = _ai_analyze(a_bgr)
                for rt, cnt in _assign_room_type(f["devices"], a_rooms).items():
                    priors[rt].update(cnt)

    rows, micro = _prf(agg_truth, agg_pred, ENGINEER_CLASSES)
    return {"perClass": rows, "micro": micro, "aggTruth": dict(agg_truth),
            "aggPredEngineer": dict(agg_pred), "aggPredAll": dict(agg_all_pred),
            "floors": floor_rows, "priors": {k: dict(v) for k, v in priors.items()}}


def _fmt(v):
    return "  -  " if v is None else f"{v:.2f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", default="auto")
    ap.add_argument("--learn-priors", action="store_true")
    a = ap.parse_args()
    pairs = _discover_pairs() if a.pairs == "auto" else []
    if not pairs:
        ap.error("no BEFORE/AFTER pairs found")
    print("pairs:", [os.path.basename(b) for b, _ in pairs])
    res = run(pairs, learn_priors=a.learn_priors)

    print("\n── Per-device-class (engineer ELV/smart-home classes), count-based ──")
    print(f"{'device':18} {'truth':>5} {'pred':>5} {'P':>6} {'R':>6} {'F1':>6}")
    for c, m in res["perClass"].items():
        print(f"{c:18} {m['truth']:>5} {m['pred']:>5} {_fmt(m['P']):>6} {_fmt(m['R']):>6} {_fmt(m['F1']):>6}")
    mi = res["micro"]
    print(f"{'MICRO':18} {sum(res['aggTruth'].values()):>5} {sum(res['aggPredEngineer'].values()):>5} "
          f"{_fmt(mi['P']):>6} {_fmt(mi['R']):>6} {_fmt(mi['F1']):>6}   (tp={mi['tp']} fp={mi['fp']} fn={mi['fn']})")

    extra = {c: n for c, n in res["aggPredAll"].items() if c not in ENGINEER_CLASSES}
    if extra:
        print("\n── AI devices NOT on engineer sheets (customer-rule / other disciplines) ──")
        print("  ", extra)

    if res["priors"]:
        print("\n── Learned engineer priors: devices per room type ──")
        for rt, cnt in sorted(res["priors"].items()):
            print(f"  {rt:16}: {dict(cnt)}")


if __name__ == "__main__":
    main()
