# -*- coding: utf-8 -*-
"""Stage 4 — OCR room labels.

Pluggable engine (RapidOCR / PaddleOCR), bilingual (Latin + Arabic), with label-friendly
preprocessing (upscale so thin CAD strokes are legible). Returns normalized token centers.
Gracefully degrades to an empty list when no engine is importable, so the rest of the
pipeline still runs on geometry alone.

Each token: {text, center[x,y] (normalized 0..1), conf, bbox[x0,y0,x1,y1] (normalized)}.
"""
from typing import List, Optional
import cv2
import numpy as np

from ..config import settings

_engine = None          # callable(bgr) -> list[(box, text, conf)]
_engine_name: Optional[str] = None
_tried = False


# ── Engine adapters ─────────────────────────────────────────────────────────────
def _make_rapidocr():
    """RapidOCR (ONNX). Light, no system deps, ships Latin+Arabic dictionaries."""
    from rapidocr_onnxruntime import RapidOCR
    eng = RapidOCR()

    def run(bgr: np.ndarray):
        res, _ = eng(bgr)
        out = []
        for box, text, conf in (res or []):
            out.append((box, text, float(conf)))
        return out

    return run


def _make_paddle():
    """PaddleOCR. lang='arabic' recognizes Arabic AND Latin, so it covers mixed plans;
    otherwise honor configured language."""
    from paddleocr import PaddleOCR
    lang = "arabic" if settings.ocr_arabic else (settings.ocr_lang or "en")
    eng = PaddleOCR(use_angle_cls=True, lang=lang, show_log=False)

    def run(bgr: np.ndarray):
        result = eng.ocr(bgr, cls=True)
        out = []
        for line in (result or []):
            for box, (text, conf) in (line or []):
                out.append((box, text, float(conf)))
        return out

    return run


_FACTORIES = {"rapidocr": _make_rapidocr, "paddle": _make_paddle}


def _get_engine():
    global _engine, _engine_name, _tried
    if _engine is not None or _tried:
        return _engine
    _tried = True
    for name in [n.strip() for n in settings.ocr_engine.split(",") if n.strip()]:
        factory = _FACTORIES.get(name)
        if not factory:
            continue
        try:
            _engine = factory()
            _engine_name = name
            break
        except Exception:
            continue
    return _engine


def engine_name() -> Optional[str]:
    _get_engine()
    return _engine_name


# ── Preprocessing ───────────────────────────────────────────────────────────────
def _prep_for_ocr(bgr: np.ndarray) -> tuple:
    """Upscale (thin CAD text) + mild sharpen. Returns (image, scale) so we can map
    detected boxes back to original-normalized coordinates."""
    scale = max(1.0, float(settings.ocr_upscale))
    if scale > 1.0:
        bgr = cv2.resize(bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    return bgr, scale


# ── Public API ──────────────────────────────────────────────────────────────────
def read_text(bgr: np.ndarray) -> List[dict]:
    """Return raw OCR tokens (unfiltered). Caller filters dimensions/annotations
    (see pipeline.textfilter). Empty list if no OCR engine is available."""
    eng = _get_engine()
    if eng is None:
        return []
    proc, _ = _prep_for_ocr(bgr)
    ph, pw = proc.shape[:2]
    try:
        raw = eng(proc)
    except Exception:
        return []
    out: List[dict] = []
    for box, text, conf in raw:
        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        out.append({
            "text": text,
            "center": [((x0 + x1) / 2) / pw, ((y0 + y1) / 2) / ph],
            "bbox": [x0 / pw, y0 / ph, x1 / pw, y1 / ph],
            "conf": float(conf),
        })
    return out
