"""Stage 6 — fuse geometry + OCR + detections into rooms[] and zones[]."""
from typing import List
from shapely.geometry import Polygon, Point

from .spaces import normalize, ZONE_LABELS


def _point_in(poly_coords, pt):
    try:
        return Polygon(poly_coords).contains(Point(pt))
    except Exception:
        return False


def fuse(rooms_geo: List[dict], texts: List[dict], detections: List[dict]):
    rooms = []
    used_text = set()

    for rg in rooms_geo:
        label, rtype, conf, raw = None, None, 0.45, None
        # assign OCR label whose center lies inside this room
        for ti, t in enumerate(texts):
            if ti in used_text:
                continue
            if _point_in(rg["polygon"], t["center"]):
                nt = normalize(t["text"])
                if nt:
                    label, rtype, raw, conf = t["text"], nt, t["text"], min(0.95, 0.5 + t["conf"] / 2)
                    used_text.add(ti)
                    break
        if rtype is None:
            # fall back to area-based heuristic — conservative typing
            if rg["area"] > 0.08:
                rtype, label = "living_room", "Living"
            elif rg["area"] > 0.04:
                rtype, label = "bedroom", "Bedroom"
            elif rg["area"] > 0.02:
                rtype, label = "corridor", "Corridor"
            else:
                rtype, label = "corridor", "Space"
            conf = 0.42
        rooms.append({
            "label": label, "rawLabel": raw, "type": rtype,
            "polygon": rg["polygon"], "centroid": rg["centroid"], "area": rg["area"],
            "confidence": round(conf, 3), "source": "cv",
        })

    # zones from leftover labels (gate / parking / etc.) and from detections
    zones = []
    for ti, t in enumerate(texts):
        if ti in used_text:
            continue
        k = t["text"].lower().strip()
        for syn, ztype in ZONE_LABELS.items():
            if syn in k:
                zones.append({"type": ztype, "geometry": {"kind": "point", "coords": [t["center"]]},
                              "confidence": round(min(0.9, 0.5 + t["conf"] / 2), 3), "source": "cv"})
                break

    for d in detections:
        cls = d["class"]
        x, y, w, h = d["bbox"]
        center = [x + w / 2, y + h / 2]
        if cls in ("gate",):
            zones.append({"type": "gate", "geometry": {"kind": "point", "coords": [center]}, "confidence": d["confidence"], "source": "cv"})
        elif cls in ("parking_symbol",):
            zones.append({"type": "parking", "geometry": {"kind": "point", "coords": [center]}, "confidence": d["confidence"], "source": "cv"})
        elif cls in ("stair",):
            zones.append({"type": "staircase", "geometry": {"kind": "point", "coords": [center]}, "confidence": d["confidence"], "source": "cv"})

    return rooms, zones
