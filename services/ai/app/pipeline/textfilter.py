# -*- coding: utf-8 -*-
"""Pre-classification text filtering.

CAD sheets are dominated by dimension strings, level/elevation tags, grid bubbles, and
door/window marks. These swamp OCR and, if fed to the classifier, masquerade as room
labels. This module removes obvious non-label tokens so only plausible room names reach
classification. It is deliberately conservative: it drops clear noise and lets the room
classifier make the final call on the rest.
"""
import re

# Pure numbers / punctuation (dimensions, counts): "600", "3.50", "-1.05", "220,190".
_NUMERIC = re.compile(r"^[\s\d.,\-+/]+$")
# Dimension pairs: "600 X 430", "220x190", "6.00 X 4.30".
_DIMENSION = re.compile(r"\d+(?:[.,]\d+)?\s*[xX×*]\s*\d+(?:[.,]\d+)?")
# Levels / elevations / setting-out marks: "+0.65 FFL", "G.F-LVL", "F.F.L", "C.L", "S.S.L".
_LEVEL = re.compile(r"(?:\bF\.?F\.?L\b|\bLVL\b|\bLEVEL\b|\bS\.?S\.?L\b|\bC\.?L\b|G\.?F[\.\-]|F\.?F[\.\-]|[+\-]\d+\.\d+)", re.I)
# Drawing scale: "1:100", "SCALE 1:50".
_SCALE = re.compile(r"\b\d{1,3}\s*:\s*\d{1,4}\b")
# Grid bubbles / door & window marks: "D1", "SD2", "W1", "A", "12", "3A", "B-2".
_MARK = re.compile(r"^[A-Za-z]{0,3}[\-\.]?\d{1,3}[A-Za-z]?$")
# Area / unit annotations: "12.40 m2", "47.30 SQM".
_UNIT = re.compile(r"\d.*(?:m2|m²|sqm|sq\.m|sq m|mm|cm)\b", re.I)

# Tokens that are valid room labels yet short / punctuated — never treat as noise.
_KEEP_SHORT = {"wc", "w.c", "br", "db", "mbr", "bath", "wash", "hall", "lift", "majlis"}

_ARABIC = re.compile(r"[؀-ۿ]")
_LATIN_RUN = re.compile(r"[A-Za-z]{3,}")


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()


def is_noise(text: str) -> bool:
    """True if a token is clearly NOT a room label (dimension / level / mark / number)."""
    t = _norm(text)
    if not t:
        return True
    low = t.lower().replace(" ", "")
    if low in _KEEP_SHORT or low.replace(".", "") in _KEEP_SHORT:
        return False
    if _DIMENSION.search(t) or _LEVEL.search(t) or _SCALE.search(t) or _UNIT.search(t):
        return True
    if _NUMERIC.match(t):
        return True
    if _MARK.match(t):
        return True
    return False


def is_label_candidate(text: str) -> bool:
    """A token worth attempting to classify: has a real word (≥3 Latin letters or any
    Arabic), and is not obvious dimension/annotation noise."""
    t = _norm(text)
    if is_noise(t):
        return False
    if _ARABIC.search(t):
        return True
    if _LATIN_RUN.search(t):
        return True
    # short but whitelisted (WC, BR, …)
    return t.lower().replace(" ", "").replace(".", "") in _KEEP_SHORT


def filter_tokens(tokens):
    """Keep only label-candidate OCR tokens (each token is a dict with a 'text' key)."""
    return [tk for tk in tokens if is_label_candidate(tk.get("text", ""))]
