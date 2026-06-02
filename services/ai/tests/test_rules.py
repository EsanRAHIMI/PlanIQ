from app.rules.engine import suggest


def _room(t, cx, cy, area=0.1):
    return {"label": t, "type": t,
            "polygon": [[cx - .1, cy - .1], [cx + .1, cy - .1], [cx + .1, cy + .1], [cx - .1, cy + .1]],
            "centroid": [cx, cy], "area": area, "confidence": 0.9, "source": "cv"}


def test_cctv_on_corners():
    p = suggest([_room("living_room", .5, .5)], [])
    assert len([x for x in p if x["deviceCode"] == "CCTV"]) >= 4


def test_gate_zone():
    z = [{"type": "gate", "geometry": {"kind": "point", "coords": [[.5, .95]]}, "confidence": .8, "source": "cv"}]
    p = suggest([_room("majlis", .5, .5)], z)
    assert any(x["deviceCode"] == "GATE_MOTOR" for x in p)
    assert any(x["deviceCode"] == "INTERCOM_BELL" for x in p)


def test_rack_in_service_area():
    p = suggest([_room("service_area", .2, .2), _room("living_room", .6, .6)], [])
    rack = next(x for x in p if x["deviceCode"] == "ELV_RACK")
    assert "service" in rack["rationale"].lower()


def test_all_editable_ai_suggestions():
    p = suggest([_room("majlis", .5, .5)], [])
    assert all(x["source"] == "ai" and x["reviewed"] is False for x in p)
