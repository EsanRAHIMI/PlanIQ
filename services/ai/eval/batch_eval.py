# -*- coding: utf-8 -*-
"""Batch evaluation across a folder of plan images.

Runs the full CV pipeline on every PNG/JPG in a directory and prints a per-floor table
plus aggregate Priority-1 metrics, so detection/classification changes can be measured
honestly against the BEFORE/AFTER sample drawings instead of eyeballed.

Usage:
  PYTHONPATH=. python -m eval.batch_eval --dir /path/to/plans [--glob '*BEFORE*']

Key metrics reported:
  - floors with >=1 accepted space   (was the failure mode: empty floors)
  - % of accepted spaces typed 'bedroom'  (the 'everything is a bedroom' symptom)
  - % of accepted spaces typed from a real OCR label vs area-only 'unclassified'
  - door-count sanity (raw geometry door detections per floor)
"""
import argparse
import glob
import os
from collections import Counter

from eval.run_eval import run


def _one(path):
    m = run(image=path)
    types = Counter(m["spaceTypes"])
    acc = m["acceptedSpaces"]
    bedrooms = types.get("bedroom", 0) + types.get("master_bedroom", 0)
    unclassified = types.get("unclassified", 0)
    return {
        "name": os.path.basename(path),
        "detected": m["detectedSpaces"],
        "accepted": acc,
        "labelled": m["labelledSpaces"],
        "bedrooms": bedrooms,
        "unclassified": unclassified,
        "devices": m["acceptedDevices"],
        "doors": (m.get("geometry") or {}).get("doors"),
        "types": dict(types),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--glob", default="*.png")
    a = ap.parse_args()
    paths = sorted(glob.glob(os.path.join(a.dir, a.glob)))
    rows = [_one(p) for p in paths]

    print(f"{'floor':28} {'det':>4} {'acc':>4} {'lbl':>4} {'bed':>4} {'uncl':>5} {'dev':>4} {'door':>5}")
    print("-" * 70)
    for r in rows:
        print(f"{r['name'][:28]:28} {r['detected']:>4} {r['accepted']:>4} {r['labelled']:>4} "
              f"{r['bedrooms']:>4} {r['unclassified']:>5} {r['devices']:>4} {str(r['doors']):>5}")

    floors = len(rows)
    productive = sum(1 for r in rows if r["accepted"] > 0)
    total_acc = sum(r["accepted"] for r in rows)
    total_bed = sum(r["bedrooms"] for r in rows)
    total_lbl = sum(r["labelled"] for r in rows)
    total_dev = sum(r["devices"] for r in rows)
    print("-" * 70)
    print(f"floors                         : {floors}")
    print(f"floors with >=1 accepted space : {productive}/{floors}")
    print(f"accepted spaces (total)        : {total_acc}")
    print(f"  from a real OCR label        : {total_lbl} ({_pct(total_lbl, total_acc)})")
    print(f"  typed 'bedroom'/'master'     : {total_bed} ({_pct(total_bed, total_acc)})")
    print(f"devices placed (total)         : {total_dev}")


def _pct(a, b):
    return f"{(100 * a / b):.0f}%" if b else "n/a"


if __name__ == "__main__":
    main()
