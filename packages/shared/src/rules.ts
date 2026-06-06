/**
 * Device-placement rule engine — encodes the customer's ELV/smart-home engineering rules.
 * Mirror of services/ai/app/rules/engine.py (keep both in sync).
 * Placements carry meta.basis (room|zone|perimeter) so QC can reconcile counts.
 * See docs/RULES-MAPPING.md for the rule→logic mapping and geometry gaps.
 */
import type { Room, Zone, Placement, RuleConfig } from './types';
import { DEFAULT_RULE_CONFIG } from './types';

let _seq = 0;
const uid = () => `ai_${Date.now().toString(36)}_${(_seq++).toString(36)}`;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const LONG_CORRIDOR_ASPECT = 3.0;
const HALL_AREA = 0.06;

function place(
  deviceCode: string, x: number, y: number, rationale: string,
  confidence = 0.7, rotation = 0, props: Record<string, unknown> = {}, basis = 'room',
): Placement {
  return {
    id: uid(), deviceCode, position: { x: clamp01(x), y: clamp01(y) }, rotation, scale: 1,
    locked: false, hidden: false, source: 'ai', reviewed: false,
    rationale, confidence, props, zIndex: 0, meta: { basis },
  };
}

function bbox(rooms: Room[]) {
  if (!rooms.length) return null;
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const r of rooms) for (const [x, y] of r.polygon) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}
function roomBox(r: Room) {
  const xs = r.polygon.map((p) => p[0]); const ys = r.polygon.map((p) => p[1]);
  return { x0: Math.min(...xs, r.centroid[0]), y0: Math.min(...ys, r.centroid[1]), x1: Math.max(...xs, r.centroid[0]), y1: Math.max(...ys, r.centroid[1]) };
}
function aspect(r: Room) {
  const b = roomBox(r); const w = Math.max(1e-6, b.x1 - b.x0); const h = Math.max(1e-6, b.y1 - b.y0);
  return Math.max(w, h) / Math.min(w, h);
}
function largest(rooms: Room[], types: string[]): Room | undefined {
  return rooms.filter((r) => types.includes(r.type)).sort((a, b) => b.area - a.area)[0];
}
const isDouble = (r: Room) => Boolean((r as any).meta?.doubleHeight);
function nearestNormal(room: Room, rooms: Room[]): Room | undefined {
  let best: Room | undefined; let bd = Infinity;
  for (const r of rooms) {
    if (r === room || isDouble(r)) continue;
    const d = (r.centroid[0] - room.centroid[0]) ** 2 + (r.centroid[1] - room.centroid[1]) ** 2;
    if (d < bd) { bd = d; best = r; }
  }
  return best;
}
function ceilingPoint(room: Room, rooms: Room[]): { pt: [number, number]; note: string } {
  if (isDouble(room)) {
    const alt = nearestNormal(room, rooms);
    if (alt) return { pt: alt.centroid, note: ` (relocated from double-height ${room.label ?? room.type})` };
  }
  return { pt: room.centroid, note: '' };
}

/** Learned-prior + floor-type options for the closed learning loop. Priors NUDGE confidence
 *  and floor-type policy SUPPRESSES devices engineers never place on a floor; the rules +
 *  customer logic still decide WHAT is placed. Mirrors services/ai/app/rules/priors.py. */
export interface SuggestOptions {
  priors?: { perSpace?: Record<string, Record<string, { rate?: number }>> };
  floorType?: string;
  detectorActive?: boolean;   // YOLO detector weight on only when a model is in production
}
const NO_INTERIOR_FLOORS = new Set(['roof']);

// Indoor rooms needing ceiling coverage (Wi-Fi AP + occupancy sensor) regardless of the
// type-specific rules — the main recall lever (calibrated to engineer layouts).
const COVERAGE_TYPES = new Set(['bedroom', 'master_bedroom', 'maid_room', 'majlis', 'living_room',
  'sitting_area', 'dining', 'kitchen', 'pantry', 'dressing', 'study', 'office', 'family_room']);
const INTERIOR_FLOORS = new Set(['ground', 'first', 'second', 'third', 'basement', 'mezzanine', '', 'unknown']);
const COVERAGE_MIN_AREA = 0.015;

/** Indoor rooms needing coverage: typed indoor rooms PLUS sufficiently large unclassified
 *  rooms on interior floors (the recall fix for untyped-but-real rooms). */
function coverageRooms(rooms: Room[], floorType?: string): Room[] {
  const interior = INTERIOR_FLOORS.has((floorType ?? '').toLowerCase());
  return rooms.filter((r) => COVERAGE_TYPES.has(r.type)
    || (r.type === 'unclassified' && interior && (r.area ?? 0) >= COVERAGE_MIN_AREA));
}

export function suggestPlacements(
  rooms: Room[], zones: Zone[], _cfg: RuleConfig = DEFAULT_RULE_CONFIG, opts: SuggestOptions = {},
): Placement[] {
  const out: Placement[] = [];
  // Floor-type policy (learned: engineers place no interior devices on roofs).
  const noInterior = NO_INTERIOR_FLOORS.has((opts.floorType ?? '').toLowerCase());
  if (noInterior && zones.length === 0) return [];
  if (noInterior) rooms = [];
  const byType = (t: string) => (noInterior ? [] : rooms.filter((r) => r.type === t));
  const bb = noInterior ? null : bbox(rooms);
  const gateZones = zones.filter((z) => z.type === 'gate');
  const parkingZones = zones.filter((z) => z.type === 'parking');
  const gardenZones = zones.filter((z) => z.type === 'garden');
  const streetZones = zones.filter((z) => z.type === 'street');

  // ── CCTV ──
  if (bb) {
    const ins = 0.012;
    const gpt = streetZones[0]?.geometry.coords[0] ?? gateZones[0]?.geometry.coords[0];
    let side = 'front';
    if (gpt) {
      const [gx, gy] = gpt;
      const d: Record<string, number> = { bottom: Math.abs(gy - bb.y1), top: Math.abs(gy - bb.y0), left: Math.abs(gx - bb.x0), right: Math.abs(gx - bb.x1) };
      side = Object.keys(d).reduce((a, b) => (d[b] < d[a] ? b : a));
    }
    let pts: [number, number, number][];
    if (side === 'bottom' || side === 'front') pts = [[bb.x0 + ins, bb.y1 - ins, 45], [bb.x1 - ins, bb.y1 - ins, 315]];
    else if (side === 'top') pts = [[bb.x0 + ins, bb.y0 + ins, 135], [bb.x1 - ins, bb.y0 + ins, 225]];
    else if (side === 'left') pts = [[bb.x0 + ins, bb.y0 + ins, 135], [bb.x0 + ins, bb.y1 - ins, 45]];
    else pts = [[bb.x1 - ins, bb.y0 + ins, 225], [bb.x1 - ins, bb.y1 - ins, 315]];
    for (const [x, y, rot] of pts) out.push(place('CCTV', x, y, 'Perimeter CCTV — street-facing wall end', 0.8, rot, {}, 'perimeter'));
  }
  const entrances = [...byType('main_entrance'), ...byType('main_door'), ...byType('guest_entrance'),
    ...byType('service_entrance'), ...byType('entrance')];
  for (const e of entrances.slice(0, 5)) {
    out.push(place('CCTV', e.centroid[0], e.centroid[1], `Entrance CCTV — covers ${e.label ?? 'door'} and approach`, 0.76));
  }
  for (const pz of parkingZones.slice(0, 2)) {
    const [cx, cy] = pz.geometry.coords[0]; out.push(place('CCTV', cx, cy, 'Parking area CCTV', 0.76, 0, {}, 'zone'));
  }
  for (const pr of byType('parking').slice(0, 2)) out.push(place('CCTV', pr.centroid[0], pr.centroid[1], 'Parking area CCTV', 0.74));
  if (gardenZones.length || byType('garden').length) {
    const g = byType('garden')[0];
    if (g) out.push(place('CCTV', g.centroid[0], g.centroid[1], 'General yard-view CCTV', 0.72));
    else { const [cx, cy] = gardenZones[0].geometry.coords[0]; out.push(place('CCTV', cx, cy, 'General yard-view CCTV', 0.72, 0, {}, 'zone')); }
  }
  for (const f of [...byType('pool'), ...byType('bbq'), ...byType('outdoor_seating')]) {
    out.push(place('CCTV', f.centroid[0], f.centroid[1], `Outdoor-facility CCTV — ${f.label ?? f.type}`, 0.72));
  }
  for (const k of [...byType('kitchen'), ...byType('laundry')]) out.push(place('CCTV', k.centroid[0], k.centroid[1], `CCTV — ${k.label ?? k.type}`, 0.72));

  // ── Gate motor + outdoor intercom bell + smart lock at the vehicular entrance ──
  // Every villa has these at the gate. Prefer an explicit gate marker; else fall back to
  // the detected parking/driveway as the access point (site plans rarely label the gate),
  // with an "approximate — verify at gate" note so the engineer confirms the position.
  type AccessPt = { x: number; y: number; basis: 'zone' | 'room'; approx: boolean };
  const accessPts: AccessPt[] = [];
  for (const gz of gateZones) accessPts.push({ x: gz.geometry.coords[0][0], y: gz.geometry.coords[0][1], basis: 'zone', approx: false });
  if (accessPts.length === 0) {
    for (const pz of parkingZones.slice(0, 1)) accessPts.push({ x: pz.geometry.coords[0][0], y: pz.geometry.coords[0][1], basis: 'zone', approx: true });
    for (const pr of byType('parking').slice(0, 1)) accessPts.push({ x: pr.centroid[0], y: pr.centroid[1], basis: 'room', approx: true });
  }
  // Every villa has a gate motor + outdoor intercom + smart lock; if nothing was detected,
  // still place them on the SITE/GROUND sheet at the front perimeter (recall lever; position
  // is approximate). Project reconcile keeps one set per project.
  const ftl = (opts.floorType ?? '').toLowerCase();
  if (accessPts.length === 0 && (ftl === 'site' || ftl === 'ground')) {
    if (bb) accessPts.push({ x: (bb.x0 + bb.x1) / 2, y: bb.y1, basis: 'room', approx: true });
    else accessPts.push({ x: 0.5, y: 0.95, basis: 'room', approx: true });
  }
  const acc = accessPts[0];
  if (acc) {
    const note = acc.approx ? ' (approximate — verify at gate)' : '';
    out.push(place('GATE_MOTOR', acc.x, acc.y, `Main gate motor${note}`, acc.approx ? 0.7 : 0.86, 0, {}, acc.basis));
    out.push(place('INTERCOM_BELL', acc.x + 0.02, acc.y, `Outdoor intercom at gate / pedestrian door${note}`, acc.approx ? 0.68 : 0.82, 0, {}, acc.basis));
  }

  // ── Smart lock at primary entrance (fallback: vehicular entrance) ──
  const primary = [...byType('main_entrance'), ...byType('main_door'), ...byType('entrance')][0];
  if (primary) out.push(place('SMART_LOCK', primary.centroid[0], primary.centroid[1], 'Smart lock at main entrance', 0.84));
  else if (acc) out.push(place('SMART_LOCK', acc.x, acc.y, 'Smart lock at main entrance (approximate — verify)', 0.68, 0, {}, acc.basis));

  // ── Intercom screens (kitchen / pantry / maid / main living / per-floor stair) ──
  for (const k of byType('kitchen')) out.push(place('INTERCOM_SCREEN', k.centroid[0], k.centroid[1], `Service intercom screen — ${k.label ?? 'kitchen'}`, 0.8, 0, { mountHeight: 1.4 }));
  for (const p of byType('pantry')) out.push(place('INTERCOM_SCREEN', p.centroid[0], p.centroid[1], 'Intercom screen — pantry', 0.74, 0, { mountHeight: 1.4 }));
  for (const m of byType('maid_room')) out.push(place('INTERCOM_SCREEN', m.centroid[0], m.centroid[1], 'Intercom screen — maid room', 0.78, 0, { mountHeight: 1.4 }));
  // Intercom screen in each main living/reception room (priors: living 0.45, majlis), not
  // only the single largest — boosts intercom recall.
  for (const r of [...byType('majlis'), ...byType('living_room')]) {
    out.push(place('INTERCOM_SCREEN', r.centroid[0] + 0.02, r.centroid[1], `Intercom screen — ${r.label ?? r.type}`, 0.78, 0, { mountHeight: 1.4 }));
  }
  for (const s of byType('staircase').slice(0, 1)) out.push(place('INTERCOM_SCREEN', s.centroid[0], s.centroid[1], 'Floor intercom screen — near staircase', 0.74, 0, { mountHeight: 1.4 }));

  // ── ELV rack priority chain: staircase → service → electrical/DB → indoor store →
  //    store → entrance. Outdoor stores never used. ──
  let rackRoom: Room | undefined; let why = '';
  if (byType('staircase')[0]) { rackRoom = byType('staircase')[0]; why = 'under staircase'; }
  else if (byType('service_area')[0]) { rackRoom = byType('service_area')[0]; why = 'service area'; }
  else if (byType('electrical_room')[0]) { rackRoom = byType('electrical_room')[0]; why = 'electrical/DB room'; }
  else if (byType('store_indoor')[0]) { rackRoom = byType('store_indoor')[0]; why = 'indoor store (AC)'; }
  else if (byType('store')[0]) { rackRoom = byType('store')[0]; why = 'store (verify indoor + AC)'; }
  else if ([...byType('main_entrance'), ...byType('entrance'), ...byType('main_door')][0]) { rackRoom = [...byType('main_entrance'), ...byType('entrance'), ...byType('main_door')][0]; why = 'house entrance (near main DBs)'; }
  else if (ftl === 'ground' && rooms.length) {
    // Every villa has one ELV rack; if no anchor was typed, fall back to the most central
    // ground-floor room (approximate — verify service/AC). Recall lever; reconcile keeps 1/project.
    rackRoom = rooms.reduce((b, r) => ((r.centroid[0] - 0.5) ** 2 + (r.centroid[1] - 0.5) ** 2) < ((b.centroid[0] - 0.5) ** 2 + (b.centroid[1] - 0.5) ** 2) ? r : b);
    why = 'fallback (central ground-floor room — verify service/AC room)';
  }
  if (rackRoom) {
    const [x, y] = rackRoom.centroid;
    out.push(place('ELV_RACK', x, y, `ELV rack — ${why} (not on a column)`, 0.82));
    out.push(place('SWITCH', x + 0.012, y, 'Core network switch in rack', 0.8));
    out.push(place('NVR', x - 0.012, y, 'NVR in rack', 0.8));
  }

  // ── Wi-Fi APs — one ceiling AP per indoor coverage room (engineer density). Primary recall
  //    lever: covers typed rooms AND real-but-unclassified interior rooms. ──
  const coverage = coverageRooms(rooms, opts.floorType);
  const majlis = byType('majlis'); const dining = byType('dining');
  const coveredIdx = new Set<Room>();
  if (majlis.length && dining.length) {
    const [mx, my] = majlis[0].centroid; const [dx, dy] = dining[0].centroid;
    out.push(place('WIFI_AP', (mx + dx) / 2, (my + dy) / 2, 'Ceiling Wi-Fi AP — guest lobby (Majlis↔Dining)', 0.76, 0, { coverageRadius: 12 }));
    coveredIdx.add(majlis[0]); coveredIdx.add(dining[0]);
  }
  const WIFI_MIN_AREA = 0.02;  // skip the smallest rooms (a closet/store doesn't need its own AP)
  for (const r of coverage) {
    if (coveredIdx.has(r) || (r.area ?? 0) < WIFI_MIN_AREA) continue;
    const { pt, note } = ceilingPoint(r, rooms);
    out.push(place('WIFI_AP', pt[0], pt[1], `Ceiling Wi-Fi AP — ${r.label ?? r.type}${note}`, 0.72, 0, { coverageRadius: 11 }));
  }
  for (const c of byType('corridor')) {
    if (aspect(c) >= LONG_CORRIDOR_ASPECT) out.push(place('WIFI_AP', c.centroid[0], c.centroid[1], 'Ceiling Wi-Fi AP — long corridor', 0.68, 0, { coverageRadius: 10 }));
  }

  // ── Speakers + volume ──
  const entRooms = [...byType('majlis'), ...byType('living_room'), ...byType('dining'), ...byType('sitting_area'),
    ...byType('corridor').filter((c) => c.area >= HALL_AREA)];
  for (const r of entRooms) {
    const { pt, note } = ceilingPoint(r, rooms); const [cx, cy] = pt; const label = r.label ?? r.type;
    out.push(place('SPEAKER', cx - 0.035, cy, `Ceiling speaker L — ${label}${note}`, 0.74));
    out.push(place('SPEAKER', cx + 0.035, cy, `Ceiling speaker R — ${label}${note}`, 0.74));
    out.push(place('VOLUME_CONTROL', cx, cy + 0.05, `Volume control (near switches) — ${label}`, 0.7, 0, { mountHeight: 1.3 }));
  }
  // Engineers also fit a ceiling speaker in circulation corridors (priors: corridor 0.57).
  for (const c of byType('corridor')) {
    if (c.area >= HALL_AREA) continue;     // wide halls already handled above
    out.push(place('SPEAKER', c.centroid[0], c.centroid[1], `Ceiling speaker — ${c.label ?? 'corridor'}`, 0.7));
  }

  // ── Motion / occupancy sensors — engineers sensor bedrooms + main living/reception
  //    (priors: bedroom 0.92, majlis/living high) + circulation, NOT every room. ──
  const SENSOR_MIN_AREA = 0.035;
  const SENSOR_TYPES = new Set(['bedroom', 'master_bedroom', 'majlis', 'living_room', 'sitting_area']);
  const sensorRooms = rooms.filter((r) => SENSOR_TYPES.has(r.type) && (r.area ?? 0) >= SENSOR_MIN_AREA);
  for (const extra of [...byType('corridor'), ...byType('staircase'), ...byType('entrance'), ...byType('main_entrance'), ...byType('lift')]) {
    if (!sensorRooms.includes(extra)) sensorRooms.push(extra);
  }
  for (const r of sensorRooms) {
    const b = roomBox(r); const big = r.type === 'corridor' && (r.area >= HALL_AREA || aspect(r) >= LONG_CORRIDOR_ASPECT);
    if (big) {
      out.push(place('SENSOR', b.x0 + (b.x1 - b.x0) * 0.3, b.y0 + (b.y1 - b.y0) * 0.3, `Occupancy sensor — ${r.label ?? r.type}`, 0.72, 0, { kind: 'motion' }));
      out.push(place('SENSOR', b.x0 + (b.x1 - b.x0) * 0.7, b.y0 + (b.y1 - b.y0) * 0.7, `Occupancy sensor — ${r.label ?? r.type}`, 0.72, 0, { kind: 'motion' }));
    } else {
      out.push(place('SENSOR', r.centroid[0], r.centroid[1], `Occupancy sensor — ${r.label ?? r.type}`, 0.72, 0, { kind: 'motion' }));
    }
  }

  // ── Thermostats ──
  // Calibrated to engineer density (~1-2 per floor): one per main AC/living zone
  // (majlis / living / reception hall), NOT one per bedroom (which inflated counts ~5×).
  for (const r of [...byType('majlis'), ...byType('living_room')].slice(0, 3)) {
    out.push(place('THERMOSTAT', r.centroid[0], r.centroid[1] + 0.04, `Thermostat — ${r.label ?? r.type}`, 0.72, 0, { mountHeight: 1.4 }));
  }

  // ── Curtain motors ──
  for (const r of [...byType('master_bedroom'), ...byType('majlis'), ...byType('living_room')].slice(0, 4)) {
    const top = Math.min(...r.polygon.map((p) => p[1]), r.centroid[1]) + 0.005;
    out.push(place('CURTAIN_MOTOR', r.centroid[0], top, `Curtain motor — ${r.label ?? r.type}`, 0.66));
  }

  // ── Projector + screen ──
  const projRoom = byType('majlis')[0] ?? largest(rooms, ['living_room']);
  if (projRoom) {
    const [cx, cy] = projRoom.centroid;
    out.push(place('PROJECTOR', cx, cy, `Projector — ${projRoom.label ?? 'majlis'}`, 0.66, 0, { mountHeight: 2.8 }));
    out.push(place('SCREEN', cx, cy - 0.06, `Projection screen — ${projRoom.label ?? 'majlis'}`, 0.66));
  }

  // ── Light switches ──
  for (const r of [...byType('entrance'), ...byType('main_door'), ...byType('corridor')].slice(0, 4)) {
    out.push(place('LIGHT_SWITCH', r.centroid[0] + 0.02, r.centroid[1] + 0.02, `Switch by door — ${r.label ?? r.type}`, 0.68, 0, { mountHeight: 1.3 }));
  }
  for (const r of [...byType('majlis'), ...byType('living_room'), ...byType('master_bedroom'), ...byType('bedroom')].slice(0, 6)) {
    out.push(place('LIGHT_SWITCH', r.centroid[0] + 0.02, r.centroid[1] + 0.02, `Room lighting — ${r.label ?? r.type}`, 0.67, 0, { mountHeight: 1.3 }));
  }

  // ── Data sockets ──
  for (const r of [...byType('majlis'), ...byType('living_room'), ...byType('master_bedroom'), ...byType('bedroom')].slice(0, 8)) {
    out.push(place('DATA_SOCKET', r.centroid[0] - 0.03, r.centroid[1] + 0.03, `Data point — ${r.label ?? r.type}`, 0.68));
  }

  // ── Closed learning loop: nudge confidence by engineer priors (rules already decided
  //    WHAT to place; priors only weight HOW confident, upward-only so recall isn't hurt). ──
  if (opts.priors?.perSpace) applyPriorNudge(out, rooms, opts.priors.perSpace);
  return out.map((p, i) => ({ ...p, zIndex: i }));
}

function nearestRoomType(p: Placement, rooms: Room[]): string | undefined {
  let best: Room | undefined; let bd = Infinity;
  for (const r of rooms) {
    const d = (r.centroid[0] - p.position.x) ** 2 + (r.centroid[1] - p.position.y) ** 2;
    if (d < bd) { bd = d; best = r; }
  }
  return best?.type;
}

/** Upward-only confidence nudge where engineers commonly place this device in this space
 *  type (rate > 0.5). Records provenance in meta. Customer rules still decide placement. */
function applyPriorNudge(
  placements: Placement[], rooms: Room[], perSpace: Record<string, Record<string, { rate?: number }>>,
): void {
  for (const p of placements) {
    const sp = nearestRoomType(p, rooms);
    const rate = sp ? perSpace[sp]?.[p.deviceCode]?.rate : undefined;
    const meta = (p.meta ?? {}) as Record<string, unknown>;
    meta.priorSpaceType = sp ?? null;
    meta.priorRate = rate ?? null;
    meta.learnedFrom = rate != null ? 'engineer_priors' : 'rule_only';
    p.meta = meta;
    if (rate != null && rate > 0.5) p.confidence = Math.min(0.97, (p.confidence ?? 0.7) + 0.15 * (rate - 0.5));
  }
}
