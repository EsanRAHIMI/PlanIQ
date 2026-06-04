"""Quality control tests."""
from app.rules.engine import suggest
from app.rules.quality import filter_rooms, apply_placement_qc


def _room(t, cx, cy, area=0.1, conf=0.9):
    return {
        "label": t, "type": t,
        "polygon": [[cx - .1, cy - .1], [cx + .1, cy - .1], [cx + .1, cy + .1], [cx - .1, cy + .1]],
        "centroid": [cx, cy], "area": area, "confidence": conf, "source": "cv",
    }


def test_filters_tiny_rooms():
    raw = [_room("bedroom", 0.5, 0.5, area=0.005, conf=0.9)]
    accepted, rejected, _ = filter_rooms(raw)
    assert len(accepted) == 0
    assert len(rejected) == 1


def test_device_count_within_villa_caps():
    # Many small corridor fragments + one living room — QC stays within floor caps
    # and reconciles (nothing lost): accepted + rejected == raw suggestions.
    raw = [_room("corridor", 0.1 + i * 0.02, 0.5, area=0.015, conf=0.5) for i in range(30)]
    raw.append(_room("living_room", 0.5, 0.5, area=0.15, conf=0.85))
    accepted, _, _ = filter_rooms(raw)
    placements = suggest(accepted, [])
    acc, rej, _ = apply_placement_qc(placements, accepted)
    assert len(acc) <= 160
    assert len(acc) + len(rej) == len(placements)


def test_two_speakers_survive_qc_in_majlis():
    # The P1 regression fix: per-room budget counts only room-anchored devices, so the
    # perimeter cameras no longer starve the majlis — both speakers survive.
    rooms = [_room("majlis", 0.5, 0.5, area=0.14)]
    acc, _, _ = filter_rooms(rooms)
    placements = suggest(acc, [])
    accepted, _, _ = apply_placement_qc(placements, acc)
    assert len([p for p in accepted if p["deviceCode"] == "SPEAKER"]) == 2


def test_perimeter_cctv_not_counted_against_room_budget():
    rooms = [_room("living_room", 0.5, 0.5, area=0.14)]
    acc, _, _ = filter_rooms(rooms)
    placements = suggest(acc, [])
    accepted, _, _ = apply_placement_qc(placements, acc)
    perim = [p for p in accepted if p["deviceCode"] == "CCTV" and (p.get("meta") or {}).get("basis") == "perimeter"]
    assert len(perim) >= 2
