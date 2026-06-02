"""Stage 3 — wall/line extraction + room segmentation (normalized coords)."""
from typing import List, Tuple
import cv2
import numpy as np


def extract_walls(binary: np.ndarray) -> np.ndarray:
    """Morphological close to connect wall lines -> wall mask."""
    k = max(3, binary.shape[1] // 200)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
    walls = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    return walls


def segment_rooms(walls: np.ndarray, extent, min_area_frac: float = 0.012) -> List[dict]:
    """Find enclosed regions between walls -> candidate room polygons (normalized)."""
    h, w = walls.shape
    x0, y0, x1, y1 = extent
    ew, eh = max(1, x1 - x0), max(1, y1 - y0)

    # interior = inverse of walls, bounded by drawing extent
    interior = cv2.bitwise_not(walls)
    mask = np.zeros_like(interior)
    mask[y0:y1, x0:x1] = interior[y0:y1, x0:x1]

    # open to drop thin gaps, then connected components
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

    n, labels, stats, centroids = cv2.connectedComponentsWithStats(mask, 8)
    total = w * h
    rooms: List[dict] = []
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        if area / total < min_area_frac or area / total > 0.6:
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
            "bbox_px": [int(stats[i, 0]), int(stats[i, 1]), int(stats[i, 2]), int(stats[i, 3])],
        })
    return rooms


def building_corners(rooms: List[dict]) -> List[Tuple[float, float]]:
    if not rooms:
        return []
    xs = [p[0] for r in rooms for p in r["polygon"]]
    ys = [p[1] for r in rooms for p in r["polygon"]]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
