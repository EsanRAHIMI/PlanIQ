# -*- coding: utf-8 -*-
"""Stage 3b — Geometry intelligence: read the drawing as architecture, not ink blobs.

Pure-OpenCV detectors (no OCR/YOLO needed) for walls, title block, columns, doors,
entrances, stairs, scale, and orthogonal boundary correction. Everything works on the
binary ink mask (ink = white) produced by preprocess. Coordinates returned normalized 0..1.
"""
from typing import List, Dict, Optional, Tuple
import cv2
import numpy as np

from .geometry import remove_text

# Standard residential single-door leaf width (m) — anchor for scale inference.
STANDARD_DOOR_M = 0.9


# ── Walls ─────────────────────────────────────────────────────────────────────
def wall_mask_hv(binary: np.ndarray) -> np.ndarray:
    """Walls = long HORIZONTAL or VERTICAL line structures. Isolating axis-aligned
    lines drops furniture, door arcs, diagonal leaders and dimension ticks that the old
    blob-close kept, giving a much cleaner wall mask."""
    lines = remove_text(binary)
    h, w = binary.shape
    hk = cv2.getStructuringElement(cv2.MORPH_RECT, (max(12, w // 80), 1))
    vk = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(12, h // 80)))
    horiz = cv2.morphologyEx(lines, cv2.MORPH_OPEN, hk)
    vert = cv2.morphologyEx(lines, cv2.MORPH_OPEN, vk)
    walls = cv2.bitwise_or(horiz, vert)
    walls = cv2.dilate(walls, np.ones((3, 3), np.uint8), iterations=1)
    return walls


def bridge_doors(walls: np.ndarray, w: int) -> np.ndarray:
    dk = max(5, w // 110)
    door = cv2.getStructuringElement(cv2.MORPH_RECT, (dk, dk))
    return cv2.morphologyEx(walls, cv2.MORPH_CLOSE, door, iterations=1)


# ── PDF / title-block cleanup ──────────────────────────────────────────────────
def detect_titleblock(binary: np.ndarray) -> Optional[Tuple[int, int, int, int]]:
    """A title block / revision table is a dense rectangular cluster of short strokes,
    usually hugging a corner/edge. Find the densest such block via a coarse density grid."""
    h, w = binary.shape
    gx, gy = 32, 32
    cell = cv2.resize(binary, (gx, gy), interpolation=cv2.INTER_AREA)
    dense = (cell > 60).astype(np.uint8)  # cells with lots of ink
    n, lab, stats, _ = cv2.connectedComponentsWithStats(dense, 8)
    best, best_area = None, 0
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        # title blocks are compact rectangles touching an edge, not the whole drawing
        touches_edge = x == 0 or y == 0 or x + bw == gx or y + bh == gy
        frac = (bw * bh) / float(gx * gy)
        if touches_edge and 0.02 < frac < 0.25 and area > best_area:
            best_area, best = area, (x, y, bw, bh)
    if not best:
        return None
    x, y, bw, bh = best
    return (int(x / gx * w), int(y / gy * h), int((x + bw) / gx * w), int((y + bh) / gy * h))


# ── Columns ────────────────────────────────────────────────────────────────────
def detect_columns(binary: np.ndarray) -> List[Dict]:
    """Columns = SOLID, near-square filled blobs of uniform size that align on a grid.
    Requires both a uniform size cluster AND grid alignment (≥3 sharing an x- or y-line),
    so text/symbols/hatching that happen to be solid don't pass."""
    h, w = binary.shape
    n, lab, stats, cent = cv2.connectedComponentsWithStats(binary, 8)
    lo, hi = max(12, w // 150), max(30, w // 35)
    cand = []
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        if bw == 0 or bh == 0:
            continue
        fill = area / float(bw * bh)
        asp = max(bw, bh) / float(min(bw, bh))
        size = max(bw, bh)
        if fill >= 0.74 and asp <= 1.6 and lo <= size <= hi:
            cand.append({"cx": cent[i][0] / w, "cy": cent[i][1] / h, "size": size})
    if len(cand) < 3:
        return []
    # 1) keep the dominant (uniform) size cluster — real columns share one size
    sizes = sorted(c["size"] for c in cand)
    med = sizes[len(sizes) // 2]
    cand = [c for c in cand if 0.7 * med <= c["size"] <= 1.45 * med]
    if len(cand) < 3:
        return []
    # 2) grid alignment: a real column shares an x- or y-axis line with ≥1 other.
    #    Conservative (favours precision); a trained detector will raise recall later.
    tol = 0.03
    def aligned(c):
        xs = sum(1 for o in cand if o is not c and abs(o["cx"] - c["cx"]) < tol)
        ys = sum(1 for o in cand if o is not c and abs(o["cy"] - c["cy"]) < tol)
        return xs >= 1 or ys >= 1
    cols = [{"cx": c["cx"], "cy": c["cy"], "size": c["size"]} for c in cand if aligned(c)]
    return cols if 3 <= len(cols) <= 120 else []


# ── Doors & entrances ──────────────────────────────────────────────────────────
def detect_doors(binary: np.ndarray) -> List[Dict]:
    """Doors are openings in the wall: where bridging the wall gap adds material that
    wasn't a wall. The added components of ~door width are door candidates."""
    h, w = binary.shape
    walls = wall_mask_hv(binary)
    bridged = bridge_doors(walls, w)
    opening = cv2.subtract(bridged, walls)
    opening = cv2.morphologyEx(opening, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, stats, cent = cv2.connectedComponentsWithStats(opening, 8)
    lo, hi = max(10, w // 70), max(40, w // 16)   # ≈0.35–1.3 m worth of pixels
    # building perimeter (outermost wall bbox) — doors on it are entrances
    ys, xs = np.where(walls > 0)
    if len(xs) == 0:
        return []
    bx0, by0, bx1, by1 = xs.min(), ys.min(), xs.max(), ys.max()
    margin = 0.06 * max(bx1 - bx0, by1 - by0)
    doors = []
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        span = max(bw, bh)
        if not (lo <= span <= hi):
            continue
        cx, cy = cent[i]
        perimeter = (cx - bx0 < margin or bx1 - cx < margin or cy - by0 < margin or by1 - cy < margin)
        doors.append({"cx": cx / w, "cy": cy / h, "width_px": int(span), "perimeter": bool(perimeter)})
    return doors


# ── Stairs ───────────────────────────────────────────────────────────────────--
def detect_stairs(binary: np.ndarray) -> List[Dict]:
    """A staircase is a compact cluster of many parallel, regularly-spaced tread lines.
    Detect clusters of ≥5 parallel line components with consistent spacing."""
    h, w = binary.shape
    lines = remove_text(binary)
    out = []
    for axis in ("h", "v"):
        if axis == "h":
            k = cv2.getStructuringElement(cv2.MORPH_RECT, (max(10, w // 90), 1))
        else:
            k = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(10, h // 90)))
        m = cv2.morphologyEx(lines, cv2.MORPH_OPEN, k)
        n, lab, stats, cent = cv2.connectedComponentsWithStats(m, 8)
        comps = []
        for i in range(1, n):
            x, y, bw, bh, area = stats[i]
            length = bw if axis == "h" else bh
            thick = bh if axis == "h" else bw
            if length >= (w // 30) and thick <= max(4, w // 300):
                comps.append((cent[i][0], cent[i][1], x, y, bw, bh))
        # group by the cross-axis position, look for ≥5 evenly spaced treads nearby
        comps.sort(key=lambda c: c[1] if axis == "h" else c[0])
        i = 0
        while i < len(comps):
            grp = [comps[i]]
            j = i + 1
            while j < len(comps):
                prev = grp[-1]
                pos_prev = prev[1] if axis == "h" else prev[0]
                pos_cur = comps[j][1] if axis == "h" else comps[j][0]
                # treads roughly span the same x-range and are within a tread pitch
                overlap = abs((prev[2] if axis == "h" else prev[3]) - (comps[j][2] if axis == "h" else comps[j][3])) < (w // 12)
                if overlap and (pos_cur - pos_prev) < (h // 22 if axis == "h" else w // 22):
                    grp.append(comps[j]); j += 1
                else:
                    break
            if len(grp) >= 5:
                xs = [g[2] for g in grp] + [g[2] + g[4] for g in grp]
                ysq = [g[3] for g in grp] + [g[3] + g[5] for g in grp]
                out.append({
                    "cx": (min(xs) + max(xs)) / 2 / w, "cy": (min(ysq) + max(ysq)) / 2 / h,
                    "bbox": [min(xs) / w, min(ysq) / h, max(xs) / w, max(ysq) / h], "treads": len(grp),
                })
                i = j
            else:
                i += 1
    return out


# ── Scale calibration ───────────────────────────────────────────────────────────
def infer_scale(doors: List[Dict], image_w: int) -> Optional[Dict]:
    """Estimate metres-per-pixel from detected door widths (standard leaf ≈ 0.9 m).
    Falls back to a low-confidence villa-width assumption when no doors are found."""
    widths = sorted(d["width_px"] for d in doors if d.get("width_px"))
    if len(widths) >= 2:
        med = widths[len(widths) // 2]
        if med > 0:
            spread = (widths[-1] - widths[0]) / float(med)
            conf = round(max(0.3, min(0.85, 0.85 - 0.25 * spread)), 2)
            return {"metersPerPixel": round(STANDARD_DOOR_M / med, 6), "confidence": conf,
                    "source": f"door-width (n={len(widths)}, median={med}px ≈ {STANDARD_DOOR_M}m)"}
    if image_w > 0:
        # assume a typical villa plot drawing spans ~25 m across the image
        return {"metersPerPixel": round(25.0 / image_w, 6), "confidence": 0.2,
                "source": "fallback (assumed ~25 m drawing width)"}
    return None


# ── Room boundary correction ─────────────────────────────────────────────────────
def snap_orthogonal(poly: List[List[float]]) -> List[List[float]]:
    """Force a room polygon to right angles (Manhattan): each edge becomes purely
    horizontal or vertical, aligning boundaries to walls and removing jagged contours."""
    if len(poly) < 4:
        return poly
    out = [list(poly[0])]
    for i in range(1, len(poly)):
        px, py = out[-1]
        cx, cy = poly[i]
        if abs(cx - px) >= abs(cy - py):
            out.append([cx, py])   # horizontal edge
        else:
            out.append([px, cy])   # vertical edge
    # close back to start orthogonally
    sx, sy = out[0]
    lx, ly = out[-1]
    if abs(lx - sx) >= abs(ly - sy):
        out.append([sx, ly])
    return out


def detect_symbol_candidates(binary: np.ndarray, max_boxes: int = 200) -> List[Dict]:
    """Heuristic device-symbol seeds for the Training Center: small, compact, ISOLATED
    blobs that are not part of walls (device symbols are drawn separately from structure).
    Returns normalized [x,y,w,h] boxes for admin review — UNCLASSIFIED (class assigned by the
    reviewer; a trained YOLO model replaces this later)."""
    h, w = binary.shape
    walls = wall_mask_hv(binary)
    symbols = cv2.subtract(binary, cv2.dilate(walls, np.ones((3, 3), np.uint8), iterations=1))
    symbols = cv2.morphologyEx(symbols, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    n, lab, stats, cent = cv2.connectedComponentsWithStats(symbols, 8)
    lo, hi = max(10, w // 160), max(40, w // 24)
    out = []
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        if bw == 0 or bh == 0:
            continue
        size = max(bw, bh)
        asp = max(bw, bh) / float(min(bw, bh))
        fill = area / float(bw * bh)
        if lo <= size <= hi and asp <= 2.5 and 0.2 <= fill <= 0.95:
            out.append({"bboxNorm": [round(x / w, 5), round(y / h, 5), round(bw / w, 5), round(bh / h, 5)],
                        "size": int(size)})
    out.sort(key=lambda b: -b["size"])
    return out[:max_boxes]


def _point_in_bbox(pt, bbox) -> bool:
    x, y = pt
    x0, y0, x1, y1 = bbox
    return x0 <= x <= x1 and y0 <= y <= y1


def geometry_layer(binary: np.ndarray) -> Dict:
    """Run all architectural detectors on the binary mask."""
    cols = detect_columns(binary)
    doors = detect_doors(binary)
    stairs = detect_stairs(binary)
    return {
        "columns": cols,
        "doors": doors,
        "stairs": stairs,
        "scale": infer_scale(doors, binary.shape[1]),
        "titleblock": detect_titleblock(binary),
    }


def geometry_zones(geo: Dict) -> List[Dict]:
    """Emit detected architecture as zones (column/door/entrance/staircase) for the editor
    and the existing rules — no new rules, just richer perception."""
    zones: List[Dict] = []
    for c in geo["columns"]:
        zones.append({"type": "column", "geometry": {"kind": "point", "coords": [[c["cx"], c["cy"]]]}, "confidence": 0.6, "source": "cv"})
    for d in geo["doors"]:
        zones.append({"type": "entrance" if d["perimeter"] else "door",
                      "geometry": {"kind": "point", "coords": [[d["cx"], d["cy"]]]}, "confidence": 0.6, "source": "cv"})
    for s in geo["stairs"]:
        zones.append({"type": "staircase", "geometry": {"kind": "point", "coords": [[s["cx"], s["cy"]]]}, "confidence": 0.65, "source": "cv"})
    return zones


def type_rooms_by_geometry(rooms: List[Dict], geo: Dict) -> int:
    """Type spaces from GEOMETRY when OCR gave nothing (classificationSource == area_heuristic):
    a space over a stair-tread cluster → staircase; a space at a perimeter door → entrance.
    Returns how many rooms were re-typed. Never overrides an OCR-derived type."""
    stairs = geo["stairs"]
    perim_doors = [d for d in geo["doors"] if d.get("perimeter")]
    retyped = 0
    for r in rooms:
        if (r.get("meta") or {}).get("classificationSource") == "ocr_label":
            continue
        cx, cy = r["centroid"]
        if any(_point_in_bbox((cx, cy), s["bbox"]) for s in stairs):
            r["type"], r["label"], r["confidence"] = "staircase", "Staircase", max(r.get("confidence", 0.4), 0.7)
            r.setdefault("meta", {}).update({"classificationSource": "geometry", "geometryCue": "stair-treads"})
            retyped += 1
            continue
        if any(((d["cx"] - cx) ** 2 + (d["cy"] - cy) ** 2) ** 0.5 < 0.07 for d in perim_doors):
            r["type"], r["label"], r["confidence"] = "entrance", "Entrance", max(r.get("confidence", 0.4), 0.66)
            r.setdefault("meta", {}).update({"classificationSource": "geometry", "geometryCue": "perimeter-door"})
            retyped += 1
    return retyped


def orthogonality(poly: List[List[float]]) -> float:
    """Fraction of edges that are axis-aligned (quality metric, 0..1)."""
    if len(poly) < 2:
        return 1.0
    axis = 0
    edges = 0
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        dx, dy = abs(x1 - x0), abs(y1 - y0)
        if dx < 1e-6 and dy < 1e-6:
            continue
        edges += 1
        if min(dx, dy) <= 0.15 * max(dx, dy):
            axis += 1
    return round(axis / edges, 3) if edges else 1.0
