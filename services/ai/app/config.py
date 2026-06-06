import os


class Settings:
    raster_dpi: int = int(os.getenv("AI_RASTER_DPI", "200"))
    enable_dwg: bool = os.getenv("AI_ENABLE_DWG", "false").lower() == "true"
    fallback_provider: str = os.getenv("AI_FALLBACK_PROVIDER", "disabled")
    yolo_weights: str = os.getenv("YOLO_WEIGHTS", "models/plan-symbols.pt")
    # OCR engine preference order. Comma-separated; first importable wins.
    #   rapidocr → ONNX, light, bilingual-capable, no system deps (good default + sandbox)
    #   paddle   → PaddleOCR (heavier, strong; prod option)
    ocr_engine: str = os.getenv("OCR_ENGINE", "rapidocr,paddle")
    ocr_lang: str = os.getenv("OCR_LANG", "en")
    # Read Arabic in addition to Latin on mixed EN/AR drawings.
    ocr_arabic: bool = os.getenv("OCR_ARABIC", "true").lower() == "true"
    # Upscale factor applied before OCR so thin CAD label strokes are legible.
    ocr_upscale: float = float(os.getenv("OCR_UPSCALE", "2.0"))
    # LLM fallback keys (only used when fallback_provider != disabled)
    openai_key: str = os.getenv("OPENAI_API_KEY", "")
    gemini_key: str = os.getenv("GEMINI_API_KEY", "")
    anthropic_key: str = os.getenv("ANTHROPIC_API_KEY", "")


settings = Settings()
