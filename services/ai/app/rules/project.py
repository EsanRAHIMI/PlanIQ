# -*- coding: utf-8 -*-
"""Project-level (cross-floor) reconciliation — multi-floor intelligence.

The per-floor rule engine has no knowledge of the whole building, so it places building-wide
singletons (the ELV rack, its switch/NVR) on EVERY floor, and access devices (gate motor,
smart lock, outdoor intercom) on multiple floors. Engineers place these ONCE per project, on
the right floor. This pass runs AFTER per-floor suggestion and keeps one instance on the most
appropriate floor — turning per-floor output into a coherent project design.

Inputs/outputs are plain dicts so this is reusable by the AI service and the API orchestration.
"""
from typing import Dict, List

# Building-wide singletons → preferred floor types, best first.
PROJECT_SINGLETONS = {
    "ELV_RACK": ["ground", "first", "basement", "site"],
    "SWITCH": ["ground", "first", "basement", "site"],
    "NVR": ["ground", "first", "basement", "site"],
}
# Access devices live at the entrance/gate — site, else ground. One per project.
ACCESS_SINGLETONS = {
    "GATE_MOTOR": ["site", "ground"],
    "SMART_LOCK": ["site", "ground"],
    "INTERCOM_BELL": ["site", "ground"],
}


def _floor_rank(floor_type: str, pref: List[str]) -> int:
    ft = (floor_type or "").lower()
    return pref.index(ft) if ft in pref else len(pref)


def reconcile_project(floors: List[Dict]) -> List[Dict]:
    """`floors`: [{floorType, placements:[{deviceCode,...}]}] for ONE project (mutated +
    returned). Keeps each building-wide singleton on its best floor; drops the rest."""
    singleton_pref = {**PROJECT_SINGLETONS, **ACCESS_SINGLETONS}
    # choose the winning floor index per device code
    winners: Dict[str, int] = {}
    for code, pref in singleton_pref.items():
        best_i, best_rank = None, 1e9
        for i, fl in enumerate(floors):
            if any(p["deviceCode"] == code for p in fl.get("placements", [])):
                rank = _floor_rank(fl.get("floorType"), pref)
                if rank < best_rank:
                    best_rank, best_i = rank, i
        if best_i is not None:
            winners[code] = best_i
    # drop singleton instances on non-winning floors (and dedupe to one on the winner)
    for code, win in winners.items():
        for i, fl in enumerate(floors):
            pls = fl.get("placements", [])
            if i != win:
                fl["placements"] = [p for p in pls if p["deviceCode"] != code]
            else:
                seen = False
                kept = []
                for p in pls:
                    if p["deviceCode"] == code:
                        if seen:
                            continue
                        seen = True
                    kept.append(p)
                fl["placements"] = kept
    return floors
