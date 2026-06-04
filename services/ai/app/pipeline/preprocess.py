"""Stage 2 — OpenCV preprocessing: deskew, binarize, denoise, drawing-extent crop."""
from typing import Tuple
import cv2
import numpy as np


def preprocess(bgr: np.ndarray) -> dict:
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    # adaptive binarization (drawings are line art on white)
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 35, 11)
    binary = cv2.medianBlur(binary, 3)

    angle = _estimate_skew(binary)
    if abs(angle) > 0.5:
        binary = _rotate(binary, angle)
        gray = _rotate(gray, angle)

    # Compute the drawing extent on the de-texted line mask so a sparse title block /
    # legend / notes in a margin doesn't inflate the plan bounds.
    from .geometry import remove_text
    extent = _drawing_extent(remove_text(binary))
    return {"gray": gray, "binary": binary, "skew": angle, "extent": extent,
            "h": bgr.shape[0], "w": bgr.shape[1]}


def _estimate_skew(binary: np.ndarray) -> float:
    coords = np.column_stack(np.where(binary > 0))
    if coords.shape[0] < 100:
        return 0.0
    rect = cv2.minAreaRect(coords[:, ::-1].astype(np.float32))
    angle = rect[-1]
    if angle < -45:
        angle += 90
    return float(angle) if abs(angle) < 15 else 0.0


def _rotate(img: np.ndarray, angle: float) -> np.ndarray:
    h, w = img.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    return cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_NEAREST, borderValue=0)


def _drawing_extent(binary: np.ndarray) -> Tuple[int, int, int, int]:
    """Bounding box (x0,y0,x1,y1) of the main drawing, ignoring sparse margins."""
    cols = np.where(binary.sum(axis=0) > 0)[0]
    rows = np.where(binary.sum(axis=1) > 0)[0]
    if len(cols) == 0 or len(rows) == 0:
        return (0, 0, binary.shape[1], binary.shape[0])
    return (int(cols.min()), int(rows.min()), int(cols.max()), int(rows.max()))
