import os


class Settings:
    raster_dpi: int = int(os.getenv("AI_RASTER_DPI", "200"))
    enable_dwg: bool = os.getenv("AI_ENABLE_DWG", "false").lower() == "true"
    fallback_provider: str = os.getenv("AI_FALLBACK_PROVIDER", "disabled")
    yolo_weights: str = os.getenv("YOLO_WEIGHTS", "models/plan-symbols.pt")
    ocr_lang: str = os.getenv("OCR_LANG", "en")
    # LLM fallback keys (only used when fallback_provider != disabled)
    openai_key: str = os.getenv("OPENAI_API_KEY", "")
    gemini_key: str = os.getenv("GEMINI_API_KEY", "")
    anthropic_key: str = os.getenv("ANTHROPIC_API_KEY", "")


settings = Settings()
