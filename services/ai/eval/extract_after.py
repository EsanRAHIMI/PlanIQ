# -*- coding: utf-8 -*-
"""Extract engineer device placements from an AFTER drawing's vector text layer.

The engineer AFTER PDFs label every device in place ("Wi-Fi AP", "Speaker | Z1", "Sensor",
"Intercom Screen", "Thermostat", "Gate Motor", …) and draw the Wi-Fi access points with an
icon-font glyph that extracts as the character "7". We parse those words with their page
coordinates (via `pdftotext -bbox`), map them to canonical device codes, de-duplicate the
Wi-Fi icon+text pairs, and emit normalized engineer placements per floor.

This is GROUND TRUTH for placement calibration — read directly from the engineer's own
drawing, not inferred. Usage:

  python -m eval.extract_after --pdf "example 2 AFTER.pdf" [--out eval/groundtruth/after/ex2.json]
"""
import argparse
import html
import json
import os
import re
import subprocess
from collections import Counter

# Multi-word device phrases (checked first), then single tokens. Maps to device codes used
# by the rule engine / device library.
PHRASES = [
    ("intercom screen", "INTERCOM_SCREEN"),
    ("intercom bell", "INTERCOM_BELL"),
    ("gate motor", "GATE_MOTOR"),
    ("smart lock", "SMART_LOCK"),
    ("elv rack", "ELV_RACK"),
    ("wi-fi ap", "WIFI_AP"),
    ("wifi ap", "WIFI_AP"),
    ("volume", "VOLUME_CONTROL"),
    ("speaker", "SPEAKER"),
    ("sensor", "SENSOR"),
    ("thermostat", "THERMOSTAT"),
    ("projector", "PROJECTOR"),
    ("screen", "SCREEN"),
    ("camera", "CCTV"),
    ("cctv", "CCTV"),
]
# The Wi-Fi AP icon-font glyph extracts as a lone "7".
WIFI_GLYPH = "7"
# Non-device words to ignore (floor titles, rack spec, zone tags, separators).
IGNORE = {"site", "plan", "ground", "floor", "first", "fisrt", "second", "roof", "z1", "z2",
          "z3", "|", "9u", "60x60x60", "1st", "2nd", ""}

FLOOR_BY_INDEX = {1: "site", 2: "ground", 3: "first", 4: "roof"}


def _page_words(pdf: str):
    """Return [(page_w, page_h, [(text, xMin, yMin, xMax, yMax), …]), …] in PDF points."""
    xml = subprocess.run(["pdftotext", "-bbox", pdf, "-"], capture_output=True, text=True).stdout
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


def extract_floor(words, W, H):
    """Map a page's words to engineer device placements (normalized centers)."""
    devices = []          # {deviceCode, x, y, via}
    wifi_text = []        # centers of explicit "Wi-Fi AP" text
    consumed = set()

    # 1) multi-word phrases: scan tokens, greedily match the longest phrase.
    toks = [(html.unescape(t), *rest) for (t, *rest) in [(w[0], w[1], w[2], w[3], w[4]) for w in words]]
    n = len(words)
    i = 0
    lowered = [w[0].lower() for w in words]
    while i < n:
        if i in consumed:
            i += 1
            continue
        matched = False
        for phrase, code in PHRASES:
            parts = phrase.split()
            if lowered[i:i + len(parts)] == parts:
                cx, cy = _center(words[i], W, H)
                if code == "WIFI_AP":
                    wifi_text.append((cx, cy))
                else:
                    devices.append({"deviceCode": code, "x": round(cx, 4), "y": round(cy, 4), "via": "text"})
                for j in range(i, i + len(parts)):
                    consumed.add(j)
                i += len(parts)
                matched = True
                break
        if not matched:
            i += 1

    # 2) Wi-Fi icon glyphs ("7"). Each is a Wi-Fi AP. De-dupe against nearby Wi-Fi text.
    wifi_pts = []
    for k, w in enumerate(words):
        if k in consumed:
            continue
        if w[0].strip() == WIFI_GLYPH:
            wifi_pts.append(_center(w, W, H))
    # union icon points with text points that aren't near an icon
    DEDUP = 0.05
    for (tx, ty) in wifi_text:
        if not any((tx - ix) ** 2 + (ty - iy) ** 2 < DEDUP ** 2 for ix, iy in wifi_pts):
            wifi_pts.append((tx, ty))
    for (x, y) in wifi_pts:
        devices.append({"deviceCode": "WIFI_AP", "x": round(x, 4), "y": round(y, 4), "via": "icon/text"})

    return devices


def extract(pdf: str):
    pages = _page_words(pdf)
    floors = []
    for idx, (W, H, words) in enumerate(pages, 1):
        devices = extract_floor(words, W, H)
        floors.append({
            "page": idx,
            "floor": FLOOR_BY_INDEX.get(idx, f"page{idx}"),
            "deviceCounts": dict(Counter(d["deviceCode"] for d in devices)),
            "devices": devices,
        })
    return {"source": os.path.basename(pdf), "floors": floors}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--out")
    a = ap.parse_args()
    data = extract(a.pdf)
    for f in data["floors"]:
        print(f"  page {f['page']:>1} ({f['floor']:>6}): {f['deviceCounts']}")
    if a.out:
        os.makedirs(os.path.dirname(a.out), exist_ok=True)
        json.dump(data, open(a.out, "w"), indent=2)
        print("wrote", a.out)


if __name__ == "__main__":
    main()
