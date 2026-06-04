from app.rules.engine import suggest


def _room(t, cx, cy, area=0.1):
    return {"label": t, "type": t,
            "polygon": [[cx - .1, cy - .1], [cx + .1, cy - .1], [cx + .1, cy + .1], [cx - .1, cy + .1]],
            "centroid": [cx, cy], "area": area, "confidence": 0.9, "source": "cv"}


def test_cctv_street_perimeter():
    # Two street-facing perimeter cameras (not four blind corners) per the customer rule.
    p = suggest([_room("living_room", .5, .5)], [])
    cams = [x for x in p if x["deviceCode"] == "CCTV"]
    assert len(cams) >= 2
    assert any("perimeter" in c["rationale"].lower() for c in cams)
    assert any(c["meta"]["basis"] == "perimeter" for c in cams)


def test_gate_zone():
    z = [{"type": "gate", "geometry": {"kind": "point", "coords": [[.5, .95]]}, "confidence": .8, "source": "cv"}]
    p = suggest([_room("majlis", .5, .5)], z)
    assert any(x["deviceCode"] == "GATE_MOTOR" for x in p)
    assert any(x["deviceCode"] == "INTERCOM_BELL" for x in p)


def test_rack_priority_staircase_over_service():
    # Staircase outranks service area for the ELV rack.
    p = suggest([_room("staircase", .2, .2), _room("service_area", .8, .8)], [])
    rack = next(x for x in p if x["deviceCode"] == "ELV_RACK")
    assert "staircase" in rack["rationale"].lower()
    assert any(x["deviceCode"] == "SWITCH" for x in p)
    assert any(x["deviceCode"] == "NVR" for x in p)


def test_rack_in_service_area_when_no_staircase():
    p = suggest([_room("service_area", .2, .2), _room("living_room", .6, .6)], [])
    rack = next(x for x in p if x["deviceCode"] == "ELV_RACK")
    assert "service" in rack["rationale"].lower()


def test_two_speakers_and_volume_per_entertainment_room():
    # Customer rule: 2 speakers in majlis, 2 in living, 2 in dining; one volume knob per pair.
    p = suggest([_room("majlis", .25, .25), _room("living_room", .55, .55), _room("dining", .8, .2)], [])
    assert len([x for x in p if x["deviceCode"] == "SPEAKER"]) == 6
    assert len([x for x in p if x["deviceCode"] == "VOLUME_CONTROL"]) == 3


def test_wifi_guest_lobby_between_majlis_and_dining():
    p = suggest([_room("majlis", .2, .5), _room("dining", .8, .5)], [])
    ap = next(x for x in p if x["deviceCode"] == "WIFI_AP" and "guest lobby" in x["rationale"].lower())
    assert abs(ap["position"]["x"] - 0.5) < 0.05  # midpoint between the two rooms


def test_kitchen_gets_camera_and_intercom():
    p = suggest([_room("kitchen", .5, .5)], [])
    assert any(x["deviceCode"] == "CCTV" and "kitchen" in x["rationale"].lower() for x in p)
    assert any(x["deviceCode"] == "INTERCOM_SCREEN" for x in p)


def test_all_editable_ai_suggestions():
    p = suggest([_room("majlis", .5, .5)], [])
    assert all(x["source"] == "ai" and x["reviewed"] is False for x in p)
