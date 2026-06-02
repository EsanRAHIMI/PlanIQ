"""Stage 1 — ingest & rasterize source files into page images."""
import base64
import io
from typing import List, Tuple

import numpy as np
from PIL import Image

from ..config import settings


def _name_for_page(text: str, idx: int) -> str:
    t = (text or "").upper()
    for key, label in [
        ("SITE", "Site Plan"), ("GROUND", "Ground Floor"), ("FIRST", "First Floor"),
        ("SECOND", "Second Floor"), ("ROOF", "Roof Plan"), ("BASEMENT", "Basement"),
    ]:
        if key in t:
            return label
    return f"Page {idx + 1}"


def rasterize(filename: str, data: bytes, dpi: int = None) -> Tuple[List[dict], List[str]]:
    """Return list of {name, width, height, b64(png)} pages + warnings."""
    dpi = dpi or settings.raster_dpi
    warnings: List[str] = []
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""

    pages: List[dict] = []
    if ext == "pdf":
        import fitz  # PyMuPDF
        doc = fitz.open(stream=data, filetype="pdf")
        zoom = dpi / 72.0
        for i, page in enumerate(doc):
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            if pix.width * pix.height < 200_000:
                warnings.append(f"low resolution page {i + 1}")
            pages.append(_encode(img, _name_for_page(page.get_text(), i)))
    elif ext in ("png", "jpg", "jpeg"):
        img = Image.open(io.BytesIO(data)).convert("RGB")
        pages.append(_encode(img, "Floor Plan"))
    elif ext == "dwg":
        if not settings.enable_dwg:
            raise ValueError("DWG support disabled. Export the plan to PDF/PNG.")
        pages.extend(_rasterize_dwg(data, dpi))
    else:
        raise ValueError(f"Unsupported file type: {ext}")

    return pages, warnings


def _encode(img: Image.Image, name: str) -> dict:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return {"name": name, "width": img.width, "height": img.height,
            "b64": base64.b64encode(buf.getvalue()).decode()}


def _rasterize_dwg(data: bytes, dpi: int) -> List[dict]:
    import tempfile, ezdxf
    from ezdxf.addons.drawing import RenderContext, Frontend
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
    import matplotlib.pyplot as plt
    with tempfile.NamedTemporaryFile(suffix=".dxf", delete=False) as f:
        f.write(data); path = f.name
    doc = ezdxf.readfile(path)
    fig = plt.figure()
    ax = fig.add_axes([0, 0, 1, 1])
    Frontend(RenderContext(doc), MatplotlibBackend(ax)).draw_layout(doc.modelspace())
    buf = io.BytesIO(); fig.savefig(buf, dpi=dpi, format="png"); plt.close(fig)
    img = Image.open(buf).convert("RGB")
    return [_encode(img, "DWG Plan")]


def decode_image(b64: str) -> np.ndarray:
    raw = base64.b64decode(b64)
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    return np.array(img)[:, :, ::-1]  # RGB->BGR for OpenCV
