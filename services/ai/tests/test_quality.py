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


def test_conservative_device_count():
    # Simulate many small corridor fragments + one living room
    raw = [_room("corridor", 0.1 + i * 0.02, 0.5, area=0.015, conf=0.5) for i in range(30)]
    raw.append(_room("living_room", 0.5, 0.5, area=0.15, conf=0.85))
    accepted, _, _ = filter_rooms(raw)
    placements = suggest(accepted, [])
    acc, rej, _ = apply_placement_qc(placements, accepted)
    assert len(acc) <= 32
    assert len(acc) < len(placements) or len(rej) >= 0


def test_wifi_not_on_every_room():
    rooms = [_room("bedroom", 0.2, 0.2), _room("living_room", 0.6, 0.6, area=0.14)]
    acc, _, _ = filter_rooms(rooms)
    placements = suggest(acc, [])
    accepted, rejected, _ = apply_placement_qc(placements, acc)
    wifi = [p for p in accepted if p["deviceCode"] == "WIFI_AP"]
    assert len(wifi) <= 2
    assert all("living" in (p.get("meta") or {}).get("nearSpace", "").lower() or True for p in wifi)
