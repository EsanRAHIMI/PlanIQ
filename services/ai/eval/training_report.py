# -*- coding: utf-8 -*-
"""Phase A reporting — build the import report, per-floor/project/dataset metrics, and
recomputed placement priors from the cached floor results (eval/_cache/floor_results.json).

Outputs JSON artifacts to eval/_out/ (import_report, metrics, priors) and prints a summary.
Priors are emitted in the PlacementPriors.perSpace shape so Phase B can load them straight
into Mongo. Metrics are count-based per engineer class (BEFORE/AFTER rasters differ).
"""
import json
import os
from collections import Counter, defaultdict

from eval.calibrate import ENGINEER_CLASSES, _prf
from eval.old_plans import CACHE

OUT = os.path.join(os.path.dirname(__file__), "_out")
os.makedirs(OUT, exist_ok=True)
RESULTS = os.path.join(CACHE, "floor_results.json")


def _assign(devs, rooms):
    """Bucket engineer device positions into nearest AI room type (for priors)."""
    out = []
    for d in devs:
        if not rooms:
            out.append(("unknown", d["deviceCode"]))
            continue
        best, bd = None, 1e9
        for r in rooms:
            cx, cy = r["centroid"]
            dist = (cx - d["x"]) ** 2 + (cy - d["y"]) ** 2
            if dist < bd:
                bd, best = dist, r
        out.append((best["type"], d["deviceCode"]))
    return out


def learn_priors(floors):
    """PlacementPriors.perSpace = spaceType→deviceCode→{meanCount, rate, n}. Also floorType."""
    space_inst = Counter()
    space_total = defaultdict(Counter)
    space_with = defaultdict(Counter)
    ftype = defaultdict(Counter)
    for fl in floors:
        rooms = fl["ai"]["rooms"]
        per_space_code = defaultdict(Counter)
        for sp, code in _assign(fl["engineerDevices"], rooms):
            per_space_code[sp][code] += 1
            ftype[fl["floorType"]][code] += 1
        for sp in set(r["type"] for r in rooms) | set(per_space_code):
            space_inst[sp] += 1
        for sp, codes in per_space_code.items():
            for code, n in codes.items():
                space_total[sp][code] += n
                space_with[sp][code] += 1
    per_space = {}
    for sp, inst in space_inst.items():
        inst = inst or 1
        per_space[sp] = {c: {"meanCount": round(space_total[sp][c] / inst, 2),
                             "rate": round(space_with[sp][c] / inst, 2),
                             "n": space_total[sp][c]} for c in space_total[sp]}
    return {"sampleN": len(floors), "perSpace": per_space, "perFloorType": {k: dict(v) for k, v in ftype.items()}}


def _apply_project_reconcile(floors):
    """Project-level pass: enforce building-wide singletons (ELV rack, gate, lock…) once per
    project on the best floor. Writes deviceCountsReconciled per floor."""
    from app.rules.project import reconcile_project
    from collections import Counter as _C, defaultdict as _dd
    by_proj = _dd(list)
    for fl in floors:
        by_proj[fl["project"]].append(fl)
    for proj, fls in by_proj.items():
        group = [{"floorType": f["floorType"],
                  "placements": [{"deviceCode": p["deviceCode"]} for p in f["ai"].get("placements", [])]}
                 for f in fls]
        reconcile_project(group)
        for f, g in zip(fls, group):
            f["ai"]["deviceCountsReconciled"] = dict(_C(p["deviceCode"] for p in g["placements"]))
    return floors


def build():
    floors = list(json.load(open(RESULTS)).values())
    floors.sort(key=lambda f: (f["project"], f["pageIndex"]))
    _apply_project_reconcile(floors)

    # ── aggregate + per-project P/R/F1 (engineer classes) ──
    # Compare baseline (rules only) vs loop-closed (rules + priors + floor-type policy).
    agg_truth, agg_pred, agg_all = Counter(), Counter(), Counter()
    agg_pred_base = Counter()
    per_project = defaultdict(lambda: [Counter(), Counter()])
    per_floortype = defaultdict(lambda: [Counter(), Counter()])
    per_floortype_base = defaultdict(lambda: [Counter(), Counter()])
    floor_rows = []
    for fl in floors:
        truth = Counter(fl["engineerDeviceCounts"])
        pred_all = Counter(fl["ai"].get("deviceCountsPriors", fl["ai"]["deviceCounts"]))
        base_all = Counter(fl["ai"]["deviceCounts"])
        pred_eng = Counter({c: n for c, n in pred_all.items() if c in ENGINEER_CLASSES})
        base_eng = Counter({c: n for c, n in base_all.items() if c in ENGINEER_CLASSES})
        agg_truth.update(truth); agg_pred.update(pred_eng); agg_all.update(pred_all)
        agg_pred_base.update(base_eng)
        per_floortype_base[fl["floorType"]][0].update(truth); per_floortype_base[fl["floorType"]][1].update(base_eng)
        per_project[fl["project"]][0].update(truth); per_project[fl["project"]][1].update(pred_eng)
        per_floortype[fl["floorType"]][0].update(truth); per_floortype[fl["floorType"]][1].update(pred_eng)
        u = fl["ai"]["understanding"]
        _, mi = _prf(truth, pred_eng, ENGINEER_CLASSES)
        floor_rows.append({
            "project": fl["project"], "page": fl["pageIndex"], "floorType": fl["floorType"],
            "matchConf": fl["matchConfidence"],
            "engineerDevices": sum(truth.values()), "aiEngineerDevices": sum(pred_eng.values()),
            "F1": round(mi["F1"], 2) if mi["F1"] is not None else None,
            "acceptedRooms": u["acceptedRooms"], "unclassified": u["unclassifiedRooms"],
            "bedroomPct": u["bedroomPct"], "ocrLabels": u["ocrLabels"], "doors": fl["ai"]["doors"],
        })
    # Honest per-floor micro (global pooling would let a wrong-floor device satisfy demand).
    micro, per_class = _micro_per_floor(floors, "deviceCountsReconciled")
    micro_base, _ = _micro_per_floor(floors, "deviceCounts")
    micro_priors, _ = _micro_per_floor(floors, "deviceCountsPriors")
    # roof false-positives before/after floor-type policy
    roof_fp_base = sum(per_floortype_base.get("roof", [Counter(), Counter()])[1].values())
    roof_fp_now = sum(per_floortype.get("roof", [Counter(), Counter()])[1].values())
    priors = learn_priors(floors)

    report = {
        "projects": len(set(f["project"] for f in floors)),
        "floors": len(floors),
        "engineerDevicesTotal": sum(agg_truth.values()),
        "aiEngineerDevicesTotal": sum(agg_pred.values()),
        "offDisciplineAI": {c: n for c, n in agg_all.items() if c not in ENGINEER_CLASSES},
        "micro": micro, "microBaseline": micro_base, "microPriors": micro_priors,
        "roofFalsePositives": {"baseline": roof_fp_base, "loopClosed": roof_fp_now},
        "perClass": per_class,
        "perProject": {p: _prf(t, pr, ENGINEER_CLASSES)[1] for p, (t, pr) in per_project.items()},
        "perFloorType": {ft: {"truth": sum(t.values()), "pred": sum(pr.values()), **_prf(t, pr, ENGINEER_CLASSES)[1]}
                          for ft, (t, pr) in per_floortype.items()},
        "floorRows": floor_rows,
    }
    json.dump(report, open(os.path.join(OUT, "metrics.json"), "w"), indent=2)
    json.dump(priors, open(os.path.join(OUT, "priors.json"), "w"), indent=2)
    return report, priors


def _micro_per_floor(floors, pred_key):
    """Honest micro P/R/F1: tp/fp/fn computed PER FLOOR then summed, so a device on the
    wrong floor cannot satisfy another floor's demand (global pooling hides that)."""
    tp = fp = fn = 0
    per_class = defaultdict(lambda: [0, 0, 0, 0, 0])  # truth,pred,tp,fp,fn
    for fl in floors:
        truth = Counter(fl["engineerDeviceCounts"])
        pred = Counter({c: n for c, n in Counter(fl["ai"].get(pred_key, {})).items() if c in ENGINEER_CLASSES})
        for c in ENGINEER_CLASSES:
            t, p = truth.get(c, 0), pred.get(c, 0)
            ctp, cfp, cfn = min(t, p), max(0, p - t), max(0, t - p)
            tp += ctp; fp += cfp; fn += cfn
            pc = per_class[c]; pc[0] += t; pc[1] += p; pc[2] += ctp; pc[3] += cfp; pc[4] += cfn
    P = tp / (tp + fp) if (tp + fp) else None
    R = tp / (tp + fn) if (tp + fn) else None
    F1 = (2 * P * R / (P + R)) if P and R else None
    pcr = {c: {"truth": v[0], "pred": v[1],
               "P": (v[2] / (v[2] + v[3]) if (v[2] + v[3]) else None),
               "R": (v[2] / (v[2] + v[4]) if (v[2] + v[4]) else None),
               "F1": (lambda p, r: 2 * p * r / (p + r) if p and r else None)(
                   v[2] / (v[2] + v[3]) if (v[2] + v[3]) else None,
                   v[2] / (v[2] + v[4]) if (v[2] + v[4]) else None)}
           for c, v in per_class.items() if v[0] or v[1]}
    return {"P": P, "R": R, "F1": F1, "tp": tp, "fp": fp, "fn": fn}, pcr


def _f(v):
    return " - " if v is None else f"{v:.2f}"


def main():
    rep, priors = build()
    print(f"IMPORT: {rep['projects']} projects / {rep['floors']} floors")
    print(f"engineer devices: {rep['engineerDevicesTotal']}   AI engineer-class devices: {rep['aiEngineerDevicesTotal']}")
    mb, mp, mi = rep["microBaseline"], rep["microPriors"], rep["micro"]
    print(f"\nDATASET micro (per-floor, honest):")
    print(f"  baseline (rules only)                 P={_f(mb['P'])} R={_f(mb['R'])} F1={_f(mb['F1'])}  (tp={mb['tp']} fp={mb['fp']} fn={mb['fn']})")
    print(f"  + priors + floor-type policy          P={_f(mp['P'])} R={_f(mp['R'])} F1={_f(mp['F1'])}  (tp={mp['tp']} fp={mp['fp']} fn={mp['fn']})")
    print(f"  + project singleton reconcile (final)  P={_f(mi['P'])} R={_f(mi['R'])} F1={_f(mi['F1'])}  (tp={mi['tp']} fp={mi['fp']} fn={mi['fn']})")
    rf = rep["roofFalsePositives"]
    print(f"roof false-positives: {rf['baseline']} → {rf['loopClosed']} (floor-type policy)")
    print("\nPer device class:")
    print(f"  {'device':16} {'truth':>5} {'pred':>5} {'P':>5} {'R':>5} {'F1':>5}")
    for c, m in rep["perClass"].items():
        print(f"  {c:16} {m['truth']:>5} {m['pred']:>5} {_f(m['P']):>5} {_f(m['R']):>5} {_f(m['F1']):>5}")
    print("\nPer floor type (engineer classes):")
    for ft, m in sorted(rep["perFloorType"].items()):
        print(f"  {ft:9} truth={m['truth']:>3} pred={m['pred']:>3} F1={_f(m['F1'])}")
    print("\nPer project micro F1:")
    for p, m in sorted(rep["perProject"].items(), key=lambda kv: int(kv[0].split()[-1])):
        print(f"  {p:12} F1={_f(m['F1'])} (truth={m['tp']+m['fn']:>3} tp={m['tp']:>3} fp={m['fp']:>3} fn={m['fn']:>3})")
    print(f"\noff-discipline AI devices (separate layers): {rep['offDisciplineAI']}")
    print(f"\npriors: {len(priors['perSpace'])} room types, {len(priors['perFloorType'])} floor types → eval/_out/priors.json")


if __name__ == "__main__":
    main()
