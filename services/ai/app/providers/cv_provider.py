"""Default self-hosted provider: OpenCV + YOLO + OCR + rule engine + quality control."""
import numpy as np

from .base import VisionProvider
from ..schemas import AnalysisResult, AnalysisQcSummary
from ..pipeline.preprocess import preprocess
from ..pipeline.geometry import extract_walls, segment_rooms
from ..pipeline.ocr import read_text
from ..pipeline.detect import detect_symbols
from ..pipeline.fusion import fuse
from ..pipeline import architecture as arch
from ..rules.engine import suggest
from ..rules.quality import filter_rooms, apply_placement_qc, build_summary


class CvProvider(VisionProvider):
    def analyze(self, bgr: np.ndarray, floor_id=None, qc=None) -> AnalysisResult:
        warnings = []
        pp = preprocess(bgr)
        walls = extract_walls(pp["binary"])
        rooms_geo = segment_rooms(walls, pp["extent"])
        # Geometry intelligence: read doors, columns, stairs and scale from the drawing,
        # and correct room boundaries to right angles.
        geo = arch.geometry_layer(pp["binary"])
        for rg in rooms_geo:
            rg["polygon"] = arch.snap_orthogonal(rg["polygon"])
        if not rooms_geo:
            warnings.append("no enclosed rooms detected; try higher DPI or check plan quality")
        texts = read_text(bgr)
        if not texts:
            warnings.append("OCR returned no labels; room types inferred heuristically")
        detections = detect_symbols(bgr)
        if not detections:
            warnings.append("symbol detector returned nothing (untrained weights?)")

        raw_rooms, zones = fuse(rooms_geo, texts, detections)
        # Type spaces from geometry where OCR was silent (stairs, perimeter entrances).
        geo_typed = arch.type_rooms_by_geometry(raw_rooms, geo)
        zones = zones + arch.geometry_zones(geo)
        if geo["doors"]:
            warnings.append(
                f"Geometry: {len(geo['doors'])} doors ({sum(d['perimeter'] for d in geo['doors'])} entrances), "
                f"{len(geo['columns'])} columns, {len(geo['stairs'])} staircase(s); "
                f"scale ≈ {geo['scale']['metersPerPixel']:.4f} m/px ({geo['scale']['source']})"
                if geo.get("scale") else f"Geometry: {len(geo['doors'])} doors detected"
            )
        accepted_rooms, rejected_rooms, room_rejections = filter_rooms(raw_rooms, qc)

        raw_placements = suggest(accepted_rooms, zones)
        accepted_placements, rejected_placements, placement_rejections = apply_placement_qc(
            raw_placements, accepted_rooms, qc,
        )
        placements = accepted_placements + rejected_placements

        qc_summary = AnalysisQcSummary(**build_summary(
            raw_rooms, accepted_rooms, rejected_rooms,
            raw_placements, accepted_placements, rejected_placements,
            placement_rejections, room_rejections,
        ))

        # Surface the no-interior-space fallback prominently via the existing warnings
        # channel so the inconsistency is explained without any new UI.
        if qc_summary.acceptedSpaces == 0 and qc_summary.acceptedPlacements > 0:
            warnings.insert(0, qc_summary.summary or "Perimeter/zone-based suggestions only — no interior spaces detected")
        if len(rejected_rooms) > 0:
            warnings.append(f"QC filtered {len(rejected_rooms)} low-quality space detections")
        if len(rejected_placements) > 0:
            warnings.append(f"QC rejected {len(rejected_placements)} device suggestions (see summary)")

        confidences = [r["confidence"] for r in accepted_rooms] or [0.4]
        # Return BOTH accepted and rejected spaces so the user can review and recover
        # rejected ones in the editor. meta.qcStatus / rejectionReason distinguish them;
        # the API derives reviewStatus from meta and uses only non-rejected for placement.
        all_rooms = accepted_rooms + rejected_rooms
        return AnalysisResult(
            floorId=floor_id,
            image={"width": int(pp["w"]), "height": int(pp["h"])},
            rooms=all_rooms, zones=zones,
            detections=[{"class": d["class"], "bbox": d["bbox"], "confidence": d["confidence"]} for d in detections],
            placements=placements,
            confidence=round(sum(confidences) / len(confidences), 3),
            provider="cv", warnings=warnings,
            qcSummary=qc_summary,
            rawRoomCount=len(raw_rooms),
            scale=geo.get("scale"),
            providerUsed="cv",
            modelName="opencv+geometry+ocr+rules",
            fallbackChain=["cv"],
            errors=[],
        )
