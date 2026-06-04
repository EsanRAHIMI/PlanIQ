"""Device-placement rule engine — encodes the customer's ELV/smart-home engineering rules.

Mirror of packages/shared/src/rules.ts (keep both in sync). Placements are anchored to
accepted/corrected spaces; each carries meta.basis (room|zone|perimeter) so QC can reconcile
device counts. See docs/RULES-MAPPING.md for the rule→logic mapping and known geometry gaps.
"""
from typing import List, Dict, Any
import itertools
import math

_counter = itertools.count()

# A corridor whose long/short bbox ratio is at least this is treated as a "long corridor"
# (extra Wi-Fi AP) per the customer rule.
LONG_CORRIDOR_ASPECT = 3.0
# A corridor with at least this normalized area is wide enough to act as a living hall.
HALL_AREA = 0.06


def _place(code, x, y, rationale, confidence=0.7, rotation=0, props=None, basis="room"):
    """basis ∈ {room, zone, perimeter}."""
    return {
        "deviceCode": code, "position": {"x": round(min(1, max(0, x)), 4), "y": round(min(1, max(0, y)), 4)},
        "rotation": rotation, "scale": 1, "locked": False, "hidden": False,
        "source": "ai", "reviewed": False, "rationale": rationale,
        "confidence": confidence, "props": props or {}, "zIndex": next(_counter),
        "meta": {"basis": basis},
    }


def _bbox(rooms):
    if not rooms:
        return None
    xs = [p[0] for r in rooms for p in r["polygon"]]
    ys = [p[1] for r in rooms for p in r["polygon"]]
    return (min(xs), min(ys), max(xs), max(ys))


def _room_bbox(room):
    xs = [p[0] for p in room["polygon"]] or [room["centroid"][0]]
    ys = [p[1] for p in room["polygon"]] or [room["centroid"][1]]
    return (min(xs), min(ys), max(xs), max(ys))


def _aspect(room):
    x0, y0, x1, y1 = _room_bbox(room)
    w, h = max(1e-6, x1 - x0), max(1e-6, y1 - y0)
    return max(w, h) / min(w, h)


def _largest(rooms, types):
    cands = [r for r in rooms if r["type"] in types]
    return max(cands, key=lambda r: r["area"], default=None)


def _double_height(room):
    return bool((room.get("meta") or {}).get("doubleHeight"))


def _nearest_normal(room, rooms):
    """Nearest non-double-height space to relocate a ceiling device to (double-height rule)."""
    cx, cy = room["centroid"]
    best, bd = None, 1e9
    for r in rooms:
        if r is room or _double_height(r):
            continue
        d = (r["centroid"][0] - cx) ** 2 + (r["centroid"][1] - cy) ** 2
        if d < bd:
            bd, best = d, r
    return best


def _ceiling_point(room, rooms):
    """Where a ceiling-mounted device (Wi-Fi/speaker) should go for `room`: its centroid,
    unless the room is double-height, in which case the nearest normal-ceiling space."""
    if _double_height(room):
        alt = _nearest_normal(room, rooms)
        if alt:
            return alt["centroid"], f" (relocated from double-height {room.get('label', room['type'])})"
    return room["centroid"], ""


def suggest(rooms: List[Dict[str, Any]], zones: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    by = lambda t: [r for r in rooms if r["type"] == t]
    bb = _bbox(rooms)

    gate_zones = [z for z in zones if z.get("type") == "gate"]
    parking_zones = [z for z in zones if z.get("type") == "parking"]
    garden_zones = [z for z in zones if z.get("type") == "garden"]
    street_zones = [z for z in zones if z.get("type") == "street"]

    # ── CCTV ──────────────────────────────────────────────────────────────────
    # 1) Two perimeter cameras at the street-facing wall ends. Street side = edge
    #    nearest the gate; if no gate, assume the front is the bottom (max-y) edge.
    if bb:
        x0, y0, x1, y1 = bb
        ins = 0.012
        # Prefer an explicit street marker, then the gate, to decide the street-facing wall.
        gpt = (street_zones[0]["geometry"]["coords"][0] if street_zones
               else gate_zones[0]["geometry"]["coords"][0] if gate_zones else None)
        side = "front"
        if gpt:
            gx, gy = gpt
            # distance from gate to each edge; pick the closest edge
            dists = {"bottom": abs(gy - y1), "top": abs(gy - y0), "left": abs(gx - x0), "right": abs(gx - x1)}
            side = min(dists, key=dists.get)
        if side in ("bottom", "front"):
            pts = [(x0 + ins, y1 - ins, 45), (x1 - ins, y1 - ins, 315)]
        elif side == "top":
            pts = [(x0 + ins, y0 + ins, 135), (x1 - ins, y0 + ins, 225)]
        elif side == "left":
            pts = [(x0 + ins, y0 + ins, 135), (x0 + ins, y1 - ins, 45)]
        else:
            pts = [(x1 - ins, y0 + ins, 225), (x1 - ins, y1 - ins, 315)]
        for x, y, rot in pts:
            out.append(_place("CCTV", x, y, "Perimeter CCTV — street-facing wall end", 0.8, rot, basis="perimeter"))

    # 2) One camera at each external door (every entrance type) covering door + approach.
    entrances = (by("main_entrance") + by("main_door") + by("guest_entrance")
                 + by("service_entrance") + by("entrance"))
    for e in entrances[:5]:
        out.append(_place("CCTV", e["centroid"][0], e["centroid"][1],
                          f"Entrance CCTV — covers {e.get('label', 'door')} and approach", 0.76))
    # 3) Parking + general yard view.
    for pz in parking_zones[:2]:
        cx, cy = pz["geometry"]["coords"][0]
        out.append(_place("CCTV", cx, cy, "Parking area CCTV", 0.76, basis="zone"))
    for pr in by("parking")[:2]:
        out.append(_place("CCTV", pr["centroid"][0], pr["centroid"][1], "Parking area CCTV", 0.74))
    if garden_zones or by("garden"):
        g = (by("garden") or [None])[0]
        if g:
            out.append(_place("CCTV", g["centroid"][0], g["centroid"][1], "General yard-view CCTV", 0.72))
        elif garden_zones:
            cx, cy = garden_zones[0]["geometry"]["coords"][0]
            out.append(_place("CCTV", cx, cy, "General yard-view CCTV", 0.72, basis="zone"))
    # 3b) Outdoor facilities — pool / BBQ / outdoor seating each get coverage.
    for f in by("pool") + by("bbq") + by("outdoor_seating"):
        out.append(_place("CCTV", f["centroid"][0], f["centroid"][1], f"Outdoor-facility CCTV — {f.get('label', f['type'])}", 0.72))
    # 4) One camera inside each closed kitchen and each laundry (open pantries excluded).
    for k in by("kitchen") + by("laundry"):
        out.append(_place("CCTV", k["centroid"][0], k["centroid"][1], f"CCTV — {k.get('label', k['type'])}", 0.72))

    # ── Gate motor + outdoor intercom bell (per gate) ──────────────────────────
    for gz in gate_zones:
        cx, cy = gz["geometry"]["coords"][0]
        out.append(_place("GATE_MOTOR", cx, cy, "Main gate motor", 0.86, basis="zone"))
        out.append(_place("INTERCOM_BELL", min(1, cx + 0.02), cy, "Outdoor intercom at gate / pedestrian door", 0.82, basis="zone"))

    # ── Smart lock at primary entrance ─────────────────────────────────────────
    primary = (by("main_entrance") + by("main_door") + by("entrance"))[:1]
    if primary:
        x, y = primary[0]["centroid"]
        out.append(_place("SMART_LOCK", x, y, "Smart lock at main entrance", 0.84))

    # ── Intercom screens (kitchen / pantry / maid / main living / per-floor stair) ──
    for k in by("kitchen"):
        out.append(_place("INTERCOM_SCREEN", k["centroid"][0], k["centroid"][1],
                          f"Service intercom screen — {k.get('label', 'kitchen')}", 0.8, props={"mountHeight": 1.4}))
    for p in by("pantry"):
        out.append(_place("INTERCOM_SCREEN", p["centroid"][0], p["centroid"][1],
                          "Intercom screen — pantry", 0.74, props={"mountHeight": 1.4}))
    for m in by("maid_room"):
        out.append(_place("INTERCOM_SCREEN", m["centroid"][0], m["centroid"][1],
                          "Intercom screen — maid room", 0.78, props={"mountHeight": 1.4}))
    main_living = _largest(rooms, {"majlis", "living_room"})
    if main_living:
        x, y = main_living["centroid"]
        out.append(_place("INTERCOM_SCREEN", min(1, x + 0.02), y,
                          f"Main intercom screen — {main_living.get('label', 'living')}", 0.8, props={"mountHeight": 1.4}))
    for s in by("staircase")[:1]:
        out.append(_place("INTERCOM_SCREEN", s["centroid"][0], s["centroid"][1],
                          "Floor intercom screen — near staircase", 0.74, props={"mountHeight": 1.4}))

    # ── ELV rack priority: staircase → service → electrical/DB → indoor store →
    #    generic store → house entrance. Outdoor stores are never used. ────────────
    rack_room, why = None, ""
    if by("staircase"):
        rack_room, why = by("staircase")[0], "under staircase"
    elif by("service_area"):
        rack_room, why = by("service_area")[0], "service area"
    elif by("electrical_room"):
        rack_room, why = by("electrical_room")[0], "electrical/DB room"
    elif by("store_indoor"):
        rack_room, why = by("store_indoor")[0], "indoor store (AC)"
    elif by("store"):
        rack_room, why = by("store")[0], "store (verify indoor + AC)"
    elif (by("main_entrance") + by("entrance") + by("main_door")):
        rack_room, why = (by("main_entrance") + by("entrance") + by("main_door"))[0], "house entrance (near main DBs)"
    if rack_room:
        x, y = rack_room["centroid"]
        out.append(_place("ELV_RACK", x, y, f"ELV rack — {why} (not on a column)", 0.82))
        out.append(_place("SWITCH", min(1, x + 0.012), y, "Core network switch in rack", 0.8))
        out.append(_place("NVR", max(0, x - 0.012), y, "NVR in rack", 0.8))

    # ── Wi-Fi APs (ceiling, room composition) ─────────────────────────────────
    majlis, dining, living = by("majlis"), by("dining"), by("living_room")
    if majlis and dining:
        mx, my = majlis[0]["centroid"]
        dx, dy = dining[0]["centroid"]
        out.append(_place("WIFI_AP", (mx + dx) / 2, (my + dy) / 2,
                          "Ceiling Wi-Fi AP — guest lobby (Majlis↔Dining)", 0.76, props={"coverageRadius": 12}))
    elif majlis:
        pt, note = _ceiling_point(majlis[0], rooms)
        out.append(_place("WIFI_AP", pt[0], pt[1], f"Ceiling Wi-Fi AP — Majlis{note}", 0.74, props={"coverageRadius": 12}))
    if living:
        big = _largest(living, {"living_room"})
        pt, note = _ceiling_point(big, rooms)
        out.append(_place("WIFI_AP", pt[0], pt[1], f"Ceiling Wi-Fi AP — main living (covers outdoor){note}", 0.74, props={"coverageRadius": 12}))
    svc = by("service_area") or by("kitchen")
    if svc:
        out.append(_place("WIFI_AP", svc[0]["centroid"][0], svc[0]["centroid"][1],
                          "Ceiling Wi-Fi AP — service area (kitchen + maid)", 0.72, props={"coverageRadius": 10}))
    if by("master_bedroom"):
        mb = by("master_bedroom")[0]
        pt, note = _ceiling_point(mb, rooms)
        out.append(_place("WIFI_AP", pt[0], pt[1], f"Ceiling Wi-Fi AP — master suite (bedroom + dressing){note}", 0.72, props={"coverageRadius": 10}))
    beds = by("bedroom")
    if beds:
        # one AP per ~2 bedrooms to cover the rooms wing
        for i in range(0, len(beds), 2):
            grp = beds[i:i + 2]
            cx = sum(b["centroid"][0] for b in grp) / len(grp)
            cy = sum(b["centroid"][1] for b in grp) / len(grp)
            out.append(_place("WIFI_AP", cx, cy, "Ceiling Wi-Fi AP — bedrooms wing", 0.7, props={"coverageRadius": 10}))
    for c in by("corridor"):
        if _aspect(c) >= LONG_CORRIDOR_ASPECT:
            out.append(_place("WIFI_AP", c["centroid"][0], c["centroid"][1],
                              "Ceiling Wi-Fi AP — long corridor", 0.68, props={"coverageRadius": 10}))

    # ── Speakers + volume control (entertainment rooms + wide halls) ───────────
    ent_rooms = list(by("majlis")) + list(by("living_room")) + list(by("dining")) + list(by("sitting_area"))
    ent_rooms += [c for c in by("corridor") if c["area"] >= HALL_AREA]  # wide hall used as living
    for r in ent_rooms:
        pt, note = _ceiling_point(r, rooms)
        cx, cy = pt
        label = r.get("label", r["type"])
        out.append(_place("SPEAKER", max(0, cx - 0.035), cy, f"Ceiling speaker L — {label}{note}", 0.74))
        out.append(_place("SPEAKER", min(1, cx + 0.035), cy, f"Ceiling speaker R — {label}{note}", 0.74))
        out.append(_place("VOLUME_CONTROL", cx, min(1, cy + 0.05), f"Volume control (near switches) — {label}", 0.7, props={"mountHeight": 1.3}))

    # ── Motion sensors (~4 m; circulation + dressing + wet rooms, ceiling) ─────
    for r in (by("corridor") + by("staircase") + by("bathroom") + by("dressing")
              + by("entrance") + by("main_entrance") + by("lift")):
        x0, y0, x1, y1 = _room_bbox(r)
        cx, cy = r["centroid"]
        big = (r["type"] == "corridor" and (r["area"] >= HALL_AREA or _aspect(r) >= LONG_CORRIDOR_ASPECT))
        if big:
            out.append(_place("SENSOR", x0 + (x1 - x0) * 0.3, y0 + (y1 - y0) * 0.3, f"Motion sensor — {r.get('label', r['type'])}", 0.72, props={"kind": "motion"}))
            out.append(_place("SENSOR", x0 + (x1 - x0) * 0.7, y0 + (y1 - y0) * 0.7, f"Motion sensor — {r.get('label', r['type'])}", 0.72, props={"kind": "motion"}))
        else:
            out.append(_place("SENSOR", cx, cy, f"Motion sensor — {r.get('label', r['type'])}", 0.72, props={"kind": "motion"}))

    # ── Thermostats (climate) ──────────────────────────────────────────────────
    for r in (by("master_bedroom") + by("living_room") + by("majlis") + by("bedroom"))[:6]:
        out.append(_place("THERMOSTAT", r["centroid"][0], min(1, r["centroid"][1] + 0.04),
                          f"Thermostat — {r.get('label', r['type'])}", 0.72, props={"mountHeight": 1.4}))

    # ── Curtain motors (window walls = top edge of room) ───────────────────────
    for r in (by("master_bedroom") + by("majlis") + by("living_room"))[:4]:
        top = min((p[1] for p in r["polygon"]), default=r["centroid"][1]) + 0.005
        out.append(_place("CURTAIN_MOTOR", r["centroid"][0], top, f"Curtain motor — {r.get('label', r['type'])}", 0.66))

    # ── Projector + screen (majlis, else largest living) ───────────────────────
    proj = (by("majlis")[:1] or ([_largest(rooms, {"living_room"})] if _largest(rooms, {"living_room"}) else []))
    if proj and proj[0]:
        cx, cy = proj[0]["centroid"]
        out.append(_place("PROJECTOR", cx, cy, f"Projector — {proj[0].get('label', 'majlis')}", 0.66, props={"mountHeight": 2.8}))
        out.append(_place("SCREEN", cx, max(0, cy - 0.06), f"Projection screen — {proj[0].get('label', 'majlis')}", 0.66))

    # ── Light switches (by doors + main rooms) ─────────────────────────────────
    for r in (by("entrance") + by("main_door") + by("corridor"))[:4]:
        out.append(_place("LIGHT_SWITCH", min(1, r["centroid"][0] + 0.02), min(1, r["centroid"][1] + 0.02),
                          f"Switch by door — {r.get('label', r['type'])}", 0.68, props={"mountHeight": 1.3}))
    for r in (by("majlis") + by("living_room") + by("master_bedroom") + by("bedroom"))[:6]:
        out.append(_place("LIGHT_SWITCH", min(1, r["centroid"][0] + 0.02), min(1, r["centroid"][1] + 0.02),
                          f"Room lighting — {r.get('label', r['type'])}", 0.67, props={"mountHeight": 1.3}))

    # ── Data sockets (main rooms + bedrooms) ───────────────────────────────────
    for r in (by("majlis") + by("living_room") + by("master_bedroom") + by("bedroom"))[:8]:
        out.append(_place("DATA_SOCKET", max(0, r["centroid"][0] - 0.03), min(1, r["centroid"][1] + 0.03),
                          f"Data point — {r.get('label', r['type'])}", 0.68))

    return out
