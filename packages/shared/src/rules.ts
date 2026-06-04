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

export function suggestPlacements(
  rooms: Room[], zones: Zone[], _cfg: RuleConfig = DEFAULT_RULE_CONFIG,
): Placement[] {
  const out: Placement[] = [];
  const byType = (t: string) => rooms.filter((r) => r.type === t);
  const bb = bbox(rooms);
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

  // ── Gate motor + outdoor intercom bell ──
  for (const gz of gateZones) {
    const [cx, cy] = gz.geometry.coords[0];
    out.push(place('GATE_MOTOR', cx, cy, 'Main gate motor', 0.86, 0, {}, 'zone'));
    out.push(place('INTERCOM_BELL', cx + 0.02, cy, 'Outdoor intercom at gate / pedestrian door', 0.82, 0, {}, 'zone'));
  }

  // ── Smart lock ──
  const primary = [...byType('main_entrance'), ...byType('main_door'), ...byType('entrance')][0];
  if (primary) out.push(place('SMART_LOCK', primary.centroid[0], primary.centroid[1], 'Smart lock at main entrance', 0.84));

  // ── Intercom screens (kitchen / pantry / maid / main living / per-floor stair) ──
  for (const k of byType('kitchen')) out.push(place('INTERCOM_SCREEN', k.centroid[0], k.centroid[1], `Service intercom screen — ${k.label ?? 'kitchen'}`, 0.8, 0, { mountHeight: 1.4 }));
  for (const p of byType('pantry')) out.push(place('INTERCOM_SCREEN', p.centroid[0], p.centroid[1], 'Intercom screen — pantry', 0.74, 0, { mountHeight: 1.4 }));
  for (const m of byType('maid_room')) out.push(place('INTERCOM_SCREEN', m.centroid[0], m.centroid[1], 'Intercom screen — maid room', 0.78, 0, { mountHeight: 1.4 }));
  const mainLiving = largest(rooms, ['majlis', 'living_room']);
  if (mainLiving) out.push(place('INTERCOM_SCREEN', mainLiving.centroid[0] + 0.02, mainLiving.centroid[1], `Main intercom screen — ${mainLiving.label ?? 'living'}`, 0.8, 0, { mountHeight: 1.4 }));
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
  if (rackRoom) {
    const [x, y] = rackRoom.centroid;
    out.push(place('ELV_RACK', x, y, `ELV rack — ${why} (not on a column)`, 0.82));
    out.push(place('SWITCH', x + 0.012, y, 'Core network switch in rack', 0.8));
    out.push(place('NVR', x - 0.012, y, 'NVR in rack', 0.8));
  }

  // ── Wi-Fi APs ──
  const majlis = byType('majlis'); const dining = byType('dining'); const living = byType('living_room');
  if (majlis.length && dining.length) {
    const [mx, my] = majlis[0].centroid; const [dx, dy] = dining[0].centroid;
    out.push(place('WIFI_AP', (mx + dx) / 2, (my + dy) / 2, 'Ceiling Wi-Fi AP — guest lobby (Majlis↔Dining)', 0.76, 0, { coverageRadius: 12 }));
  } else if (majlis.length) {
    const { pt, note } = ceilingPoint(majlis[0], rooms);
    out.push(place('WIFI_AP', pt[0], pt[1], `Ceiling Wi-Fi AP — Majlis${note}`, 0.74, 0, { coverageRadius: 12 }));
  }
  if (living.length) {
    const big = largest(living, ['living_room'])!; const { pt, note } = ceilingPoint(big, rooms);
    out.push(place('WIFI_AP', pt[0], pt[1], `Ceiling Wi-Fi AP — main living (covers outdoor)${note}`, 0.74, 0, { coverageRadius: 12 }));
  }
  const svc = byType('service_area').length ? byType('service_area') : byType('kitchen');
  if (svc.length) out.push(place('WIFI_AP', svc[0].centroid[0], svc[0].centroid[1], 'Ceiling Wi-Fi AP — service area (kitchen + maid)', 0.72, 0, { coverageRadius: 10 }));
  if (byType('master_bedroom')[0]) {
    const { pt, note } = ceilingPoint(byType('master_bedroom')[0], rooms);
    out.push(place('WIFI_AP', pt[0], pt[1], `Ceiling Wi-Fi AP — master suite (bedroom + dressing)${note}`, 0.72, 0, { coverageRadius: 10 }));
  }
  const beds = byType('bedroom');
  for (let i = 0; i < beds.length; i += 2) {
    const grp = beds.slice(i, i + 2);
    const cx = grp.reduce((s, b) => s + b.centroid[0], 0) / grp.length;
    const cy = grp.reduce((s, b) => s + b.centroid[1], 0) / grp.length;
    out.push(place('WIFI_AP', cx, cy, 'Ceiling Wi-Fi AP — bedrooms wing', 0.7, 0, { coverageRadius: 10 }));
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

  // ── Motion sensors (circulation + dressing + wet rooms) ──
  for (const r of [...byType('corridor'), ...byType('staircase'), ...byType('bathroom'), ...byType('dressing'),
    ...byType('entrance'), ...byType('main_entrance'), ...byType('lift')]) {
    const b = roomBox(r); const big = r.type === 'corridor' && (r.area >= HALL_AREA || aspect(r) >= LONG_CORRIDOR_ASPECT);
    if (big) {
      out.push(place('SENSOR', b.x0 + (b.x1 - b.x0) * 0.3, b.y0 + (b.y1 - b.y0) * 0.3, `Motion sensor — ${r.label ?? r.type}`, 0.72, 0, { kind: 'motion' }));
      out.push(place('SENSOR', b.x0 + (b.x1 - b.x0) * 0.7, b.y0 + (b.y1 - b.y0) * 0.7, `Motion sensor — ${r.label ?? r.type}`, 0.72, 0, { kind: 'motion' }));
    } else {
      out.push(place('SENSOR', r.centroid[0], r.centroid[1], `Motion sensor — ${r.label ?? r.type}`, 0.72, 0, { kind: 'motion' }));
    }
  }

  // ── Thermostats ──
  for (const r of [...byType('master_bedroom'), ...byType('living_room'), ...byType('majlis'), ...byType('bedroom')].slice(0, 6)) {
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

  return out.map((p, i) => ({ ...p, zIndex: i }));
}
