"""PlanIQ AI/CV service — FastAPI. Self-hosted analysis pipeline.
Endpoints: /health, /ingest (rasterize), /analyze (full pipeline), /suggest (rule engine only)."""
import os
import time
import logging
import numpy as np
import requests
from fastapi import FastAPI, UploadFile, File, Form, HTTPException

from .config import settings
from .schemas import AnalyzeRequest, SuggestRequest, AnalysisResult, IngestResponse
from .pipeline.ingest import rasterize, decode_image
from .providers.cv_provider import CvProvider
from .providers.llm_fallback import LlmFallbackProvider
from .rules.engine import suggest as rule_suggest

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("planiq-ai")
app = FastAPI(title="PlanIQ AI/CV Service", version="1.0")

_cv = CvProvider()


@app.get("/health")
def health():
    weights_path = settings.yolo_weights
    weights_loaded = os.path.isfile(weights_path)
    from .pipeline.ocr import engine_name
    return {
        "status": "ok",
        "fallback": settings.fallback_provider,
        "dwg": settings.enable_dwg,
        "ocrEngine": engine_name(),
        # YOLO is an OPTIONAL perception layer: inactive until a model is in production.
        # When inactive the system runs fully on OCR + geometry + rules + priors.
        "yolo": {
            "weights": settings.yolo_weights,
            "weightsLoaded": weights_loaded,
            "active": weights_loaded,           # detection runs only if weights exist
            "role": "perception (detection confidence + candidate generation); never overrides geometry/OCR/rules/QC",
        },
    }


@app.post("/ingest", response_model=IngestResponse)
async def ingest(file: UploadFile = File(...), dpi: int = Form(None)):
    data = await file.read()
    try:
        pages, warnings = rasterize(file.filename or "plan", data, dpi)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {"pages": pages, "warnings": warnings}


def _load_bgr(req: AnalyzeRequest) -> np.ndarray:
    if req.imageB64:
        return decode_image(req.imageB64)
    if req.imageUrl:
        r = requests.get(req.imageUrl, timeout=60)
        r.raise_for_status()
        import base64
        return decode_image(base64.b64encode(r.content).decode())
    raise HTTPException(status_code=400, detail="imageUrl or imageB64 required")


@app.post("/analyze", response_model=AnalysisResult)
def analyze(req: AnalyzeRequest):
    started = time.time()
    bgr = _load_bgr(req)
    use_fallback = (req.provider == "llm_fallback"
                    and settings.fallback_provider != "disabled")
    chain: list[str] = []
    if use_fallback:
        chain.append("cv_skipped")
        chain.append(f"llm_fallback:{settings.fallback_provider}")
        log.info("Using LLM fallback provider: %s", settings.fallback_provider)
        provider = LlmFallbackProvider(settings.fallback_provider)
    else:
        chain.append("cv")
        if req.fallbackProvider and req.fallbackProvider != "disabled":
            chain.append(f"fallback_available:{req.fallbackProvider}")
        provider = _cv
    qc = req.qc.model_dump(exclude_none=True) if req.qc else None
    try:
        if isinstance(provider, CvProvider):
            result = provider.analyze(bgr, req.floorId, qc, floor_type=req.floorType,
                                      priors=req.priors, detector_active=req.detectorActive)
        else:
            result = provider.analyze(bgr, req.floorId, qc)
        result.durationMs = int((time.time() - started) * 1000)
        if not result.fallbackChain:
            result.fallbackChain = chain
        return result
    except Exception as e:
        log.exception("analyze failed")
        raise HTTPException(status_code=422, detail=f"analysis failed: {e}")


@app.post("/extract-devices")
def extract_devices(req: AnalyzeRequest):
    """Heuristic device-symbol extraction for the Training Center. Returns candidate boxes
    (unclassified) on the AFTER plan for human review. A trained detector replaces this."""
    bgr = _load_bgr(req)
    from .pipeline.preprocess import preprocess
    from .pipeline.architecture import detect_symbol_candidates
    pp = preprocess(bgr)
    boxes = detect_symbol_candidates(pp["binary"])
    # default class is a placeholder the reviewer reassigns
    return {"boxes": [{"deviceCode": "CCTV", "bboxNorm": b["bboxNorm"], "source": "heuristic"} for b in boxes],
            "count": len(boxes)}


@app.post("/extract-after-text")
async def extract_after_text(file: UploadFile = File(None), imageUrl: str = Form(None)):
    """Engineer placement extraction from an AFTER PDF's vector text layer (strongest GT).
    Accepts a PDF upload or a URL. Returns per-page engineer placements + counts. Empty
    (hasTextLayer=false) for scanned drawings → caller falls back to the heuristic detector."""
    from .pipeline.after_text import extract_pdf_bytes
    if file is not None:
        data = await file.read()
    elif imageUrl:
        r = requests.get(imageUrl, timeout=120); r.raise_for_status(); data = r.content
    else:
        raise HTTPException(status_code=400, detail="file or imageUrl required")
    try:
        return extract_pdf_bytes(data)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"after-text extraction failed: {e}")


@app.post("/suggest", response_model=AnalysisResult)
def suggest_only(req: SuggestRequest):
    rooms = [r.model_dump() for r in req.rooms]
    zones = [z.model_dump() for z in req.zones]
    # Closed learning loop: priors + floorType nudge confidence and apply floor-type policy.
    priors = getattr(req, "priors", None)
    floor_type = getattr(req, "floorType", None)
    detector_active = bool(getattr(req, "detectorActive", False))
    placements = rule_suggest(rooms, zones, priors=priors, floor_type=floor_type, detector_active=detector_active)
    return AnalysisResult(image={"width": 0, "height": 0}, rooms=req.rooms, zones=req.zones,
                          placements=placements, confidence=0.7, provider="cv", warnings=[])
