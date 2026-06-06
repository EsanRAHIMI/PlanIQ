# -*- coding: utf-8 -*-
"""Learned-prior consumption for the rule engine — the closed half of the learning loop.

Priors NEVER decide which devices exist (the rule engine + customer rules do that). They
only (a) NUDGE a placement's confidence by how often engineers put that device in that
space type, and (b) let a floor-type policy SUPPRESS placements engineers never make on a
given floor (e.g. roofs). This mirrors packages/shared/src/training.ts `hybridScore`, with
detector weight = 0 until an approved YOLO model exists.

Priors shape (PlacementPriors.perSpace): { spaceType: { deviceCode: {meanCount, rate, n} } }.
"""
from typing import Any, Dict, List, Optional

# Same default weights as the TS hybridScore. `detector` stays 0 until a model is approved.
DEFAULT_WEIGHTS = {"rule": 1.0, "prior": 0.25, "detector": 0.0, "qc": 0.15, "feedback": 0.2}

# Floors where engineers place no interior devices (learned: perFloorType.roof is empty).
# Interior/room-anchored devices are suppressed; explicit perimeter/zone devices are kept.
NO_INTERIOR_FLOORS = {"roof"}


def hybrid_score(rule_conf: float, prior_rate: Optional[float], qc_pass: bool = True,
                 rejection_rate: float = 0.0, detector_agreement: float = 0.0,
                 weights: Dict[str, float] = None) -> float:
    """Blend rule confidence + prior rate (+ qc, − feedback) into a final confidence."""
    w = weights or DEFAULT_WEIGHTS
    prior_term = prior_rate if prior_rate is not None else 0.0
    qc_term = 1.0 if qc_pass else 0.0
    raw = (w["rule"] * rule_conf + w["prior"] * prior_term
           + w["detector"] * detector_agreement + w["qc"] * qc_term
           - w["feedback"] * rejection_rate)
    norm = w["rule"] + w["prior"] + w["detector"] + w["qc"]  # feedback only subtracts
    return round(min(1.0, max(0.0, raw / (norm or 1.0))), 3)


def _nearest_room_type(placement: dict, rooms: List[dict]) -> Optional[str]:
    pos = placement.get("position") or {}
    px, py = pos.get("x", 0.5), pos.get("y", 0.5)
    best, bd = None, 1e9
    for r in rooms:
        cx, cy = r["centroid"]
        d = (cx - px) ** 2 + (cy - py) ** 2
        if d < bd:
            bd, best = d, r
    return best["type"] if best else None


def apply_priors(placements: List[Dict[str, Any]], rooms: List[Dict[str, Any]],
                 priors: Optional[Dict], floor_type: Optional[str] = None,
                 detector_active: bool = False) -> List[Dict[str, Any]]:
    """Nudge confidences by learned priors and annotate provenance. Returns the same list
    (devices unchanged) — customer rules still decide what is placed. `detector_active`
    flips the detector weight on only when an approved YOLO model is in production."""
    per_space = (priors or {}).get("perSpace") or {}
    weights = dict(DEFAULT_WEIGHTS)
    if detector_active:
        weights["detector"] = 0.2
    for p in placements:
        meta = p.setdefault("meta", {})
        rule_conf = p.get("confidence", 0.7)
        sp = _nearest_room_type(p, rooms)
        prior = None
        if sp and sp in per_space:
            entry = per_space[sp].get(p["deviceCode"])
            if entry:
                prior = entry.get("rate")
        # hybridScore is recorded for explainability / ranking / the future detector.
        meta["priorSpaceType"] = sp
        meta["priorRate"] = prior
        meta["hybridScore"] = hybrid_score(rule_conf, prior, qc_pass=True, weights=weights)
        meta["learnedFrom"] = "engineer_priors" if prior is not None else "rule_only"
        # Confidence is nudged UPWARD ONLY where engineers commonly place this device in
        # this space type (rate > 0.5). Absent/low priors never reduce a rule's confidence,
        # so the loop reinforces engineer-backed placements without suppressing valid ones
        # (no recall loss) — customer rules still decide what is placed.
        if prior is not None and prior > 0.5:
            p["confidence"] = round(min(0.97, rule_conf + 0.15 * (prior - 0.5)), 3)
    return placements


def is_no_interior_floor(floor_type: Optional[str]) -> bool:
    return (floor_type or "").lower() in NO_INTERIOR_FLOORS
