# -*- coding: utf-8 -*-
"""Priority-1 regression tests: text filtering, classification coverage, honest fallback."""
from app.pipeline.textfilter import is_noise, is_label_candidate, filter_tokens
from app.pipeline.spaces import classify
from app.pipeline.fusion import fuse
from app.rules.quality import filter_rooms


def test_dimensions_and_marks_are_noise():
    for t in ["600 X 430", "220x190", "3.50", "+0.65 FFL", "G.F-LVL", "1:100", "D1", "SD2", "W1", "12.40 m2"]:
        assert is_noise(t), t
    for t in ["DINING", "MAJLIS", "Kitchen", "WC", "W.C", "Family Hall"]:
        assert not is_noise(t), t


def test_label_candidate_filtering_keeps_only_words():
    tokens = [{"text": "DINING"}, {"text": "600 X 430"}, {"text": "+0.65 FFL"},
              {"text": "MAJLIS"}, {"text": "D2"}, {"text": "غرفة نوم"}]
    kept = [t["text"] for t in filter_tokens(tokens)]
    assert "DINING" in kept and "MAJLIS" in kept and "غرفة نوم" in kept
    assert "600 X 430" not in kept and "+0.65 FFL" not in kept and "D2" not in kept


def test_new_room_synonyms():
    assert classify("HALL")[0] == "living_room"
    assert classify("FAMILY HALL")[0] == "living_room"
    assert classify("LADIES MAJLIS")[0] == "majlis"
    assert classify("MEN MAJLIS")[0] == "majlis"
    assert classify("BUFFET")[0] == "dining"


def _geo_room(cx, cy, a=0.06):
    h = (a ** 0.5) / 2
    return {"polygon": [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]],
            "centroid": [cx, cy], "area": a}


def test_unlabelled_room_is_unclassified_not_bedroom():
    rooms_geo = [_geo_room(0.5, 0.5, a=0.08)]
    rooms, _ = fuse(rooms_geo, [], [])   # no OCR text at all
    assert rooms[0]["type"] == "unclassified"
    assert rooms[0]["type"] != "bedroom"


def test_labelled_room_uses_ocr_type():
    rooms_geo = [_geo_room(0.5, 0.5, a=0.08)]
    texts = [{"text": "Majlis", "center": [0.5, 0.5], "conf": 0.95}]
    rooms, _ = fuse(rooms_geo, texts, [])
    assert rooms[0]["type"] == "majlis"
    assert rooms[0]["meta"]["classificationSource"] == "ocr_label"


def test_geometry_rooms_kept_for_review_not_rejected():
    # A real region with a low-confidence (unclassified) type is accepted-for-review,
    # so a floor is never empty when geometry found rooms.
    rooms_geo = [_geo_room(0.5, 0.5, a=0.08)]
    raw, _ = fuse(rooms_geo, [], [])
    accepted, rejected, _ = filter_rooms(raw)
    assert len(accepted) == 1
    assert accepted[0]["meta"]["needsReview"] is True


def test_dimension_token_does_not_become_a_room_type():
    rooms_geo = [_geo_room(0.5, 0.5, a=0.08)]
    texts = [{"text": "600 X 430", "center": [0.5, 0.5], "conf": 0.9}]
    rooms, _ = fuse(rooms_geo, texts, [])
    assert rooms[0]["type"] == "unclassified"   # the dimension was filtered out
