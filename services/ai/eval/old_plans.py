# -*- coding: utf-8 -*-
"""old_plans importer + multi-floor model (Phase A, runnable without Mongo/S3).

Treats each BEFORE/AFTER PDF pair as ONE project with MULTIPLE floors (pages). Discovers
pairs (no hard-coded names), matches pages by index with a confidence from page
size/orientation, and infers floor type from the AFTER vector-text title. Rendering and AI
analysis are cached per floor so a full 10-villa / 34-page run survives the shell time limit
across resumable invocations.
"""
import glob
import json
import os
import re
import subprocess
from collections import defaultdict

from eval.extract_after import _page_words, extract_floor  # vector-text engineer GT

CACHE = os.path.join(os.path.dirname(__file__), "_cache")
os.makedirs(CACHE, exist_ok=True)

FLOOR_KEYWORDS = [
    ("basement", "basement"), ("mezzanine", "mezzanine"),
    ("site", "site"), ("location", "site"), ("ground", "ground"),
    ("first", "first"), ("second", "second"), ("third", "third"),
    ("roof", "roof"), ("typical", "typical"),
]


def discover_pairs(folder):
    """Group PDFs into {n: {'before':path,'after':path,'name':str}} by example number."""
    pairs = defaultdict(dict)
    for f in glob.glob(os.path.join(folder, "*.pdf")):
        base = os.path.basename(f)
        m = re.search(r"example\s*(\d+)", base, re.I)
        if not m:
            continue
        n = int(m.group(1))
        role = "after" if re.search(r"after", base, re.I) else ("before" if re.search(r"before", base, re.I) else None)
        if not role:
            continue
        pairs[n][role] = f
        pairs[n]["name"] = f"Example {n}"
    return {n: p for n, p in sorted(pairs.items()) if "before" in p and "after" in p}


def _pdf_pages(pdf):
    out = subprocess.run(["pdfinfo", pdf], capture_output=True, text=True).stdout
    m = re.search(r"Pages:\s*(\d+)", out)
    return int(m.group(1)) if m else 0


def _page_dims(pdf):
    """Per-page (w,h) in points, for orientation/size match confidence."""
    out = subprocess.run(["pdfinfo", "-f", "1", "-l", "9999", pdf], capture_output=True, text=True).stdout
    dims = []
    for m in re.finditer(r"Page\s+\d+ size:\s+([\d.]+) x ([\d.]+)", out):
        dims.append((float(m.group(1)), float(m.group(2))))
    if not dims:  # single-page pdfinfo fallback
        m = re.search(r"Page size:\s+([\d.]+) x ([\d.]+)", out)
        if m:
            dims = [(float(m.group(1)), float(m.group(2)))]
    return dims


def infer_floor_type(after_words, page_index, page_count):
    """Floor type from the AFTER page title text; fall back to a page-order heuristic."""
    text = " ".join(w[0] for w in after_words).lower()
    for kw, ft in FLOOR_KEYWORDS:
        if re.search(rf"\b{kw}", text):
            return ft, "title-text"
    # fallback: typical villa page order
    if page_count == 1:
        return "ground", "single-page"
    order = ["site", "ground", "first", "second", "roof"]
    if page_index - 1 < len(order):
        return order[page_index - 1], "page-order"
    return "unknown", "page-order"


def match_confidence(b_dim, a_dim):
    """Confidence that BEFORE page p matches AFTER page p, from orientation + aspect."""
    if not b_dim or not a_dim:
        return 0.5, "no-dims"
    bo = b_dim[0] >= b_dim[1]
    ao = a_dim[0] >= a_dim[1]
    if bo != ao:
        return 0.5, "orientation-mismatch"
    ba = max(b_dim) / max(1e-6, min(b_dim))
    aa = max(a_dim) / max(1e-6, min(a_dim))
    rel = abs(ba - aa) / max(ba, aa)
    return (round(max(0.6, 1 - rel), 2), "orientation+aspect")


def build_manifest(folder):
    """Project/floor manifest with page matching, floor types, engineer device counts."""
    pairs = discover_pairs(folder)
    projects = []
    for n, p in pairs.items():
        b_pages, a_pages = _pdf_pages(p["before"]), _pdf_pages(p["after"])
        b_dims, a_dims = _page_dims(p["before"]), _page_dims(p["after"])
        after_pages = _page_words(p["after"])  # [(W,H,words), ...]
        floors = []
        page_count = min(b_pages, a_pages) if (b_pages and a_pages) else max(b_pages, a_pages)
        for i in range(1, page_count + 1):
            aw = after_pages[i - 1][2] if i - 1 < len(after_pages) else []
            ft, ft_src = infer_floor_type(aw, i, page_count)
            W, H = (after_pages[i - 1][0], after_pages[i - 1][1]) if i - 1 < len(after_pages) else (1, 1)
            eng = extract_floor(aw, W, H)
            conf, conf_src = match_confidence(
                b_dims[i - 1] if i - 1 < len(b_dims) else None,
                a_dims[i - 1] if i - 1 < len(a_dims) else None)
            floors.append({
                "pageIndex": i, "floorType": ft, "floorTypeSource": ft_src,
                "matchConfidence": conf, "matchSource": conf_src,
                "engineerDeviceCounts": _counts(eng), "engineerDevices": eng,
            })
        projects.append({
            "project": p["name"], "before": os.path.basename(p["before"]), "after": os.path.basename(p["after"]),
            "beforePages": b_pages, "afterPages": a_pages,
            "pageCountMatch": b_pages == a_pages, "pageCount": page_count,
            "floors": floors,
        })
    return projects


def _counts(devs):
    c = {}
    for d in devs:
        c[d["deviceCode"]] = c.get(d["deviceCode"], 0) + 1
    return c


def render_cached(pdf, page, dpi=150):
    """Render one PDF page to a cached PNG path."""
    key = re.sub(r"[^A-Za-z0-9]+", "_", os.path.basename(pdf)) + f"_p{page}_{dpi}.png"
    path = os.path.join(CACHE, key)
    if not os.path.exists(path):
        base = path[:-4]
        subprocess.run(["pdftoppm", "-r", str(dpi), "-f", str(page), "-l", str(page), "-png",
                        "-singlefile", pdf, base], check=True, capture_output=True)
    return path


if __name__ == "__main__":
    import sys
    folder = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(__file__), "..", "..", "..", "old_plans")
    man = build_manifest(os.path.abspath(folder))
    print(json.dumps(man, indent=2)[:4000])
    print(f"\nprojects: {len(man)}; floors: {sum(len(p['floors']) for p in man)}")
