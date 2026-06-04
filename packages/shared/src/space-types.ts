/** Canonical functional space types detected on plans. */
export const ROOM_TYPES = [
  // living / sleeping
  'bedroom', 'master_bedroom', 'maid_room', 'majlis', 'living_room',
  'sitting_area', 'dining', 'dressing',
  // wet / service
  'kitchen', 'pantry', 'laundry', 'bathroom', 'store', 'store_indoor', 'store_outdoor',
  'service_area', 'electrical_room',
  // circulation / access
  'corridor', 'staircase', 'lift',
  'entrance', 'main_entrance', 'guest_entrance', 'service_entrance', 'main_door',
  // outdoor
  'outdoor', 'garden', 'parking', 'gate', 'pool', 'bbq', 'outdoor_seating', 'roof',
] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

export const ZONE_TYPES = [
  'gate', 'parking', 'garden', 'driveway', 'entrance', 'wall',
  'staircase', 'lift', 'outdoor',
  // manual / inferred annotations
  'street', 'column', 'door', 'double_height',
] as const;
export type ZoneType = (typeof ZONE_TYPES)[number];

/**
 * OCR/label synonyms → canonical room type. Keys are matched after lowercasing and
 * collapsing punctuation; Arabic script is preserved (Gulf villa plans are bilingual).
 * Longer keys are tried first so "master bedroom" wins over "bedroom".
 */
export const ROOM_SYNONYMS: Record<string, RoomType> = {
  // ── bedrooms ──
  'master bedroom': 'master_bedroom', 'master bed': 'master_bedroom', 'm.bed': 'master_bedroom',
  'm bedroom': 'master_bedroom', 'mbr': 'master_bedroom', 'master': 'master_bedroom',
  'غرفة رئيسية': 'master_bedroom', 'غرفة ماستر': 'master_bedroom', 'النوم الرئيسية': 'master_bedroom',
  'bedroom': 'bedroom', 'bed room': 'bedroom', 'bed': 'bedroom', 'br': 'bedroom',
  'غرفة نوم': 'bedroom', 'نوم': 'bedroom', 'غرفة': 'bedroom',
  // ── maid ──
  'maid room': 'maid_room', 'maids room': 'maid_room', 'maid': 'maid_room', 'servant': 'maid_room',
  'غرفة خادمة': 'maid_room', 'خادمة': 'maid_room', 'الخدم': 'maid_room',
  // ── majlis / living ──
  'majlis': 'majlis', 'majles': 'majlis', 'mejlis': 'majlis', 'men majlis': 'majlis', 'guest majlis': 'majlis',
  'مجلس': 'majlis', 'مجلس رجال': 'majlis',
  'living room': 'living_room', 'living': 'living_room', 'family living': 'living_room', 'family': 'living_room',
  'معيشة': 'living_room', 'صالة معيشة': 'living_room', 'صالة': 'living_room', 'جلوس عائلي': 'living_room',
  'sitting area': 'sitting_area', 'sitting': 'sitting_area', 'lounge': 'sitting_area',
  'جلوس': 'sitting_area',
  // ── dining ──
  'dining room': 'dining', 'dining': 'dining', 'dinning': 'dining',
  'غرفة طعام': 'dining', 'طعام': 'dining', 'سفرة': 'dining',
  // ── dressing ──
  'dressing room': 'dressing', 'dressing': 'dressing', 'walk in closet': 'dressing', 'walkin': 'dressing',
  'wardrobe': 'dressing', 'closet': 'dressing',
  'غرفة ملابس': 'dressing', 'ملابس': 'dressing', 'دريسنج': 'dressing',
  // ── kitchen / pantry / laundry ──
  'kitchen': 'kitchen', 'main kitchen': 'kitchen', 'wet kitchen': 'kitchen', 'dry kitchen': 'kitchen',
  'مطبخ': 'kitchen', 'المطبخ': 'kitchen',
  'pantry': 'pantry', 'preparation': 'pantry', 'prep': 'pantry', 'coffee corner': 'pantry', 'بانتري': 'pantry', 'تحضير': 'pantry',
  'laundry': 'laundry', 'washing': 'laundry', 'مغسلة': 'laundry', 'غسيل': 'laundry',
  // ── bathroom ──
  'bathroom': 'bathroom', 'bath': 'bathroom', 'toilet': 'bathroom', 'wc': 'bathroom', 'w.c': 'bathroom', 'powder': 'bathroom',
  'حمام': 'bathroom', 'دورة مياه': 'bathroom', 'دورةمياه': 'bathroom', 'مرحاض': 'bathroom',
  // ── store / electrical / service ──
  'indoor store': 'store_indoor', 'inside store': 'store_indoor',
  'outdoor store': 'store_outdoor', 'outside store': 'store_outdoor', 'external store': 'store_outdoor',
  'store': 'store', 'storage': 'store', 'مخزن': 'store',
  'electrical room': 'electrical_room', 'electric room': 'electrical_room', 'elec room': 'electrical_room',
  'db room': 'electrical_room', 'mdb': 'electrical_room', 'db': 'electrical_room', 'electrical': 'electrical_room',
  'غرفة كهرباء': 'electrical_room', 'كهرباء': 'electrical_room', 'لوحة كهرباء': 'electrical_room',
  'service area': 'service_area', 'service': 'service_area', 'utility': 'service_area', 'technical': 'service_area',
  'خدمة': 'service_area', 'خدمات': 'service_area',
  // ── circulation ──
  'corridor': 'corridor', 'passage': 'corridor', 'lobby': 'corridor', 'hallway': 'corridor', 'foyer': 'corridor',
  'ممر': 'corridor', 'ردهة': 'corridor',
  'staircase': 'staircase', 'stairs': 'staircase', 'stair': 'staircase', 'درج': 'staircase', 'سلم': 'staircase',
  'lift': 'lift', 'elevator': 'lift', 'مصعد': 'lift',
  // ── entrances ──
  'main entrance': 'main_entrance', 'main door': 'main_door', 'main entry': 'main_entrance',
  'مدخل رئيسي': 'main_entrance', 'المدخل الرئيسي': 'main_entrance',
  'guest entrance': 'guest_entrance', 'guest entry': 'guest_entrance', 'مدخل ضيوف': 'guest_entrance',
  'service entrance': 'service_entrance', 'service entry': 'service_entrance', 'مدخل خدمة': 'service_entrance',
  'entrance': 'entrance', 'entry': 'entrance', 'مدخل': 'entrance',
  // ── outdoor ──
  'swimming pool': 'pool', 'pool': 'pool', 'مسبح': 'pool', 'حوض سباحة': 'pool',
  'bbq': 'bbq', 'barbeque': 'bbq', 'barbecue': 'bbq', 'شواء': 'bbq',
  'outdoor seating': 'outdoor_seating', 'seating area': 'outdoor_seating', 'sitting outdoor': 'outdoor_seating', 'gazebo': 'outdoor_seating',
  'garden': 'garden', 'landscape': 'garden', 'lawn': 'garden', 'yard': 'garden', 'حديقة': 'garden',
  'parking': 'parking', 'car porch': 'parking', 'car park': 'parking', 'garage': 'parking', 'shed': 'parking',
  'مواقف': 'parking', 'موقف': 'parking', 'كراج': 'parking',
  'gate': 'gate', 'main gate': 'gate', 'بوابة': 'gate',
  'roof': 'roof', 'terrace': 'roof', 'سطح': 'roof',
  'outdoor': 'outdoor', 'external': 'outdoor',
};

// Synonym keys ordered longest-first so the most specific label wins.
const SYNONYM_KEYS = Object.keys(ROOM_SYNONYMS).sort((a, b) => b.length - a.length);

/** Normalize a raw label: lowercase, keep Latin + Arabic letters/digits, collapse the rest to spaces. */
export function normalizeLabelText(raw: string): string {
  return (raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Levenshtein distance (small strings) — tolerates OCR noise for one-token labels. */
function editDistance(a: string, b: string): number {
  const m = a.length; const n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0]; dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1]);
      prev = tmp;
    }
  }
  return dp[m];
}

export interface LabelMatch { type: RoomType; score: number; matched: string }

/**
 * Classify a label with a confidence score reflecting HOW it matched:
 *  exact key 0.95 · whole-word 0.88 · substring 0.78 · fuzzy(token, edit≤1) 0.62.
 * Returns null when nothing plausible matches.
 */
export function classifyLabel(raw: string): LabelMatch | null {
  const k = normalizeLabelText(raw);
  if (!k) return null;
  if (ROOM_SYNONYMS[k]) return { type: ROOM_SYNONYMS[k], score: 0.95, matched: k };
  const kc = k.replace(/ /g, '');
  if (kc !== k && ROOM_SYNONYMS[kc]) return { type: ROOM_SYNONYMS[kc], score: 0.9, matched: kc }; // "w c" → "wc"

  const words = new Set(k.split(' '));
  // whole-word, then substring (longest synonym first)
  for (const syn of SYNONYM_KEYS) {
    if (!syn.includes(' ') && words.has(syn)) return { type: ROOM_SYNONYMS[syn], score: 0.88, matched: syn };
  }
  for (const syn of SYNONYM_KEYS) {
    if (k.includes(syn)) return { type: ROOM_SYNONYMS[syn], score: syn.length >= 4 ? 0.78 : 0.7, matched: syn };
  }
  // fuzzy on single tokens (handles OCR typos like "kithen", "majlas")
  for (const w of words) {
    if (w.length < 4) continue;
    for (const syn of SYNONYM_KEYS) {
      if (syn.includes(' ') || syn.length < 4) continue;
      if (editDistance(w, syn) <= 1) return { type: ROOM_SYNONYMS[syn], score: 0.62, matched: syn };
    }
  }
  return null;
}

/** Back-compat: type only. */
export function normalizeRoomLabel(raw: string): RoomType | null {
  return classifyLabel(raw)?.type ?? null;
}
