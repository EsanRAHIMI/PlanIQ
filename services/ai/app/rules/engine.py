"""Conservative device-placement rule engine. Fewer, higher-confidence suggestions."""
from typing import List, Dict, Any
import itertools

_counter = itertools.count()

# Per-category caps applied before QC pass
MAX_WIFI_PER_FLOOR = 2


def _place(code, x, y, rationale, confidence=0.7, rotation=0, props=None):
    return {
        "deviceCode": code, "position": {"x": round(x, 4), "y": round(y, 4)},
        "rotation": rotation, "scale": 1, "locked": False, "hidden": False,
        "source": "ai", "reviewed": False, "rationale": rationale,
        "confidence": confidence, "props": props or {}, "zIndex": next(_counter),
    }


def _bbox(rooms):
    if not rooms:
        return None
    xs = [p[0] for r in rooms for p in r["polygon"]]
    ys = [p[1] for r in rooms for p in r["polygon"]]
    return (min(xs), min(ys), max(xs), max(ys))


def _largest(rooms, types):
    cands = [r for r in rooms if r["type"] in types]
    return max(cands, key=lambda r: r["area"], default=None)


def suggest(rooms: List[Dict[str, Any]], zones: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    by = lambda t: [r for r in rooms if r["type"] == t]
    bb = _bbox(rooms)

    # CCTV — building corners + gate/parking/circulation only
    if bb:
        x0, y0, x1, y1 = bb
        ins = 0.012
        for x, y, rot, why in [
            (x0 + ins, y0 + ins, 135, "NW external corner — perimeter CCTV"),
            (x1 - ins, y0 + ins, 225, "NE external corner — perimeter CCTV"),
            (x1 - ins, y1 - ins, 315, "SE external corner — perimeter CCTV"),
            (x0 + ins, y1 - ins, 45, "SW external corner — perimeter CCTV"),
        ]:
            out.append(_place("CCTV", x, y, why, 0.78, rot))

    for z in zones:
        coords = z["geometry"]["coords"]
        cx, cy = coords[0] if coords else [0.5, 0.95]
        if z["type"] == "gate":
            out.append(_place("CCTV", cx, max(0, cy - 0.03), "Gate overview CCTV", 0.8))
            out.append(_place("GATE_MOTOR", cx, cy, "Main gate motor", 0.86))
            out.append(_place("INTERCOM_BELL", min(1, cx + 0.03), cy, "Gate intercom call point", 0.82))
        elif z["type"] == "parking":
            out.append(_place("CCTV", cx, cy, "Parking area CCTV", 0.76))

    # One corridor CCTV if present
    corridors = by("corridor")
    if corridors:
        c = max(corridors, key=lambda r: r["area"])
        out.append(_place("CCTV", c["centroid"][0], c["centroid"][1], f"Main corridor CCTV — {c['label']}", 0.72))

    # Entrance — single set
    entrances = by("main_door") + by("entrance")
    if entrances:
        e = entrances[0]
        x, y = e["centroid"]
        out.append(_place("SMART_LOCK", x, y, "Smart lock at main entrance", 0.84))
        out.append(_place("INTERCOM_SCREEN", min(1, x + 0.02), y, "Indoor intercom at entrance", 0.8, props={"mountHeight": 1.4}))
        out.append(_place("SENSOR", x, y, "Entry motion sensor", 0.72, props={"kind": "motion"}))

    # Wi-Fi — central indoor zones, max 2 APs on largest spaces
    wifi_candidates = sorted(
        [r for r in rooms if r["type"] in {"living_room", "majlis", "sitting_area"}],
        key=lambda r: r["area"], reverse=True,
    )[:MAX_WIFI_PER_FLOOR]
    for r in wifi_candidates:
        cx, cy = r["centroid"]
        out.append(_place("WIFI_AP", cx, cy, f"Central Wi-Fi AP — {r['label']}", 0.74, props={"coverageRadius": 12}))

    # ELV rack — service area only
    rack = by("service_area")
    if rack:
        x, y = rack[0]["centroid"]
        out.append(_place("ELV_RACK", x, y, f"ELV rack — {rack[0]['label']}", 0.78))
        out.append(_place("SWITCH", x + 0.01, y, "Core network switch", 0.76))
        out.append(_place("NVR", x - 0.01, y, "NVR with rack", 0.76))

    # Thermostats — up to 3 main rooms
    for r in sorted(
        [r for r in rooms if r["type"] in {"master_bedroom", "living_room", "majlis"}],
        key=lambda x: x["area"], reverse=True,
    )[:3]:
        out.append(_place("THERMOSTAT", r["centroid"][0], min(1, r["centroid"][1] + 0.04),
                          f"Thermostat — {r['label']}", 0.74, props={"mountHeight": 1.4}))

    # Entertainment — single largest majlis/living only
    ent = _largest(rooms, {"majlis", "living_room"})
    if ent:
        cx, cy = ent["centroid"]
        out.append(_place("SPEAKER", cx - 0.04, cy, f"Ceiling speaker (L) — {ent['label']}", 0.7))
        out.append(_place("SPEAKER", cx + 0.04, cy, f"Ceiling speaker (R) — {ent['label']}", 0.7))
        out.append(_place("VOLUME_CONTROL", cx, min(1, cy + 0.05), f"Volume control — {ent['label']}", 0.68, props={"mountHeight": 1.3}))

    # Projector — majlis only if present, else living
    proj_room = by("majlis")[0] if by("majlis") else (_largest(rooms, {"living_room"}) if _largest(rooms, {"living_room"}) else None)
    if proj_room:
        cx, cy = proj_room["centroid"]
        out.append(_place("PROJECTOR", cx, cy, f"Projector — {proj_room['label']}", 0.66, props={"mountHeight": 2.8}))
        out.append(_place("SCREEN", cx, max(0, cy - 0.06), f"Screen — {proj_room['label']}", 0.66))

    # Curtain motors — master + living max
    for r in sorted(
        [r for r in rooms if r["type"] in {"master_bedroom", "living_room", "majlis"}],
        key=lambda x: x["area"], reverse=True,
    )[:2]:
        top = min((p[1] for p in r["polygon"]), default=r["centroid"][1]) + 0.005
        out.append(_place("CURTAIN_MOTOR", r["centroid"][0], top, f"Curtain motor — {r['label']}", 0.65))

    # Sensors — circulation only
    for r in (by("corridor") + by("staircase") + by("entrance"))[:2]:
        out.append(_place("SENSOR", r["centroid"][0], r["centroid"][1], f"Motion sensor — {r['label']}", 0.7, props={"kind": "motion"}))

    # Light switches — entrance + main rooms (not every region)
    for r in (by("entrance") + by("main_door") + by("corridor"))[:2]:
        out.append(_place("LIGHT_SWITCH", min(1, r["centroid"][0] + 0.02), min(1, r["centroid"][1] + 0.02),
                          f"Switch by door — {r['label']}", 0.68, props={"mountHeight": 1.3}))
    for r in sorted([r for r in rooms if r["type"] in {"living_room", "majlis", "master_bedroom"}], key=lambda x: x["area"], reverse=True)[:3]:
        out.append(_place("LIGHT_SWITCH", min(1, r["centroid"][0] + 0.02), min(1, r["centroid"][1] + 0.02),
                          f"Room lighting — {r['label']}", 0.67, props={"mountHeight": 1.3}))

    # Data sockets — main rooms only
    for r in sorted([r for r in rooms if r["type"] in {"living_room", "majlis", "master_bedroom"}], key=lambda x: x["area"], reverse=True)[:3]:
        out.append(_place("DATA_SOCKET", max(0, r["centroid"][0] - 0.03), min(1, r["centroid"][1] + 0.03),
                          f"Data point — {r['label']}", 0.68))

    return out
