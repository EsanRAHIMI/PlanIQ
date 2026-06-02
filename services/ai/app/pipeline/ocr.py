"""Stage 4 — OCR room labels (PaddleOCR primary, graceful no-op fallback)."""
from typing import List
import numpy as np

_ocr = None
_failed = False


def _engine():
    global _ocr, _failed
    if _ocr is None and not _failed:
        try:
            from paddleocr import PaddleOCR
            _ocr = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
        except Exception:
            _failed = True
    return _ocr


def read_text(bgr: np.ndarray) -> List[dict]:
    """Return [{text, bbox(normalized center), conf}]. Empty if OCR unavailable."""
    eng = _engine()
    if eng is None:
        return []
    h, w = bgr.shape[:2]
    out: List[dict] = []
    try:
        result = eng.ocr(bgr, cls=True)
    except Exception:
        return []
    for line in (result or []):
        for box, (text, conf) in (line or []):
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            out.append({
                "text": text,
                "center": [(min(xs) + max(xs)) / 2 / w, (min(ys) + max(ys)) / 2 / h],
                "conf": float(conf),
            })
    return out
