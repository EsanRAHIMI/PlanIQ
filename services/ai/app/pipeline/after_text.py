# -*- coding: utf-8 -*-
"""Engineer placement extraction from an AFTER drawing's vector text layer (first-class
AI-service capability; the Training Center prefers this over the heuristic symbol detector).

Engineer AFTER PDFs label every device in place ("Wi-Fi AP", "Speaker | Z1", "Sensor",
"Intercom Screen", "Thermostat", "Gate Motor", …) and draw Wi-Fi APs as an icon glyph that
extracts as "7". We parse words + page coordinates via `pdftotext -bbox`, map them to canonical
device codes, de-duplicate Wi-Fi icon+text pairs, and return normalized engineer placements
per page. Falls back gracefully (empty) when the PDF has no text layer (scanned drawings).
"""
import html
import re
import subprocess
import tempfile
from collections import Counter
from typing import List, Optional

PHRASES = [
    ("intercom screen", "INTERCOM_SCREEN"), ("intercom bell", "INTERCOM_BELL"),
    ("gate motor", "GATE_MOTOR"), ("smart lock", "SMART_LOCK"), ("elv rack", "ELV_RACK"),
    ("wi-fi ap", "WIFI_AP"), ("wifi ap", "WIFI_AP"), ("volume", "VOLUME_CONTROL"),
    ("speaker", "SPEAKER"), ("sensor", "SENSOR"), ("thermostat", "THERMOSTAT"),
    ("projector", "PROJECTOR"), ("screen", "SCREEN"), ("camera", "CCTV"), ("cctv", "CCTV"),
]
WIFI_GLYPH = "7"
FLOOR_BY_INDEX = {1: "site", 2: "ground", 3: "first", 4: "roof"}


def page_words(pdf_path: str):
    """[(page_w, page_h, [(text, xMin, yMin, xMax, yMax), …]), …] in PDF points."""
    xml = subprocess.run(["pdftotext", "-bbox", pdf_path, "-"], capture_output=True, text=True).stdout
    pages = []
    for pg in xml.split("<page")[1:]:
        m = re.search(r'width="([\d.]+)" height="([\d.]+)"', pg)
        if not m:
            continue
        W, H = float(m.group(1)), float(m.group(2))
        words = []
        for w in re.findall(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>', pg):
            words.append((html.unescape(w[4]), float(w[0]), float(w[1]), float(w[2]), float(w[3])))
        pages.append((W, H, words))
    return pages


def _center(w, W, H):
    return ((w[1] + w[3]) / 2 / W, (w[2] + w[4]) / 2 / H)


def extract_floor(words, W, H) -> List[dict]:
    """Map a page's words to engineer device placements (normalized centers)."""
    devices, wifi_text, consumed = [], [], set()
    lowered = [w[0].lower() for w in words]
    n, i = len(words), 0
    while i < n:
        if i in consumed:
            i += 1
            continue
        matched = False
        for phrase, code in PHRASES:
            parts = phrase.split()
            if lowered[i:i + len(parts)] == parts:
                cx, cy = _center(words[i], W, H)
                (wifi_text if code == "WIFI_AP" else devices).append(
                    (cx, cy) if code == "WIFI_AP" else
                    {"deviceCode": code, "x": round(cx, 4), "y": round(cy, 4), "via": "text", "rawText": " ".join(parts)})
                for j in range(i, i + len(parts)):
                    consumed.add(j)
                i += len(parts); matched = True
                break
        if not matched:
            i += 1
    wifi_pts = [_center(w, W, H) for k, w in enumerate(words) if k not in consumed and w[0].strip() == WIFI_GLYPH]
    DEDUP = 0.05
    for (tx, ty) in wifi_text:
        if not any((tx - ix) ** 2 + (ty - iy) ** 2 < DEDUP ** 2 for ix, iy in wifi_pts):
            wifi_pts.append((tx, ty))
    for (x, y) in wifi_pts:
        devices.append({"deviceCode": "WIFI_AP", "x": round(x, 4), "y": round(y, 4), "via": "icon/text", "rawText": "Wi-Fi AP"})
    return devices


def extract_pdf(pdf_path: str) -> dict:
    """All pages of an AFTER PDF → engineer placements + per-floor counts."""
    floors = []
    for idx, (W, H, words) in enumerate(page_words(pdf_path), 1):
        devs = extract_floor(words, W, H)
        floors.append({"page": idx, "floor": FLOOR_BY_INDEX.get(idx, f"page{idx}"),
                       "deviceCounts": dict(Counter(d["deviceCode"] for d in devs)), "devices": devs})
    return {"floors": floors, "hasTextLayer": any(f["devices"] for f in floors)}


def extract_pdf_bytes(data: bytes) -> dict:
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=True) as tf:
        tf.write(data); tf.flush()
        return extract_pdf(tf.name)
