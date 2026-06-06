"""Placement quality control — conservative limits, space classification, accept/reject with reasons."""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

# ── Limits ────────────────────────────────────────────────────────────────────
# P5 philosophy: the rule engine now places devices deliberately per the customer's
# engineering rules, so QC is a GUARDRAIL (sanity caps, dedup, consistency) — not a
# gate that re-rejects by room type. Caps are villa-scale, not conservative throttles.
MAX_ROOMS_PER_FLOOR = 24
MIN_ROOM_AREA = 0.012          # normalized; drop tiny CV fragments
# Policy: geometry that segments a real region is KEPT for the engineer to review, not
# silently rejected. A confidence below the review threshold flags the space as
# "needs review" (so the floor is never empty when rooms exist) instead of dropping it.
# A confidence rejection only happens if the caller explicitly sets minRoomConfidence.
REVIEW_ROOM_CONFIDENCE = 0.6
MIN_ROOM_CONFIDENCE = 0.48     # back-compat default for explicit overrides/tests
MAX_DEVICES_PER_FLOOR = 160
MIN_DEVICE_CONFIDENCE = 0.62
# Per-room budget counts ONLY room-anchored devices (perimeter/zone devices like the
# building cameras and gate motor are excluded), so they no longer starve a room.
MAX_DEVICES_PER_ROOM = 12

PER_DEVICE_LIMITS: Dict[str, int] = {
    "CCTV": 12,
    "WIFI_AP": 8,
    "DATA_SOCKET": 20,
    "LIGHT_SWITCH": 30,
    "SENSOR": 20,
    "THERMOSTAT": 10,
    "SPEAKER": 24,
    "VOLUME_CONTROL": 12,
    "PROJECTOR": 2,
    "SCREEN": 2,
    "CURTAIN_MOTOR": 8,
    "SMART_LOCK": 3,
    "INTERCOM_SCREEN": 6,
    "INTERCOM_BELL": 4,
    "GATE_MOTOR": 2,
    "ELV_RACK": 1,
    "SWITCH": 2,
    "NVR": 2,
}

INDOOR_MAIN = {"living_room", "majlis", "master_bedroom", "bedroom", "dining", "kitchen", "sitting_area", "dressing"}
INDOOR_SERVICE = {"service_area", "store", "store_indoor", "bathroom", "maid_room", "laundry", "pantry", "electrical_room"}
CIRCULATION = {"corridor", "entrance", "main_entrance", "guest_entrance", "service_entrance", "staircase", "lift", "main_door"}
OUTDOOR = {"outdoor", "garden", "parking", "gate", "roof", "pool", "bbq", "outdoor_seating", "store_outdoor"}
# Pure-outdoor spaces never host an indoor device (cameras are exempt). Service rooms,
# bathrooms (toilets get sensors), kitchens (get cameras) and stores are NOT skipped —
# the engine targets them deliberately per the customer rules.
SKIP_PLACEMENT = OUTDOOR
# Dedup: two same-code devices closer than this (normalized) are treated as duplicates.
DEDUP_DIST = 0.012


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


def _ov(overrides: Optional[dict], key: str, default):
    """Read an override value, ignoring None so unset fields keep their defaults."""
    if not overrides:
        return default
    v = overrides.get(key)
    return v if v is not None else default


def filter_rooms(raw_rooms: List[dict], overrides: Optional[dict] = None) -> Tuple[List[dict], List[dict], List[dict]]:
    """Return (accepted, rejected, reject_reasons).

    Geometry-segmented regions are kept for review unless they are noise (too small),
    duplicates, or over the per-floor cap. Confidence no longer rejects a real region by
    default — low confidence flags it 'needs review' so the floor is never empty when
    rooms exist. An explicit minRoomConfidence override restores hard rejection."""
    max_rooms = _ov(overrides, "maxRoomsPerFloor", MAX_ROOMS_PER_FLOOR)
    # Only reject on confidence when the caller explicitly asks for it.
    hard_min_conf = overrides.get("minRoomConfidence") if overrides else None

    candidates = sorted(raw_rooms, key=lambda r: r["area"], reverse=True)
    accepted: List[dict] = []
    rejected: List[dict] = []
    reasons: List[dict] = []
    seen_keys = set()

    for r in candidates:
        copy = {**r, "meta": dict(r.get("meta") or {})}
        conf = r.get("confidence", 0) or 0
        if r["area"] < MIN_ROOM_AREA:
            copy["meta"].update({"qcStatus": "rejected", "rejectionReason": "Area too small — likely wall gap or noise"})
            rejected.append(copy)
            reasons.append({"label": r.get("label"), "type": r.get("type"), "reason": copy["meta"]["rejectionReason"]})
            continue
        if hard_min_conf is not None and conf < hard_min_conf:
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
        if len(accepted) >= max_rooms:
            copy["meta"].update({"qcStatus": "rejected", "rejectionReason": f"Exceeded max {max_rooms} spaces per floor"})
            rejected.append(copy)
            reasons.append({"label": r.get("label"), "type": r.get("type"), "reason": copy["meta"]["rejectionReason"]})
            continue
        # Accepted. Flag low-confidence or unclassified spaces for review rather than dropping.
        needs_review = conf < REVIEW_ROOM_CONFIDENCE or r.get("type") == "unclassified"
        copy["meta"].update({
            "qcStatus": "accepted",
            "spaceCategory": space_category(r["type"]),
            "needsReview": bool(needs_review),
        })
        if needs_review:
            copy["meta"]["reviewReason"] = (
                "Unclassified — confirm the room type" if r.get("type") == "unclassified"
                else "Low-confidence type — confirm or correct"
            )
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


def placement_basis(p: dict) -> str:
    """room | zone | perimeter — what a suggestion is anchored to. Prefers the explicit
    tag set by the rule engine; infers from the rationale only as a fallback for older data."""
    b = (p.get("meta") or {}).get("basis")
    if b in ("room", "zone", "perimeter"):
        return b
    r = (p.get("rationale") or "").lower()
    if "corner" in r or "perimeter" in r:
        return "perimeter"
    if "gate" in r or "parking" in r:
        return "zone"
    return "room"


def apply_placement_qc(
    placements: List[dict],
    rooms: List[dict],
    overrides: Optional[dict] = None,
) -> Tuple[List[dict], List[dict], List[dict]]:
    """Accept/reject placements with reasons. Rejected are marked hidden.

    Internal-consistency guarantee: a *room-based* device can never be accepted when no
    interior spaces were accepted. Zone/perimeter devices (gate, parking, building
    perimeter) may still appear with zero rooms, but are clearly tagged as a
    perimeter/zone fallback so counts and the summary stay trustworthy."""
    max_devices = _ov(overrides, "maxDevicesPerFloor", MAX_DEVICES_PER_FLOOR)
    min_conf = _ov(overrides, "minDeviceConfidence", MIN_DEVICE_CONFIDENCE)
    max_per_room = _ov(overrides, "maxDevicesPerRoom", MAX_DEVICES_PER_ROOM)
    has_rooms = len(rooms) > 0

    accepted: List[dict] = []
    rejected: List[dict] = []
    rejections: List[dict] = []
    device_counts: Dict[str, int] = {}
    room_device_counts: Dict[str, int] = {}
    seen_positions: List[Tuple[str, float, float]] = []

    # Prefer higher confidence first
    ordered = sorted(placements, key=lambda p: p.get("confidence") or 0, reverse=True)

    for p in ordered:
        code = p["deviceCode"]
        conf = p.get("confidence") or 0
        pos = p.get("position") or {}
        px, py = pos.get("x", 0.5), pos.get("y", 0.5)
        near = _nearest_room(px, py, rooms)
        room_type = near["type"] if near else "unknown"
        room_label = near.get("label", room_type) if near else "unknown"
        room_id = room_label
        basis = placement_basis(p)
        meta = dict(p.get("meta") or {})
        meta["basis"] = basis
        meta["spaceCategory"] = space_category(room_type) if near else "unknown"

        def reject(reason: str):
            meta.update({"qcStatus": "rejected", "rejectionReason": reason})
            out = {**p, "meta": meta, "hidden": True}
            rejected.append(out)
            rejections.append({"deviceCode": code, "reason": reason, "confidence": conf, "nearSpace": room_label})

        # 1) Consistency: room-based devices require at least one accepted interior space.
        if basis == "room" and not has_rooms:
            reject("No interior spaces accepted — room-based device suppressed for consistency")
            continue
        # 2) Confidence floor.
        if conf < min_conf:
            reject(f"Confidence {conf:.2f} below threshold {min_conf}")
            continue
        # 3) Dedup near-identical suggestions of the same device.
        if any(c == code and abs(sx - px) < DEDUP_DIST and abs(sy - py) < DEDUP_DIST for c, sx, sy in seen_positions):
            reject("Duplicate of a nearby identical device")
            continue
        # 4) Villa-scale sanity caps (guardrail, not policy).
        if len(accepted) >= max_devices:
            reject(f"Floor device limit ({max_devices}) reached")
            continue
        if device_counts.get(code, 0) >= PER_DEVICE_LIMITS.get(code, 8):
            reject(f"Max {PER_DEVICE_LIMITS.get(code, 8)} × {code} per floor")
            continue
        # Per-room budget counts only ROOM-anchored devices, so perimeter/zone devices
        # (building cameras, gate motor) never consume a room's budget.
        if basis == "room" and room_device_counts.get(room_id, 0) >= max_per_room:
            reject(f"Max {max_per_room} devices per space ({room_label})")
            continue
        # 5) Never place a non-camera indoor device in a pure-outdoor space.
        if basis == "room" and near and room_type in SKIP_PLACEMENT and code != "CCTV":
            reject(f"No indoor devices in outdoor {room_type}")
            continue

        meta.update({"qcStatus": "accepted", "rejectionReason": None, "nearSpace": room_label})
        accepted_p = {**p, "meta": meta, "hidden": False}
        # When there are no interior rooms, surviving zone/perimeter devices are clearly
        # labelled as a fallback so the user understands they are not tied to a room.
        if basis in ("zone", "perimeter") and not has_rooms:
            meta["placementContext"] = "perimeter_fallback"
            base_rationale = accepted_p.get("rationale") or code
            accepted_p["rationale"] = f"[Perimeter/zone fallback — no interior spaces detected] {base_rationale}"
            accepted_p["label"] = accepted_p.get("label") or f"{code} (perimeter/zone fallback)"
        accepted.append(accepted_p)
        device_counts[code] = device_counts.get(code, 0) + 1
        if basis == "room":
            room_device_counts[room_id] = room_device_counts.get(room_id, 0) + 1
        seen_positions.append((code, px, py))

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
    accepted_spaces = len(accepted_rooms)
    accepted_devices = len(accepted_placements)

    # Device breakdown by what each accepted suggestion is anchored to.
    room_based = sum(1 for p in accepted_placements if placement_basis(p) == "room")
    zone_based = sum(1 for p in accepted_placements if placement_basis(p) == "zone")
    perimeter_based = sum(1 for p in accepted_placements if placement_basis(p) == "perimeter")
    fallback_devices = zone_based + perimeter_based

    # Counts must reconcile by construction; surface a flag so the UI/QA can trust them.
    consistent = (
        room_based + zone_based + perimeter_based == accepted_devices
        and len(raw_placements) == accepted_devices + len(rejected_placements)
        and not (accepted_spaces == 0 and room_based > 0)
    )

    if accepted_spaces == 0 and accepted_devices == 0:
        summary = (
            "No interior spaces were confidently detected and no devices were placed. "
            "Try a higher-resolution plan or verify the drawing quality, then re-run analysis."
        )
    elif accepted_spaces == 0 and accepted_devices > 0:
        summary = (
            f"No interior spaces were confidently detected. The {accepted_devices} suggestion(s) "
            f"shown are perimeter/zone-based only (e.g. gate, parking, building perimeter) and are "
            f"NOT tied to interior rooms — treat them as fallback placements and review the plan."
        )
    else:
        fallback_note = (
            f", {fallback_devices} perimeter/zone-based" if fallback_devices else ""
        )
        summary = (
            f"Detected {len(raw_rooms)} space(s); {accepted_spaces} accepted. "
            f"Placed {accepted_devices} device(s): {room_based} room-based{fallback_note}. "
            f"{len(rejected_placements)} suggestion(s) withheld by QC."
        )

    return {
        "detectedSpaces": len(raw_rooms),
        "acceptedSpaces": accepted_spaces,
        "rejectedSpaces": len(rejected_rooms),
        "rawPlacements": len(raw_placements),
        "acceptedPlacements": accepted_devices,
        "rejectedPlacements": len(rejected_placements),
        "roomBasedPlacements": room_based,
        "zoneBasedPlacements": zone_based,
        "perimeterBasedPlacements": perimeter_based,
        "consistent": consistent,
        "summary": summary,
        "rejections": placement_rejections + [
            {"deviceCode": "-", "reason": r["reason"], "nearSpace": r.get("label")} for r in room_rejections
        ],
    }
