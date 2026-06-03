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
    return {
        "status": "ok",
        "fallback": settings.fallback_provider,
        "dwg": settings.enable_dwg,
        "weights": settings.yolo_weights,
        "weightsLoaded": weights_loaded,
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
        result = provider.analyze(bgr, req.floorId, qc)
        result.durationMs = int((time.time() - started) * 1000)
        if not result.fallbackChain:
            result.fallbackChain = chain
        return result
    except Exception as e:
        log.exception("analyze failed")
        raise HTTPException(status_code=422, detail=f"analysis failed: {e}")


@app.post("/suggest", response_model=AnalysisResult)
def suggest_only(req: SuggestRequest):
    rooms = [r.model_dump() for r in req.rooms]
    zones = [z.model_dump() for z in req.zones]
    placements = rule_suggest(rooms, zones)
    return AnalysisResult(image={"width": 0, "height": 0}, rooms=req.rooms, zones=req.zones,
                          placements=placements, confidence=0.7, provider="cv", warnings=[])
