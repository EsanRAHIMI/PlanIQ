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
from .textfilter import filter_tokens

# How far (normalized) outside a room polygon an OCR label may sit and still be
# attached to that room — CAD labels often straddle a thin partition or sit just
# outside the segmented boundary.
LABEL_RADIUS = 0.05

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
    """Fallback when no label was found. We DO NOT invent a confident room type
    (the old code returned 'bedroom' for any mid-size room, which is the root of the
    'everything is a bedroom' problem). Instead we mark the space 'unclassified' so the
    engineer confirms it. A coarse size hint is kept only in the label text."""
    if area > 0.12:
        hint = "Large space"
    elif area > 0.05:
        hint = "Room"
    elif area > 0.02:
        hint = "Small space"
    else:
        hint = "Compact space"
    return "unclassified", hint


def fuse(rooms_geo: List[dict], texts: List[dict], detections: List[dict]):
    rooms = []
    used_text = set()

    # Pre-filter OCR tokens: strip dimensions, level tags, grid bubbles and door/window
    # marks so only plausible room labels reach the classifier. Keep originals for zones.
    raw_texts = texts
    label_texts = filter_tokens(texts)
    # Map filtered tokens back to their index in the original list (for used_text bookkeeping).
    label_index = [raw_texts.index(t) for t in label_texts]

    for rg in rooms_geo:
        area = rg["area"]
        label = rawlabel = rtype = None
        conf = 0.0
        source = "area_heuristic"
        signals = {}

        # Pick the best label for this room: classifiable tokens, scored by match strength,
        # preferring tokens INSIDE the polygon, then the nearest within LABEL_RADIUS.
        cx, cy = rg["centroid"]
        best = None  # (priority, score, ti, rtype, ocr_conf, text)
        for li, t in enumerate(label_texts):
            ti = label_index[li]
            if ti in used_text:
                continue
            res = classify(t["text"])
            if not res:
                continue
            cand_type, label_score = res
            tx, ty = t["center"]
            inside = _point_in(rg["polygon"], t["center"])
            dist = ((tx - cx) ** 2 + (ty - cy) ** 2) ** 0.5
            if not inside and dist > LABEL_RADIUS:
                continue
            # inside beats nearby; within that, higher label score, then closer.
            priority = (1 if inside else 0, round(label_score, 3), -dist)
            if best is None or priority > best[0]:
                best = (priority, label_score, ti, cand_type, float(t.get("conf", 0.6)), t["text"])

        if best is not None:
            _, label_score, ti, rtype, ocr_conf, text = best
            plaus = _area_plausibility(rtype, area)
            label, rawlabel = text, text
            conf = _blend(label_score, ocr_conf, plaus)
            source = "ocr_label"
            signals = {"labelScore": round(label_score, 2), "ocrConf": round(ocr_conf, 2), "areaPlausibility": round(plaus, 2)}
            used_text.add(ti)

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


def _build_zones(texts, detections):
    """Zones from labels (gate/parking/street/…) and symbol detections."""
    zones = []
    for t in texts:
        k = normalize_label_text(t["text"])
        for syn, ztype in ZONE_LABELS.items():
            if syn in k:
                zones.append({"type": ztype, "geometry": {"kind": "point", "coords": [t["center"]]},
                              "confidence": round(min(0.9, 0.5 + float(t.get("conf", 0.6)) / 2), 3), "source": "cv"})
                break
    for d in detections:
        cls = d["class"]; x, y, w, h = d["bbox"]; center = [x + w / 2, y + h / 2]
        z = {"gate": "gate", "parking_symbol": "parking", "stair": "staircase"}.get(cls)
        if z:
            zones.append({"type": z, "geometry": {"kind": "point", "coords": [center]}, "confidence": d["confidence"], "source": "cv"})
    return zones


def fuse_with_labels(binary, extent, rooms_geo, texts, detections):
    """OCR+geometry fusion via label-seeded typing (see pipeline.label_rooms).

    Typed rooms come from flood-filling each readable OCR label (robust to furniture-fragmented
    segmentation); watershed regions not covered by any label become 'unclassified' coverage
    rooms so unlabeled spaces are still detected and reviewable. Returns (rooms, zones)."""
    from .label_rooms import label_seeded_rooms  # lazy import avoids a cycle
    typed_rooms, claimed = label_seeded_rooms(binary, extent, texts)
    ch, cw = claimed.shape                 # claimed may be at reduced resolution
    label_texts = filter_tokens(texts)
    rooms = list(typed_rooms)

    def _is_claimed(nx, ny):
        px, py = int(nx * cw), int(ny * ch)
        return 0 <= py < ch and 0 <= px < cw and claimed[py, px]

    for rg in rooms_geo:
        cx, cy = rg["centroid"]
        if _is_claimed(cx, cy):
            continue                       # already typed by a label-seeded room
        # Containment fallback: a watershed room the flood-fill missed may still have a
        # classifiable label inside it (or just outside). Type it the old way before giving up.
        best = None
        for t in label_texts:
            if _is_claimed(t["center"][0], t["center"][1]):
                continue                   # that label already typed another room
            res = classify(t["text"])
            if not res:
                continue
            cand, score = res
            inside = _point_in(rg["polygon"], t["center"])
            dist = ((t["center"][0] - cx) ** 2 + (t["center"][1] - cy) ** 2) ** 0.5
            if not inside and dist > LABEL_RADIUS:
                continue
            priority = (1 if inside else 0, round(score, 3), -dist)
            if best is None or priority > best[0]:
                best = (priority, cand, score, float(t.get("conf", 0.6)), t["text"])
        if best is not None:
            _, rtype, score, ocr_conf, text = best
            plaus = _area_plausibility(rtype, rg["area"])
            rooms.append({
                "label": text, "rawLabel": text, "type": rtype,
                "polygon": rg["polygon"], "centroid": rg["centroid"], "area": rg["area"],
                "confidence": min(0.97, _blend(score, ocr_conf, plaus)), "source": "cv",
                "meta": {"classificationSource": "ocr_label",
                         "signals": {"labelScore": round(score, 2), "ocrConf": round(ocr_conf, 2),
                                     "areaPlausibility": round(plaus, 2)}, "typing": "containment"},
            })
            continue
        rtype, label = _area_bucket(rg["area"])
        plaus = _area_plausibility(rtype, rg["area"])
        rooms.append({
            "label": label, "rawLabel": None, "type": rtype,
            "polygon": rg["polygon"], "centroid": rg["centroid"], "area": rg["area"],
            "confidence": round(0.36 + 0.08 * plaus, 3), "source": "cv",
            "meta": {"classificationSource": "area_heuristic",
                     "signals": {"labelScore": 0.0, "ocrConf": 0.0, "areaPlausibility": round(plaus, 2)}},
        })
    return rooms, _build_zones(texts, detections)
