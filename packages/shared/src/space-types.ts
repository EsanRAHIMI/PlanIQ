/** Canonical functional space types detected on plans. */
export const ROOM_TYPES = [
  'bedroom', 'master_bedroom', 'maid_room', 'majlis', 'living_room',
  'sitting_area', 'dining', 'kitchen', 'corridor', 'entrance', 'main_door',
  'outdoor', 'garden', 'parking', 'gate', 'staircase', 'lift', 'bathroom',
  'store', 'service_area', 'roof',
] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

export const ZONE_TYPES = [
  'gate', 'parking', 'garden', 'driveway', 'entrance', 'wall',
  'staircase', 'lift', 'outdoor',
] as const;
export type ZoneType = (typeof ZONE_TYPES)[number];

/** OCR/label synonyms → canonical room type. Lowercased, punctuation-stripped match. */
export const ROOM_SYNONYMS: Record<string, RoomType> = {
  'bed': 'bedroom', 'bedroom': 'bedroom', 'br': 'bedroom',
  'master': 'master_bedroom', 'master bedroom': 'master_bedroom', 'm bed': 'master_bedroom', 'm.bed': 'master_bedroom',
  'maid': 'maid_room', 'maid room': 'maid_room', 'maids': 'maid_room',
  'majlis': 'majlis', 'majles': 'majlis', 'mejlis': 'majlis',
  'living': 'living_room', 'living room': 'living_room', 'family': 'living_room', 'hall': 'living_room',
  'sitting': 'sitting_area', 'sitting area': 'sitting_area', 'lounge': 'sitting_area',
  'dining': 'dining', 'dinning': 'dining',
  'kitchen': 'kitchen', 'pantry': 'kitchen',
  'corridor': 'corridor', 'passage': 'corridor', 'lobby': 'corridor',
  'entrance': 'entrance', 'entry': 'entrance', 'foyer': 'entrance',
  'main door': 'main_door', 'main entrance': 'main_door',
  'garden': 'garden', 'landscape': 'garden', 'lawn': 'garden',
  'parking': 'parking', 'car porch': 'parking', 'car park': 'parking', 'shed': 'parking', 'garage': 'parking',
  'gate': 'gate', 'main gate': 'gate',
  'stair': 'staircase', 'staircase': 'staircase', 'stairs': 'staircase',
  'lift': 'lift', 'elevator': 'lift',
  'bath': 'bathroom', 'bathroom': 'bathroom', 'toilet': 'bathroom', 'wc': 'bathroom', 'w.c': 'bathroom',
  'store': 'store', 'storage': 'store',
  'service': 'service_area', 'service area': 'service_area', 'utility': 'service_area', 'technical': 'service_area',
  'roof': 'roof', 'terrace': 'roof',
};

export function normalizeRoomLabel(raw: string): RoomType | null {
  const k = raw.toLowerCase().replace(/[^a-z. ]/g, '').trim();
  if (ROOM_SYNONYMS[k]) return ROOM_SYNONYMS[k];
  for (const [syn, type] of Object.entries(ROOM_SYNONYMS)) {
    if (k.includes(syn)) return type;
  }
  return null;
}
