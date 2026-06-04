# -*- coding: utf-8 -*-
"""Room-type label classification (mirror of packages/shared/src/space-types.ts).

Bilingual (English + Arabic) + variant + fuzzy matching with a confidence score that
reflects HOW the label matched, so fusion can build a meaningful room confidence.
"""
import re

ROOM_SYNONYMS = {
    # bedrooms
    "master bedroom": "master_bedroom", "master bed": "master_bedroom", "m.bed": "master_bedroom",
    "m bedroom": "master_bedroom", "mbr": "master_bedroom", "master": "master_bedroom",
    "غرفة رئيسية": "master_bedroom", "غرفة ماستر": "master_bedroom", "النوم الرئيسية": "master_bedroom",
    "bedroom": "bedroom", "bed room": "bedroom", "bed": "bedroom", "br": "bedroom",
    "غرفة نوم": "bedroom", "نوم": "bedroom", "غرفة": "bedroom",
    # maid
    "maid room": "maid_room", "maids room": "maid_room", "maid": "maid_room", "servant": "maid_room",
    "غرفة خادمة": "maid_room", "خادمة": "maid_room", "الخدم": "maid_room",
    # majlis / living
    "majlis": "majlis", "majles": "majlis", "mejlis": "majlis", "men majlis": "majlis", "guest majlis": "majlis",
    "مجلس": "majlis", "مجلس رجال": "majlis",
    "living room": "living_room", "living": "living_room", "family living": "living_room", "family": "living_room",
    "معيشة": "living_room", "صالة معيشة": "living_room", "صالة": "living_room", "جلوس عائلي": "living_room",
    "sitting area": "sitting_area", "sitting": "sitting_area", "lounge": "sitting_area", "جلوس": "sitting_area",
    # dining
    "dining room": "dining", "dining": "dining", "dinning": "dining",
    "غرفة طعام": "dining", "طعام": "dining", "سفرة": "dining",
    # dressing
    "dressing room": "dressing", "dressing": "dressing", "walk in closet": "dressing", "walkin": "dressing",
    "wardrobe": "dressing", "closet": "dressing",
    "غرفة ملابس": "dressing", "ملابس": "dressing", "دريسنج": "dressing",
    # kitchen / pantry / laundry
    "kitchen": "kitchen", "main kitchen": "kitchen", "wet kitchen": "kitchen", "dry kitchen": "kitchen",
    "مطبخ": "kitchen", "المطبخ": "kitchen",
    "pantry": "pantry", "preparation": "pantry", "prep": "pantry", "coffee corner": "pantry", "بانتري": "pantry", "تحضير": "pantry",
    "laundry": "laundry", "washing": "laundry", "مغسلة": "laundry", "غسيل": "laundry",
    # bathroom
    "bathroom": "bathroom", "bath": "bathroom", "toilet": "bathroom", "wc": "bathroom", "w.c": "bathroom", "powder": "bathroom",
    "حمام": "bathroom", "دورة مياه": "bathroom", "دورةمياه": "bathroom", "مرحاض": "bathroom",
    # store / electrical / service
    "indoor store": "store_indoor", "inside store": "store_indoor",
    "outdoor store": "store_outdoor", "outside store": "store_outdoor", "external store": "store_outdoor",
    "store": "store", "storage": "store", "مخزن": "store",
    "electrical room": "electrical_room", "electric room": "electrical_room", "elec room": "electrical_room",
    "db room": "electrical_room", "mdb": "electrical_room", "db": "electrical_room", "electrical": "electrical_room",
    "غرفة كهرباء": "electrical_room", "كهرباء": "electrical_room", "لوحة كهرباء": "electrical_room",
    "service area": "service_area", "service": "service_area", "utility": "service_area", "technical": "service_area",
    "خدمة": "service_area", "خدمات": "service_area",
    # circulation
    "corridor": "corridor", "passage": "corridor", "lobby": "corridor", "hallway": "corridor", "foyer": "corridor",
    "ممر": "corridor", "ردهة": "corridor",
    "staircase": "staircase", "stairs": "staircase", "stair": "staircase", "درج": "staircase", "سلم": "staircase",
    "lift": "lift", "elevator": "lift", "مصعد": "lift",
    # entrances
    "main entrance": "main_entrance", "main door": "main_door", "main entry": "main_entrance",
    "مدخل رئيسي": "main_entrance", "المدخل الرئيسي": "main_entrance",
    "guest entrance": "guest_entrance", "guest entry": "guest_entrance", "مدخل ضيوف": "guest_entrance",
    "service entrance": "service_entrance", "service entry": "service_entrance", "مدخل خدمة": "service_entrance",
    "entrance": "entrance", "entry": "entrance", "مدخل": "entrance",
    # outdoor
    "swimming pool": "pool", "pool": "pool", "مسبح": "pool", "حوض سباحة": "pool",
    "bbq": "bbq", "barbeque": "bbq", "barbecue": "bbq", "شواء": "bbq",
    "outdoor seating": "outdoor_seating", "seating area": "outdoor_seating", "sitting outdoor": "outdoor_seating", "gazebo": "outdoor_seating",
    "garden": "garden", "landscape": "garden", "lawn": "garden", "yard": "garden", "حديقة": "garden",
    "parking": "parking", "car porch": "parking", "car park": "parking", "garage": "parking", "shed": "parking",
    "مواقف": "parking", "موقف": "parking", "كراج": "parking",
    "gate": "gate", "main gate": "gate", "بوابة": "gate",
    "roof": "roof", "terrace": "roof", "سطح": "roof",
    "outdoor": "outdoor", "external": "outdoor",
}

ZONE_LABELS = {
    "main gate": "gate", "gate": "gate", "بوابة": "gate",
    "parking": "parking", "مواقف": "parking",
    "garden": "garden", "حديقة": "garden",
    "driveway": "driveway",
    "street": "street", "road": "street", "شارع": "street",
}

_SYNONYM_KEYS = sorted(ROOM_SYNONYMS.keys(), key=len, reverse=True)
_KEEP = re.compile(r"[^a-z0-9؀-ۿ]+")


def normalize_label_text(raw: str) -> str:
    s = (raw or "").lower()
    s = _KEEP.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


def _edit_distance(a: str, b: str) -> int:
    if abs(len(a) - len(b)) > 2:
        return 99
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(prev[j - 1] if ca == cb else 1 + min(prev[j], cur[j - 1], prev[j - 1]))
        prev = cur
    return prev[-1]


def classify(raw: str):
    """Return (room_type, score) or None. Score reflects match strength (0.62–0.95)."""
    k = normalize_label_text(raw)
    if not k:
        return None
    if k in ROOM_SYNONYMS:
        return ROOM_SYNONYMS[k], 0.95
    kc = k.replace(" ", "")
    if kc != k and kc in ROOM_SYNONYMS:  # e.g. "w c" → "wc"
        return ROOM_SYNONYMS[kc], 0.9
    words = set(k.split(" "))
    for syn in _SYNONYM_KEYS:
        if " " not in syn and syn in words:
            return ROOM_SYNONYMS[syn], 0.88
    for syn in _SYNONYM_KEYS:
        if syn in k:
            return ROOM_SYNONYMS[syn], 0.78 if len(syn) >= 4 else 0.7
    for w in words:
        if len(w) < 4:
            continue
        for syn in _SYNONYM_KEYS:
            if " " in syn or len(syn) < 4:
                continue
            if _edit_distance(w, syn) <= 1:
                return ROOM_SYNONYMS[syn], 0.62
    return None


def normalize(raw: str):
    """Back-compat: room type only."""
    res = classify(raw)
    return res[0] if res else None
