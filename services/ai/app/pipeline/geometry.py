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


def segment_rooms(walls: np.ndarray, extent, min_area_frac: float = 0.006,
                  max_area_frac: float = 0.45) -> List[dict]:
    """Enclosed regions between walls → candidate room polygons (normalized)."""
    h, w = walls.shape
    x0, y0, x1, y1 = extent
    total = float(w * h)

    interior = cv2.bitwise_not(walls)
    mask = np.zeros_like(interior)
    mask[y0:y1, x0:x1] = interior[y0:y1, x0:x1]

    # open to drop thin gaps, then connected components
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

    n, labels, stats, centroids = cv2.connectedComponentsWithStats(mask, 8)
    rooms: List[dict] = []
    for i in range(1, n):
        x, y = stats[i, cv2.CC_STAT_LEFT], stats[i, cv2.CC_STAT_TOP]
        bw, bh = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]
        area = stats[i, cv2.CC_STAT_AREA]
        frac = area / total
        if frac < min_area_frac or frac > max_area_frac:
            continue
        # A large component hugging the drawing border is the outdoor/background ring,
        # not a room — drop it. (Small border-touching rooms are still kept.)
        touches_border = (x <= x0 + 3 or y <= y0 + 3 or x + bw >= x1 - 3 or y + bh >= y1 - 3)
        if touches_border and frac > 0.12:
            continue
        # Reject extreme slivers (dimension channels) by solidity of the bbox fill.
        if (bw * bh) > 0 and (area / float(bw * bh)) < 0.18:
            continue

        comp = (labels == i).astype(np.uint8)
        cnts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            continue
        c = max(cnts, key=cv2.contourArea)
        eps = 0.01 * cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, eps, True).reshape(-1, 2)
        poly = [[float(px) / w, float(py) / h] for px, py in approx]
        cx, cy = centroids[i]
        rooms.append({
            "polygon": poly,
            "centroid": [float(cx) / w, float(cy) / h],
            "area": float(area) / total,
            "bbox_px": [int(x), int(y), int(bw), int(bh)],
        })
    return rooms


def building_corners(rooms: List[dict]) -> List[Tuple[float, float]]:
    if not rooms:
        return []
    xs = [p[0] for r in rooms for p in r["polygon"]]
    ys = [p[1] for r in rooms for p in r["polygon"]]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
