"""Default self-hosted provider: OpenCV + YOLO + OCR + rule engine + quality control."""
import numpy as np

from .base import VisionProvider
from ..schemas import AnalysisResult, AnalysisQcSummary
from ..pipeline.preprocess import preprocess
from ..pipeline.geometry import extract_walls, segment_rooms
from ..pipeline.ocr import read_text
from ..pipeline.detect import detect_symbols
from ..pipeline.fusion import fuse
from ..rules.engine import suggest
from ..rules.quality import filter_rooms, apply_placement_qc, build_summary


class CvProvider(VisionProvider):
    def analyze(self, bgr: np.ndarray, floor_id=None) -> AnalysisResult:
        warnings = []
        pp = preprocess(bgr)
        walls = extract_walls(pp["binary"])
        rooms_geo = segment_rooms(walls, pp["extent"])
        if not rooms_geo:
            warnings.append("no enclosed rooms detected; try higher DPI or check plan quality")
        texts = read_text(bgr)
        if not texts:
            warnings.append("OCR returned no labels; room types inferred heuristically")
        detections = detect_symbols(bgr)
        if not detections:
            warnings.append("symbol detector returned nothing (untrained weights?)")

        raw_rooms, zones = fuse(rooms_geo, texts, detections)
        accepted_rooms, rejected_rooms, room_rejections = filter_rooms(raw_rooms)

        raw_placements = suggest(accepted_rooms, zones)
        accepted_placements, rejected_placements, placement_rejections = apply_placement_qc(
            raw_placements, accepted_rooms,
        )
        placements = accepted_placements + rejected_placements

        qc_summary = AnalysisQcSummary(**build_summary(
            raw_rooms, accepted_rooms, rejected_rooms,
            raw_placements, accepted_placements, rejected_placements,
            placement_rejections, room_rejections,
        ))

        if len(rejected_rooms) > 0:
            warnings.append(f"QC filtered {len(rejected_rooms)} low-quality space detections")
        if len(rejected_placements) > 0:
            warnings.append(f"QC rejected {len(rejected_placements)} device suggestions (see summary)")

        confidences = [r["confidence"] for r in accepted_rooms] or [0.4]
        return AnalysisResult(
            floorId=floor_id,
            image={"width": int(pp["w"]), "height": int(pp["h"])},
            rooms=accepted_rooms, zones=zones,
            detections=[{"class": d["class"], "bbox": d["bbox"], "confidence": d["confidence"]} for d in detections],
            placements=placements,
            confidence=round(sum(confidences) / len(confidences), 3),
            provider="cv", warnings=warnings,
            qcSummary=qc_summary,
            rawRoomCount=len(raw_rooms),
        )
