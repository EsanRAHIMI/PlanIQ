# -*- coding: utf-8 -*-
"""PlanIQ analysis evaluation harness.

Runs the self-hosted CV pipeline on a plan image (or a synthetic labelled fixture) and
prints quality metrics — detected/accepted/corrected spaces, device counts by category,
and warnings — so changes to detection / classification / rules can be measured against
the sample BEFORE/AFTER drawings instead of eyeballed.

Usage:
  python -m eval.run_eval --image path/to/plan.png
  python -m eval.run_eval --image plan.png --labels labels.json   # inject OCR labels
  python -m eval.run_eval --fixture villa                         # built-in labelled villa

`labels.json`: [{"text": "Majlis", "center": [0.25, 0.30]}, ...] (normalized centers).
Run from services/ai/ so `app` is importable, or set PYTHONPATH=services/ai.
"""
import argparse
import json
import sys
from collections import Counter

# Device code → engineering category (for the by-category report).
CATEGORY = {
    "CCTV": "CCTV", "NVR": "CCTV",
    "WIFI_AP": "Wi-Fi",
    "INTERCOM_SCREEN": "Intercom", "INTERCOM_BELL": "Intercom",
    "SPEAKER": "Audio", "VOLUME_CONTROL": "Audio", "PROJECTOR": "Audio", "SCREEN": "Audio",
    "SENSOR": "Sensors",
    "ELV_RACK": "Network/Rack", "SWITCH": "Network/Rack", "DATA_SOCKET": "Network/Rack",
    "GATE_MOTOR": "Access", "SMART_LOCK": "Access",
    "THERMOSTAT": "Climate", "CURTAIN_MOTOR": "Smart-home", "LIGHT_SWITCH": "Lighting",
}


def _by_category(placements):
    cat = Counter()
    for p in placements:
        cat[CATEGORY.get(p["deviceCode"], "Other")] += 1
    return cat


def run(image=None, labels=None, fixture=None):
    from app.rules.engine import suggest
    from app.rules.quality import filter_rooms, apply_placement_qc, build_summary

    warnings = []
    geometry = None
    if fixture == "villa":
        rooms_raw, zones = _fixture_villa()
    else:
        import numpy as np  # noqa
        from app.pipeline.preprocess import preprocess
        from app.pipeline.geometry import extract_walls, segment_rooms
        from app.pipeline.ocr import read_text
        from app.pipeline.fusion import fuse
        from app.pipeline import architecture as arch
        from PIL import Image
        img = Image.open(image).convert("RGB")
        bgr = (np.array(img)[:, :, ::-1]).copy()
        pp = preprocess(bgr)
        rooms_geo = segment_rooms(extract_walls(pp["binary"]), pp["extent"])
        geo = arch.geometry_layer(pp["binary"])
        for rg in rooms_geo:
            rg["polygon"] = arch.snap_orthogonal(rg["polygon"])
        ortho = [arch.orthogonality(rg["polygon"]) for rg in rooms_geo]
        geometry = {
            "doors": len(geo["doors"]),
            "entrances": sum(d["perimeter"] for d in geo["doors"]),
            "columns": len(geo["columns"]),
            "staircases": len(geo["stairs"]),
            "scaleMetersPerPixel": (geo["scale"] or {}).get("metersPerPixel"),
            "scaleSource": (geo["scale"] or {}).get("source"),
            "avgBoundaryOrthogonality": round(sum(ortho) / max(1, len(ortho)), 3),
        }
        if not rooms_geo:
            warnings.append("no enclosed rooms detected")
        texts = labels or read_text(bgr)
        if not texts:
            warnings.append("OCR returned no labels; room types inferred heuristically")
        rooms_raw, zones = fuse(rooms_geo, texts, [])
        arch.type_rooms_by_geometry(rooms_raw, geo)

    accepted, rejected, _ = filter_rooms(rooms_raw, None)
    raw_places = suggest(accepted, zones)
    acc_p, rej_p, rejs = apply_placement_qc(raw_places, accepted, None)
    summary = build_summary(rooms_raw, accepted, rejected, raw_places, acc_p, rej_p, rejs, [])

    corrected = [r for r in rooms_raw if (r.get("meta") or {}).get("classificationSource") == "ocr_label"]
    return {
        "detectedSpaces": len(rooms_raw),
        "acceptedSpaces": len(accepted),
        "rejectedSpaces": len(rejected),
        "labelledSpaces": len(corrected),
        "spaceTypes": Counter(r["type"] for r in accepted),
        "avgRoomConfidence": round(sum(r["confidence"] for r in accepted) / max(1, len(accepted)), 3),
        "acceptedDevices": len(acc_p),
        "devicesByCategory": _by_category(acc_p),
        "geometry": geometry,
        "warnings": warnings + ([summary.get("summary")] if summary.get("summary") else []),
        "consistent": summary.get("consistent"),
    }


def eval_sample(sample_json):
    """Compare the rule-engine baseline against an engineer AFTER sample (ground truth).

    sample_json: {"rooms":[{type,centroid,area,...}], "zones":[...], "annotations":[{deviceCode,...}]}
    Computes per-device-class precision/recall on COUNTS (positions live on different rasters
    pre-alignment, so count-based comparison is the honest first metric)."""
    from app.rules.engine import suggest
    from app.rules.quality import filter_rooms, apply_placement_qc
    from collections import Counter
    rooms = sample_json.get("rooms", [])
    zones = sample_json.get("zones", [])
    for r in rooms:
        r.setdefault("confidence", 0.9); r.setdefault("source", "cv")
        r.setdefault("polygon", [[0, 0]]); r.setdefault("label", r.get("type"))
    accepted, _, _ = filter_rooms(rooms, None)
    acc_p, _, _ = apply_placement_qc(suggest(accepted, zones), accepted, None)
    pred = Counter(p["deviceCode"] for p in acc_p)
    truth = Counter(a["deviceCode"] for a in sample_json.get("annotations", []) if a.get("status") != "false_positive")
    classes = sorted(set(pred) | set(truth))
    per_class = {}
    tp_all = fp_all = fn_all = 0
    for c in classes:
        tp = min(pred[c], truth[c]); fp = max(0, pred[c] - truth[c]); fn = max(0, truth[c] - pred[c])
        tp_all += tp; fp_all += fp; fn_all += fn
        prec = tp / (tp + fp) if (tp + fp) else None
        rec = tp / (tp + fn) if (tp + fn) else None
        per_class[c] = {"truth": truth[c], "predicted": pred[c], "precision": prec, "recall": rec}
    micro_p = tp_all / (tp_all + fp_all) if (tp_all + fp_all) else None
    micro_r = tp_all / (tp_all + fn_all) if (tp_all + fn_all) else None
    return {"perClass": per_class, "microPrecision": round(micro_p, 3) if micro_p is not None else None,
            "microRecall": round(micro_r, 3) if micro_r is not None else None,
            "totalTruth": sum(truth.values()), "totalPredicted": sum(pred.values())}


def _fixture_villa():
    """A labelled single-street villa ground floor (mimics a clean OCR result)."""
    def box(cx, cy, h=0.05):
        return [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]]

    def R(t, label, cx, cy, a=0.05, conf=0.0, src="area_heuristic"):
        return {"label": label, "type": t, "polygon": box(cx, cy), "centroid": [cx, cy],
                "area": a, "confidence": conf or 0.85, "source": "cv",
                "meta": {"classificationSource": src}}

    rooms = [
        R("main_entrance", "Main Entrance", .5, .92, src="ocr_label"),
        R("majlis", "Majlis", .22, .3, .08, src="ocr_label"),
        R("dining", "Dining", .5, .25, .06, src="ocr_label"),
        R("living_room", "Living", .75, .35, .08, src="ocr_label"),
        R("kitchen", "Kitchen", .85, .7, src="ocr_label"),
        R("pantry", "Pantry", .7, .8, .03, src="ocr_label"),
        R("laundry", "Laundry", .9, .85, .03, src="ocr_label"),
        R("service_area", "Service", .1, .75, src="ocr_label"),
        R("maid_room", "Maid", .1, .9, .03, src="ocr_label"),
        R("electrical_room", "Electrical", .25, .85, .02, src="ocr_label"),
        R("master_bedroom", "Master", .3, .7, .07, src="ocr_label"),
        R("bedroom", "Bedroom", .5, .7, .05, src="ocr_label"),
        R("dressing", "Dressing", .38, .72, .02, src="ocr_label"),
        R("staircase", "Stair", .6, .55, .03, src="ocr_label"),
        R("corridor", "Corridor", .5, .5, .05, src="ocr_label"),
        R("bathroom", "WC", .85, .5, .03, src="ocr_label"),
        R("pool", "Pool", .8, .95, .06, src="ocr_label"),
        R("bbq", "BBQ", .65, .95, .02, src="ocr_label"),
    ]
    zones = [
        {"type": "gate", "geometry": {"kind": "point", "coords": [[.5, .99]]}, "confidence": .85, "source": "cv"},
        {"type": "street", "geometry": {"kind": "point", "coords": [[.5, 1.0]]}, "confidence": .8, "source": "cv"},
        {"type": "parking", "geometry": {"kind": "point", "coords": [[.2, .96]]}, "confidence": .8, "source": "cv"},
    ]
    return rooms, zones


def _print(m):
    print(f"  detected spaces      : {m['detectedSpaces']}")
    print(f"  accepted spaces      : {m['acceptedSpaces']}  (labelled: {m['labelledSpaces']})")
    print(f"  rejected spaces      : {m['rejectedSpaces']}")
    print(f"  avg room confidence  : {m['avgRoomConfidence']}")
    print(f"  space types          : {dict(m['spaceTypes'])}")
    print(f"  accepted devices     : {m['acceptedDevices']}  (consistent: {m['consistent']})")
    print(f"  devices by category  : {dict(m['devicesByCategory'])}")
    if m.get("geometry"):
        g = m["geometry"]
        print(f"  geometry             : doors={g['doors']} entrances={g['entrances']} "
              f"columns={g['columns']} staircases={g['staircases']}")
        print(f"  scale (m/px)         : {g['scaleMetersPerPixel']}  [{g['scaleSource']}]")
        print(f"  boundary orthogonality: {g['avgBoundaryOrthogonality']}")
    for w in m["warnings"]:
        print(f"  warning              : {w}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--image")
    ap.add_argument("--labels")
    ap.add_argument("--fixture", choices=["villa"])
    ap.add_argument("--sample", help="JSON with rooms/zones/annotations → rule-vs-truth eval")
    a = ap.parse_args()
    if a.sample:
        res = eval_sample(json.load(open(a.sample)))
        print(f"  rule-vs-ground-truth: micro P={res['microPrecision']} R={res['microRecall']} "
              f"(truth {res['totalTruth']} / predicted {res['totalPredicted']})")
        for c, m in res["perClass"].items():
            print(f"    {c:16} truth={m['truth']:>3} pred={m['predicted']:>3} P={m['precision']} R={m['recall']}")
        raise SystemExit(0)
    labels = json.load(open(a.labels)) if a.labels else None
    if not a.image and not a.fixture:
        ap.error("provide --image, --fixture or --sample")
    _print(run(image=a.image, labels=labels, fixture=a.fixture))
