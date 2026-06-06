# -*- coding: utf-8 -*-
"""Label-seeded room typing — OCR + geometry fusion that types rooms reliably even when
watershed segmentation fragments a furniture-heavy plan.

Instead of "segment regions, then try to drop a label into each" (which fails when furniture
breaks a room into sub-basins so labels land in no polygon), we INVERT it: for each
classifiable OCR room label we flood-fill the enclosed room *from the label's position* on a
furniture-suppressed wall mask. Every readable label becomes a typed room bounded by real
walls — no alignment problem. Watershed regions not covered by any label stay as unclassified
coverage rooms (so the floor is never empty and unlabeled rooms still get reviewed).
"""
from typing import List, Tuple
import cv2
import numpy as np

from .architecture import wall_mask_hv, bridge_doors
from .spaces import classify
from .textfilter import filter_tokens

# A flood-filled room must fall in this normalized-area band (else it's a fixture cell or the
# whole-floor leak through a gap).
MIN_LABEL_ROOM_AREA = 0.008
MAX_LABEL_ROOM_AREA = 0.30
# Structural-wall components are large; smaller ink islands are furniture/fixtures → dropped.
WALL_COMPONENT_FRAC = 0.0006


def structural_walls(binary: np.ndarray) -> np.ndarray:
    """Wall mask with furniture/fixtures removed: long H/V lines, door gaps bridged, then keep
    only the large connected components (the building's structural network)."""
    walls = bridge_doors(wall_mask_hv(binary), binary.shape[1])
    n, lab, stats, _ = cv2.connectedComponentsWithStats(walls, 8)
    h, w = binary.shape
    keep = np.zeros_like(walls)
    thr = WALL_COMPONENT_FRAC * w * h
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= thr:
            keep[lab == i] = 255
    return keep


def _interior(binary: np.ndarray, extent) -> np.ndarray:
    walls = structural_walls(binary)
    interior = cv2.bitwise_not(walls)
    x0, y0, x1, y1 = extent
    m = np.zeros_like(interior)
    m[y0:y1, x0:x1] = interior[y0:y1, x0:x1]
    return m


def _seed_region(comp: np.ndarray, px: int, py: int) -> int:
    """Region id of the open component at (px,py); nudges off a wall pixel. 0 = none."""
    h, w = comp.shape
    px = min(max(px, 0), w - 1); py = min(max(py, 0), h - 1)
    if comp[py, px] == 0:
        y0, x0 = max(0, py - 15), max(0, px - 15)
        win = comp[y0:py + 16, x0:px + 16]
        ys, xs = np.where(win > 0)
        if len(xs) == 0:
            return 0
        py, px = y0 + int(ys[0]), x0 + int(xs[0])
    return int(comp[py, px])


def _poly(region: np.ndarray, w: int, h: int):
    cnts, _ = cv2.findContours(region, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None, None
    c = max(cnts, key=cv2.contourArea)
    eps = 0.012 * cv2.arcLength(c, True)
    approx = cv2.approxPolyDP(c, eps, True).reshape(-1, 2)
    if len(approx) < 3:
        return None, None
    poly = [[float(x) / w, float(y) / h] for x, y in approx]
    ys, xs = np.where(region)
    return poly, [float(xs.mean()) / w, float(ys.mean()) / h]


def label_seeded_rooms(binary: np.ndarray, extent, texts: List[dict]):
    """Return (typed_rooms, claimed_mask). typed_rooms each carry type/label/polygon/centroid/
    area/confidence and meta.classificationSource='ocr_label'. claimed_mask marks pixels that
    a label-room already covers (so watershed coverage rooms don't double-count them)."""
    # Work at reduced resolution: room regions don't need full DPI, and morphology +
    # connected-components cost scales with pixels. Coordinates stay normalized throughout.
    MAXW = 900
    H0, W0 = binary.shape
    if W0 > MAXW:
        s = MAXW / W0
        binary = cv2.resize(binary, (MAXW, int(H0 * s)), interpolation=cv2.INTER_NEAREST)
        extent = tuple(int(v * s) for v in extent)
    h, w = binary.shape
    total = float(h * w)
    interior = _interior(binary, extent)
    # One pass: label every enclosed open region, then look up each label's region in O(1).
    n_comp, comp = cv2.connectedComponents(interior)
    areas = np.bincount(comp.ravel(), minlength=n_comp)

    # region id → best (score, rtype, text, ocr_conf). A region keeps its highest-score label.
    best = {}
    for t in filter_tokens(texts):
        res = classify(t["text"])
        if not res:
            continue
        rtype, score = res
        rid = _seed_region(comp, int(t["center"][0] * w), int(t["center"][1] * h))
        if rid == 0:
            continue
        frac = areas[rid] / total
        if not (MIN_LABEL_ROOM_AREA <= frac <= MAX_LABEL_ROOM_AREA):
            continue
        if rid not in best or score > best[rid][0]:
            best[rid] = (score, rtype, t["text"], float(t.get("conf", 0.6)))

    from .fusion import _blend, _area_plausibility
    claimed = np.isin(comp, list(best.keys())) if best else np.zeros((h, w), bool)
    rooms = []
    for rid, (score, rtype, text, ocr_conf) in best.items():
        region = (comp == rid).astype(np.uint8)
        poly, centroid = _poly(region, w, h)
        if poly is None:
            continue
        frac = float(areas[rid]) / total
        plaus = _area_plausibility(rtype, frac)
        rooms.append({
            "label": text, "rawLabel": text, "type": rtype,
            "polygon": poly, "centroid": centroid, "area": frac,
            "confidence": min(0.97, _blend(score, ocr_conf, plaus)), "source": "cv",
            "meta": {"classificationSource": "ocr_label",
                     "signals": {"labelScore": round(score, 2), "ocrConf": round(ocr_conf, 2),
                                 "areaPlausibility": round(plaus, 2)},
                     "typing": "label_seeded"},
        })
    return rooms, claimed
