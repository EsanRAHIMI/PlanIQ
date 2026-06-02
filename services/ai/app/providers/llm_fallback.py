"""Optional Vision-LLM fallback adapter. DISABLED by default.
Only used when AI_FALLBACK_PROVIDER != 'disabled' AND a request explicitly asks for it
(admin review / debugging / hard edge cases). Output still passes through the rule engine
and the same validation, and remains fully editable downstream."""
import base64
import io
import numpy as np
from PIL import Image

from .base import VisionProvider
from ..schemas import AnalysisResult
from ..rules.engine import suggest
from ..config import settings


PROMPT = (
    "You are an architectural plan analyst. Return STRICT JSON with keys rooms[] and zones[]. "
    "Each room: {label,type,polygon[[x,y]...normalized 0..1],centroid[x,y],area,confidence}. "
    "type must be one of the canonical room types. zones: gate/parking/entrance with point coords. "
    "Do not place any devices."
)


class LlmFallbackProvider(VisionProvider):
    def __init__(self, which: str):
        self.which = which  # openai | gemini | claude

    def _png_b64(self, bgr: np.ndarray) -> str:
        img = Image.fromarray(bgr[:, :, ::-1])
        buf = io.BytesIO(); img.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode()

    def analyze(self, bgr: np.ndarray, floor_id=None) -> AnalysisResult:
        rooms, zones, warnings = [], [], ["LLM fallback used"]
        try:
            rooms, zones = self._call(self._png_b64(bgr))
        except Exception as e:  # never hard-fail; degrade to empty + warning
            warnings.append(f"LLM fallback error: {e}")
        placements = suggest(rooms, zones)
        return AnalysisResult(
            floorId=floor_id, image={"width": bgr.shape[1], "height": bgr.shape[0]},
            rooms=rooms, zones=zones, detections=[], placements=placements,
            confidence=0.6 if rooms else 0.2, provider="llm_fallback", warnings=warnings,
        )

    def _call(self, b64: str):
        # Thin adapters; wire real SDKs when enabled. Kept minimal and provider-agnostic.
        if self.which == "openai" and settings.openai_key:
            return self._openai(b64)
        if self.which == "claude" and settings.anthropic_key:
            return self._claude(b64)
        if self.which == "gemini" and settings.gemini_key:
            return self._gemini(b64)
        raise RuntimeError(f"provider '{self.which}' not configured")

    def _parse(self, text: str):
        import json, re
        m = re.search(r"\{.*\}", text, re.S)
        data = json.loads(m.group(0)) if m else {"rooms": [], "zones": []}
        return data.get("rooms", []), data.get("zones", [])

    def _openai(self, b64):
        import requests
        r = requests.post("https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {settings.openai_key}"},
            json={"model": "gpt-4o", "messages": [{"role": "user", "content": [
                {"type": "text", "text": PROMPT},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}]}]},
            timeout=120)
        return self._parse(r.json()["choices"][0]["message"]["content"])

    def _claude(self, b64):
        import requests
        r = requests.post("https://api.anthropic.com/v1/messages",
            headers={"x-api-key": settings.anthropic_key, "anthropic-version": "2023-06-01"},
            json={"model": "claude-3-5-sonnet-20240620", "max_tokens": 4000, "messages": [{"role": "user", "content": [
                {"type": "text", "text": PROMPT},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}}]}]},
            timeout=120)
        return self._parse(r.json()["content"][0]["text"])

    def _gemini(self, b64):
        import requests
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key={settings.gemini_key}"
        r = requests.post(url, json={"contents": [{"parts": [
            {"text": PROMPT}, {"inline_data": {"mime_type": "image/png", "data": b64}}]}]}, timeout=120)
        return self._parse(r.json()["candidates"][0]["content"]["parts"][0]["text"])
