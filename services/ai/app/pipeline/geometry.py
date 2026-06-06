"""Stage 3 — wall/line extraction + room segmentation (normalized coords).

Improvements (P2):
  - suppress text / dimension strings / symbols before wall extraction (keep long lines only)
  - bridge door openings so adjoining rooms become separately enclosed regions
  - drop the page-frame / background ring and title-block-sized blobs
  - tighter area band + border-touch filtering
"""
from typing import List, Tuple
import cv2
import numpy as np


def remove_text(binary: np.ndarray) -> np.ndarray:
    """Keep long line structures (walls, frames); drop small blobs (text, dims, symbols)."""
    n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
    h, w = binary.shape
    long_thresh = max(18, w // 60)         # a "wall-ish" structure spans at least this many px
    keep = np.zeros_like(binary)
    for i in range(1, n):
        bw, bh = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]
        if max(bw, bh) >= long_thresh:
            keep[labels == i] = 255
    return keep


def extract_walls(binary: np.ndarray) -> np.ndarray:
    """Text-free wall mask with door openings bridged so rooms enclose cleanly.
    Uses horizontal/vertical line isolation (architecture.wall_mask_hv) which drops
    furniture, door arcs and diagonal leaders that the old blob-close kept."""
    from .architecture import wall_mask_hv, bridge_doors  # lazy import avoids a cycle
    walls = wall_mask_hv(binary)
    return bridge_doors(walls, binary.shape[1])


def _label_regions(labels: np.ndarray, n: int, extent, total: float,
                   min_area_frac: float, max_area_frac: float) -> List[dict]:
    """Turn a label image (0 = wall/background, 1..n-1 = regions) into room dicts,
    filtering noise, the background ring, and dimension slivers."""
    h, w = labels.shape
    x0, y0, x1, y1 = extent
    rooms: List[dict] = []
    for i in range(1, n):
        comp = (labels == i).astype(np.uint8)
        area = int(comp.sum())
        frac = area / total
        if frac < min_area_frac or frac > max_area_frac:
            continue
        ys, xs = np.where(comp)
        x, y, bw, bh = int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)
        # Drop a large component hugging the drawing border (outdoor/background ring).
        touches_border = (x <= x0 + 3 or y <= y0 + 3 or x + bw >= x1 - 3 or y + bh >= y1 - 3)
        if touches_border and frac > 0.30:
            continue
        # Reject extreme slivers (dimension channels) by bbox fill ratio.
        if (bw * bh) > 0 and (area / float(bw * bh)) < 0.15:
            continue
        cnts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            continue
        c = max(cnts, key=cv2.contourArea)
        eps = 0.012 * cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, eps, True).reshape(-1, 2)
        if len(approx) < 3:
            continue
        poly = [[float(px) / w, float(py) / h] for px, py in approx]
        rooms.append({
            "polygon": poly,
            "centroid": [float(xs.mean()) / w, float(ys.mean()) / h],
            "area": frac,
            "bbox_px": [x, y, bw, bh],
        })
    return rooms


def segment_rooms(walls: np.ndarray, extent, min_area_frac: float = 0.004,
                  max_area_frac: float = 0.45) -> List[dict]:
    """Segment rooms from a wall mask.

    Open-plan villa rooms are connected to each other through door openings far wider than
    a morphological close can bridge, so plain connected-components merges them into one
    giant blob (then dropped by the max-area filter). We instead use a distance-transform +
    watershed: room *cores* (points far from any wall) become markers, and the watershed
    grows them back, splitting the interior at the narrow doorway necks between rooms.
    """
    h, w = walls.shape
    x0, y0, x1, y1 = extent
    total = float(w * h)

    interior = cv2.bitwise_not(walls)
    mask = np.zeros_like(interior)
    mask[y0:y1, x0:x1] = interior[y0:y1, x0:x1]
    # tidy 1px speckle without bridging doorways
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))

    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    # A doorway neck's clearance ≈ half a door width. Cutting the interior at this distance
    # disconnects rooms joined only by a doorway while keeping room bodies intact.
    neck = max(6.0, w / 110.0)
    cores = (dist > neck).astype(np.uint8)
    # separate cores that still touch through a wide opening
    cores = cv2.morphologyEx(cores, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))

    n_markers, markers = cv2.connectedComponents(cores)
    if n_markers <= 1:
        # no cores found — fall back to plain components on the interior
        n, labels = cv2.connectedComponents(mask)
        return _label_regions(labels, n, extent, total, min_area_frac, max_area_frac)

    markers = markers + 1            # background = 1, cores = 2..n
    markers[mask == 0] = 0           # unknown (walls) = 0 → watershed fills these
    img3 = cv2.cvtColor(walls, cv2.COLOR_GRAY2BGR)
    cv2.watershed(img3, markers)
    # markers now: -1 on boundaries, 1 = background, ≥2 = rooms. Re-key rooms to 1..k.
    rooms_lab = np.where(markers > 1, markers - 1, 0).astype(np.int32)
    k = int(rooms_lab.max())
    return _label_regions(rooms_lab, k + 1, extent, total, min_area_frac, max_area_frac)


def building_corners(rooms: List[dict]) -> List[Tuple[float, float]]:
    if not rooms:
        return []
    xs = [p[0] for r in rooms for p in r["polygon"]]
    ys = [p[1] for r in rooms for p in r["polygon"]]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
