"""Placement quality control — conservative limits, space classification, accept/reject with reasons."""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

# ── Limits (villa-scale, conservative) ────────────────────────────────────────
MAX_ROOMS_PER_FLOOR = 18
MIN_ROOM_AREA = 0.012          # normalized; drop tiny CV fragments
MIN_ROOM_CONFIDENCE = 0.48
MAX_DEVICES_PER_FLOOR = 32
MIN_DEVICE_CONFIDENCE = 0.62
MAX_DEVICES_PER_ROOM = 3

PER_DEVICE_LIMITS: Dict[str, int] = {
    "CCTV": 6,
    "WIFI_AP": 3,
    "DATA_SOCKET": 5,
    "LIGHT_SWITCH": 6,
    "SENSOR": 4,
    "THERMOSTAT": 3,
    "SPEAKER": 2,
    "VOLUME_CONTROL": 1,
    "PROJECTOR": 1,
    "SCREEN": 1,
    "CURTAIN_MOTOR": 3,
    "SMART_LOCK": 2,
    "INTERCOM_SCREEN": 1,
    "INTERCOM_BELL": 1,
    "GATE_MOTOR": 1,
    "ELV_RACK": 1,
    "SWITCH": 1,
    "NVR": 1,
}

INDOOR_MAIN = {"living_room", "majlis", "master_bedroom", "bedroom", "dining", "kitchen", "sitting_area"}
INDOOR_SERVICE = {"service_area", "store", "bathroom", "maid_room"}
CIRCULATION = {"corridor", "entrance", "staircase", "lift", "main_door"}
OUTDOOR = {"outdoor", "garden", "parking", "gate", "roof"}
SKIP_PLACEMENT = OUTDOOR | {"bathroom", "roof", "lift", "store"}

WIFI_ROOMS = {"living_room", "majlis", "sitting_area"}
DATA_ROOMS = {"living_room", "majlis", "master_bedroom"}
SWITCH_ROOMS = {"entrance", "main_door", "corridor", "living_room", "majlis", "master_bedroom"}
MAIN_ENTERTAINMENT = {"majlis", "living_room"}


def space_category(room_type: str) -> str:
    if room_type in OUTDOOR:
        return "outdoor"
    if room_type in CIRCULATION:
        return "circulation"
    if room_type in INDOOR_SERVICE:
        return "service"
    if room_type in INDOOR_MAIN:
        return "indoor"
    return "other"


def _room_key(r: dict) -> Tuple:
    return tuple(round(c, 3) for pt in r["polygon"] for c in pt)


def filter_rooms(raw_rooms: List[dict]) -> Tuple[List[dict], List[dict], List[dict]]:
    """Return (accepted, rejected, reject_reasons)."""
    candidates = sorted(raw_rooms, key=lambda r: r["area"], reverse=True)
    accepted: List[dict] = []
    rejected: List[dict] = []
    reasons: List[dict] = []
    seen_keys = set()

    for r in candidates:
        copy = {**r, "meta": dict(r.get("meta") or {})}
        if r["area"] < MIN_ROOM_AREA:
            copy["meta"].update({"qcStatus": "rejected", "rejectionReason": "Area too small — likely wall gap or noise"})
            rejected.append(copy)
            reasons.append({"label": r.get("label"), "type": r.get("type"), "reason": copy["meta"]["rejectionReason"]})
            continue
        if r.get("confidence", 0) < MIN_ROOM_CONFIDENCE:
            copy["meta"].update({"qcStatus": "rejected", "rejectionReason": "Low-confidence space detection"})
            rejected.append(copy)
            reasons.append({"label": r.get("label"), "type": r.get("type"), "reason": copy["meta"]["rejectionReason"]})
            continue
        key = _room_key(r)
        if key in seen_keys:
            copy["meta"].update({"qcStatus": "rejected", "rejectionReason": "Duplicate region"})
            rejected.append(copy)
            continue
        seen_keys.add(key)
        if len(accepted) >= MAX_ROOMS_PER_FLOOR:
            copy["meta"].update({"qcStatus": "rejected", "rejectionReason": f"Exceeded max {MAX_ROOMS_PER_FLOOR} spaces per floor"})
            rejected.append(copy)
            reasons.append({"label": r.get("label"), "type": r.get("type"), "reason": copy["meta"]["rejectionReason"]})
            continue
        copy["meta"].update({"qcStatus": "accepted", "spaceCategory": space_category(r["type"])})
        accepted.append(copy)

    return accepted, rejected, reasons


def _nearest_room(x: float, y: float, rooms: List[dict]) -> Optional[dict]:
    best, best_d = None, 1e9
    for r in rooms:
        cx, cy = r["centroid"]
        d = (cx - x) ** 2 + (cy - y) ** 2
        if d < best_d:
            best_d, best = d, r
    return best


def apply_placement_qc(
    placements: List[dict],
    rooms: List[dict],
) -> Tuple[List[dict], List[dict], List[dict]]:
    """Accept/reject placements with reasons. Rejected are marked hidden."""
    accepted: List[dict] = []
    rejected: List[dict] = []
    rejections: List[dict] = []
    device_counts: Dict[str, int] = {}
    room_device_counts: Dict[str, int] = {}

    # Prefer higher confidence first
    ordered = sorted(placements, key=lambda p: p.get("confidence") or 0, reverse=True)

    for p in ordered:
        code = p["deviceCode"]
        conf = p.get("confidence") or 0
        pos = p.get("position") or {}
        near = _nearest_room(pos.get("x", 0.5), pos.get("y", 0.5), rooms)
        room_type = near["type"] if near else "unknown"
        room_label = near.get("label", room_type) if near else "unknown"
        room_id = room_label
        meta = dict(p.get("meta") or {})
        meta["spaceCategory"] = space_category(room_type) if near else "unknown"

        def reject(reason: str):
            meta.update({"qcStatus": "rejected", "rejectionReason": reason})
            out = {**p, "meta": meta, "hidden": True}
            rejected.append(out)
            rejections.append({"deviceCode": code, "reason": reason, "confidence": conf, "nearSpace": room_label})

        if conf < MIN_DEVICE_CONFIDENCE:
            reject(f"Confidence {conf:.2f} below threshold {MIN_DEVICE_CONFIDENCE}")
            continue
        if len(accepted) >= MAX_DEVICES_PER_FLOOR:
            reject(f"Floor device limit ({MAX_DEVICES_PER_FLOOR}) reached")
            continue
        if device_counts.get(code, 0) >= PER_DEVICE_LIMITS.get(code, 2):
            reject(f"Max {PER_DEVICE_LIMITS.get(code, 2)} × {code} per floor")
            continue
        if room_device_counts.get(room_id, 0) >= MAX_DEVICES_PER_ROOM:
            reject(f"Max {MAX_DEVICES_PER_ROOM} devices per space ({room_label})")
            continue

        # Device-specific conservative rules
        if code == "WIFI_AP" and room_type not in WIFI_ROOMS:
            reject("Wi-Fi AP only in central indoor zones (living/majlis/sitting)")
            continue
        if code == "DATA_SOCKET" and room_type not in DATA_ROOMS:
            reject("Data points limited to main rooms")
            continue
        if code == "LIGHT_SWITCH" and room_type not in SWITCH_ROOMS:
            reject("Switches placed near doors/main rooms only")
            continue
        if code in {"SPEAKER", "VOLUME_CONTROL", "PROJECTOR", "SCREEN"} and room_type not in MAIN_ENTERTAINMENT:
            reject("Entertainment devices limited to majlis/living")
            continue
        if code == "CURTAIN_MOTOR" and room_type not in {"bedroom", "master_bedroom", "living_room", "majlis"}:
            reject("Curtain motors limited to primary rooms")
            continue
        if near and room_type in SKIP_PLACEMENT and code not in {"CCTV"}:
            reject(f"No indoor devices in {room_type} spaces")
            continue
        if code == "CCTV" and near and room_type in INDOOR_MAIN and "corner" not in (p.get("rationale") or "").lower():
            reject("Indoor CCTV limited to perimeter/circulation")
            continue

        meta.update({"qcStatus": "accepted", "rejectionReason": None, "nearSpace": room_label})
        accepted.append({**p, "meta": meta, "hidden": False})
        device_counts[code] = device_counts.get(code, 0) + 1
        room_device_counts[room_id] = room_device_counts.get(room_id, 0) + 1

    return accepted, rejected, rejections


def build_summary(
    raw_rooms: List[dict],
    accepted_rooms: List[dict],
    rejected_rooms: List[dict],
    raw_placements: List[dict],
    accepted_placements: List[dict],
    rejected_placements: List[dict],
    placement_rejections: List[dict],
    room_rejections: List[dict],
) -> dict:
    return {
        "detectedSpaces": len(raw_rooms),
        "acceptedSpaces": len(accepted_rooms),
        "rejectedSpaces": len(rejected_rooms),
        "rawPlacements": len(raw_placements),
        "acceptedPlacements": len(accepted_placements),
        "rejectedPlacements": len(rejected_placements),
        "rejections": placement_rejections + [
            {"deviceCode": "-", "reason": r["reason"], "nearSpace": r.get("label")} for r in room_rejections
        ],
    }
