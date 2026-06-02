"""Stage 5 — YOLOv11 symbol detection. Falls back to heuristic-empty when no weights."""
import os
from typing import List
import numpy as np

from ..config import settings

_model = None
_unavailable = False


def _load():
    global _model, _unavailable
    if _model is None and not _unavailable:
        if not os.path.exists(settings.yolo_weights):
            _unavailable = True
            return None
        try:
            from ultralytics import YOLO
            _model = YOLO(settings.yolo_weights)
        except Exception:
            _unavailable = True
    return _model


def detect_symbols(bgr: np.ndarray) -> List[dict]:
    """Return [{class, bbox(normalized xywh), confidence}]. Empty if no trained weights yet."""
    model = _load()
    if model is None:
        return []  # graceful: pipeline runs on geometry+OCR until weights are trained
    h, w = bgr.shape[:2]
    out: List[dict] = []
    res = model.predict(bgr, verbose=False, conf=0.25)
    for r in res:
        for b in r.boxes:
            x1, y1, x2, y2 = b.xyxy[0].tolist()
            out.append({
                "class": model.names[int(b.cls)],
                "bbox": [x1 / w, y1 / h, (x2 - x1) / w, (y2 - y1) / h],
                "confidence": float(b.conf),
            })
    return out
