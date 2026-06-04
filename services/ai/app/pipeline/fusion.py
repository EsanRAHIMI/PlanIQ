"""Stage 6 — fuse geometry + OCR + detections into rooms[] and zones[].

Room confidence is now BLENDED from three signals instead of a flat constant:
  - label match strength (how well the OCR text mapped to a canonical type)
  - OCR text confidence (how sure the OCR engine was of the characters)
  - area plausibility (does the size fit the inferred type)
Each room records meta.classificationSource + meta.signals so the editor can explain it.
"""
from typing import List
from shapely.geometry import Polygon, Point

from .spaces import classify, normalize_label_text, ZONE_LABELS

# Rough plausible normalized-area band per type; used as a soft plausibility signal.
_AREA_BAND = {
    "bathroom": (0.005, 0.06), "store": (0.004, 0.05), "store_indoor": (0.004, 0.05),
    "pantry": (0.004, 0.05), "laundry": (0.004, 0.05), "electrical_room": (0.003, 0.04),
    "corridor": (0.01, 0.18), "dressing": (0.004, 0.06), "maid_room": (0.006, 0.06),
    "kitchen": (0.01, 0.12), "bedroom": (0.02, 0.16), "master_bedroom": (0.03, 0.22),
    "majlis": (0.03, 0.28), "living_room": (0.03, 0.30), "dining": (0.015, 0.18),
}


def _point_in(poly_coords, pt):
    try:
        return Polygon(poly_coords).contains(Point(pt))
    except Exception:
        return False


def _area_plausibility(rtype: str, area: float) -> float:
    band = _AREA_BAND.get(rtype)
    if not band:
        return 0.6
    lo, hi = band
    if lo <= area <= hi:
        return 1.0
    # graceful falloff outside the band
    if area < lo:
        return max(0.3, area / lo)
    return max(0.3, hi / area)


def _blend(label_score: float, ocr_conf: float, area_plaus: float) -> float:
    return round(0.30 + 0.40 * label_score + 0.15 * ocr_conf + 0.15 * area_plaus, 3)


def _area_bucket(area: float):
    """Fallback typing when no label was found. Deliberately LOW confidence so the user
    reviews it (matches the 'unknown → confirm' principle), not forced as ground truth."""
    if area > 0.12:
        return "living_room", "Living"
    if area > 0.05:
        return "bedroom", "Room"
    if area > 0.02:
        return "corridor", "Space"
    return "store", "Small space"


def fuse(rooms_geo: List[dict], texts: List[dict], detections: List[dict]):
    rooms = []
    used_text = set()

    for rg in rooms_geo:
        area = rg["area"]
        label = rawlabel = rtype = None
        conf = 0.0
        source = "area_heuristic"
        signals = {}

        # assign the best OCR label whose center lies inside this room
        for ti, t in enumerate(texts):
            if ti in used_text:
                continue
            if not _point_in(rg["polygon"], t["center"]):
                continue
            res = classify(t["text"])
            if not res:
                continue
            rtype, label_score = res
            ocr_conf = float(t.get("conf", 0.6))
            plaus = _area_plausibility(rtype, area)
            label, rawlabel = t["text"], t["text"]
            conf = _blend(label_score, ocr_conf, plaus)
            source = "ocr_label"
            signals = {"labelScore": round(label_score, 2), "ocrConf": round(ocr_conf, 2), "areaPlausibility": round(plaus, 2)}
            used_text.add(ti)
            break

        if rtype is None:
            rtype, label = _area_bucket(area)
            # area-only typing: low confidence, scaled slightly by how cleanly it fits a band
            plaus = _area_plausibility(rtype, area)
            conf = round(0.36 + 0.08 * plaus, 3)
            signals = {"labelScore": 0.0, "ocrConf": 0.0, "areaPlausibility": round(plaus, 2)}

        rooms.append({
            "label": label, "rawLabel": rawlabel, "type": rtype,
            "polygon": rg["polygon"], "centroid": rg["centroid"], "area": area,
            "confidence": min(0.97, conf), "source": "cv",
            "meta": {"classificationSource": source, "signals": signals},
        })

    # zones from leftover labels (gate / parking / street / etc.) and from detections
    zones = []
    for ti, t in enumerate(texts):
        if ti in used_text:
            continue
        k = normalize_label_text(t["text"])
        for syn, ztype in ZONE_LABELS.items():
            if syn in k:
                zones.append({"type": ztype, "geometry": {"kind": "point", "coords": [t["center"]]},
                              "confidence": round(min(0.9, 0.5 + float(t.get("conf", 0.6)) / 2), 3), "source": "cv"})
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
