"""Room-type synonym normalization (mirror of packages/shared/space-types.ts)."""
import re

ROOM_SYNONYMS = {
    "bed": "bedroom", "bedroom": "bedroom", "br": "bedroom",
    "master": "master_bedroom", "master bedroom": "master_bedroom", "m bed": "master_bedroom", "mbed": "master_bedroom",
    "maid": "maid_room", "maid room": "maid_room",
    "majlis": "majlis", "majles": "majlis", "mejlis": "majlis",
    "living": "living_room", "living room": "living_room", "family": "living_room", "hall": "living_room",
    "sitting": "sitting_area", "lounge": "sitting_area",
    "dining": "dining", "dinning": "dining",
    "kitchen": "kitchen", "pantry": "kitchen",
    "corridor": "corridor", "passage": "corridor", "lobby": "corridor",
    "entrance": "entrance", "entry": "entrance", "foyer": "entrance",
    "main door": "main_door",
    "garden": "garden", "lawn": "garden", "landscape": "garden",
    "parking": "parking", "car porch": "parking", "car park": "parking", "shed": "parking", "garage": "parking",
    "gate": "gate",
    "stair": "staircase", "stairs": "staircase", "staircase": "staircase",
    "lift": "lift", "elevator": "lift",
    "bath": "bathroom", "toilet": "bathroom", "wc": "bathroom",
    "store": "store", "storage": "store",
    "service": "service_area", "utility": "service_area", "technical": "service_area",
    "roof": "roof", "terrace": "roof",
}

ZONE_LABELS = {"gate": "gate", "main gate": "gate", "parking": "parking", "garden": "garden",
               "driveway": "driveway", "main door": "entrance"}


def normalize(raw: str):
    k = re.sub(r"[^a-z. ]", "", raw.lower()).strip()
    if k in ROOM_SYNONYMS:
        return ROOM_SYNONYMS[k]
    for syn, t in ROOM_SYNONYMS.items():
        if syn in k:
            return t
    return None
