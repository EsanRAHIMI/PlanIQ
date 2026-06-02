/**
 * Conservative device-placement rule engine (mirror of services/ai/app/rules/engine.py).
 */
import type { Room, Zone, Placement, RuleConfig } from './types';
import { DEFAULT_RULE_CONFIG } from './types';

let _seq = 0;
const uid = () => `ai_${Date.now().toString(36)}_${(_seq++).toString(36)}`;

function place(
  deviceCode: string, x: number, y: number, rationale: string,
  confidence = 0.7, rotation = 0, props: Record<string, unknown> = {},
): Placement {
  return {
    id: uid(), deviceCode, position: { x, y }, rotation, scale: 1,
    locked: false, hidden: false, source: 'ai', reviewed: false,
    rationale, confidence, props, zIndex: 0,
  };
}

function buildingBBox(rooms: Room[]) {
  if (!rooms.length) return null;
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const r of rooms) for (const [x, y] of r.polygon) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

function largest(rooms: Room[], types: string[]): Room | undefined {
  return rooms.filter((r) => types.includes(r.type)).sort((a, b) => b.area - a.area)[0];
}

export function suggestPlacements(
  rooms: Room[], zones: Zone[], _cfg: RuleConfig = DEFAULT_RULE_CONFIG,
): Placement[] {
  const out: Placement[] = [];
  const byType = (t: string) => rooms.filter((r) => r.type === t);
  const bbox = buildingBBox(rooms);

  if (bbox && _cfg.cctvPerBuildingCorner) {
    const ins = 0.012;
    const corners: [number, number, number, string][] = [
      [bbox.x0 + ins, bbox.y0 + ins, 135, 'NW external corner — perimeter CCTV'],
      [bbox.x1 - ins, bbox.y0 + ins, 225, 'NE external corner — perimeter CCTV'],
      [bbox.x1 - ins, bbox.y1 - ins, 315, 'SE external corner — perimeter CCTV'],
      [bbox.x0 + ins, bbox.y1 - ins, 45, 'SW external corner — perimeter CCTV'],
    ];
    for (const [x, y, rot, why] of corners) out.push(place('CCTV', x, y, why, 0.78, rot));
  }

  for (const z of zones) {
    const [cx, cy] = z.geometry.coords[0] ?? [0.5, 0.95];
    if (z.type === 'gate') {
      out.push(place('CCTV', cx, cy - 0.03, 'Gate overview CCTV', 0.8));
      out.push(place('GATE_MOTOR', cx, cy, 'Main gate motor', 0.86));
      out.push(place('INTERCOM_BELL', cx + 0.03, cy, 'Gate intercom call point', 0.82));
    }
    if (z.type === 'parking') out.push(place('CCTV', cx, cy, 'Parking area CCTV', 0.76));
  }

  const corridors = byType('corridor');
  if (corridors.length) {
    const c = corridors.sort((a, b) => b.area - a.area)[0];
    out.push(place('CCTV', c.centroid[0], c.centroid[1], `Main corridor CCTV — ${c.label}`, 0.72));
  }

  const entrances = [...byType('main_door'), ...byType('entrance')];
  if (entrances.length) {
    const [x, y] = entrances[0].centroid;
    out.push(place('SMART_LOCK', x, y, 'Smart lock at main entrance', 0.84));
    out.push(place('INTERCOM_SCREEN', x + 0.02, y, 'Indoor intercom at entrance', 0.8, 0, { mountHeight: 1.4 }));
    out.push(place('SENSOR', x, y, 'Entry motion sensor', 0.72, 0, { kind: 'motion' }));
  }

  const wifiRooms = rooms
    .filter((r) => ['living_room', 'majlis', 'sitting_area'].includes(r.type))
    .sort((a, b) => b.area - a.area)
    .slice(0, 2);
  for (const r of wifiRooms) {
    out.push(place('WIFI_AP', r.centroid[0], r.centroid[1], `Central Wi-Fi AP — ${r.label}`, 0.74, 0, { coverageRadius: 12 }));
  }

  const rack = byType('service_area')[0];
  if (rack) {
    const [x, y] = rack.centroid;
    out.push(place('ELV_RACK', x, y, `ELV rack — ${rack.label}`, 0.78));
    out.push(place('SWITCH', x + 0.01, y, 'Core network switch', 0.76));
    out.push(place('NVR', x - 0.01, y, 'NVR with rack', 0.76));
  }

  for (const r of rooms
    .filter((r) => ['master_bedroom', 'living_room', 'majlis'].includes(r.type))
    .sort((a, b) => b.area - a.area)
    .slice(0, 3)) {
    out.push(place('THERMOSTAT', r.centroid[0], r.centroid[1] + 0.04, `Thermostat — ${r.label}`, 0.74, 0, { mountHeight: 1.4 }));
  }

  const ent = largest(rooms, ['majlis', 'living_room']);
  if (ent) {
    const [cx, cy] = ent.centroid;
    out.push(place('SPEAKER', cx - 0.04, cy, `Ceiling speaker (L) — ${ent.label}`, 0.7));
    out.push(place('SPEAKER', cx + 0.04, cy, `Ceiling speaker (R) — ${ent.label}`, 0.7));
    out.push(place('VOLUME_CONTROL', cx, cy + 0.05, `Volume control — ${ent.label}`, 0.68, 0, { mountHeight: 1.3 }));
  }

  const projRoom = byType('majlis')[0] ?? largest(rooms, ['living_room']);
  if (projRoom) {
    const [cx, cy] = projRoom.centroid;
    out.push(place('PROJECTOR', cx, cy, `Projector — ${projRoom.label}`, 0.66, 0, { mountHeight: 2.8 }));
    out.push(place('SCREEN', cx, cy - 0.06, `Screen — ${projRoom.label}`, 0.66));
  }

  for (const r of rooms
    .filter((r) => ['master_bedroom', 'living_room', 'majlis'].includes(r.type))
    .sort((a, b) => b.area - a.area)
    .slice(0, 2)) {
    const top = Math.min(...r.polygon.map((p) => p[1])) + 0.005;
    out.push(place('CURTAIN_MOTOR', r.centroid[0], top, `Curtain motor — ${r.label}`, 0.65));
  }

  for (const r of [...byType('corridor'), ...byType('staircase'), ...byType('entrance')].slice(0, 2)) {
    out.push(place('SENSOR', r.centroid[0], r.centroid[1], `Motion sensor — ${r.label}`, 0.7, 0, { kind: 'motion' }));
  }

  for (const r of [...byType('entrance'), ...byType('main_door'), ...byType('corridor')].slice(0, 2)) {
    out.push(place('LIGHT_SWITCH', r.centroid[0] + 0.02, r.centroid[1] + 0.02, `Switch by door — ${r.label}`, 0.68, 0, { mountHeight: 1.3 }));
  }
  for (const r of rooms
    .filter((r) => ['living_room', 'majlis', 'master_bedroom'].includes(r.type))
    .sort((a, b) => b.area - a.area)
    .slice(0, 3)) {
    out.push(place('LIGHT_SWITCH', r.centroid[0] + 0.02, r.centroid[1] + 0.02, `Room lighting — ${r.label}`, 0.67, 0, { mountHeight: 1.3 }));
  }

  for (const r of rooms
    .filter((r) => ['living_room', 'majlis', 'master_bedroom'].includes(r.type))
    .sort((a, b) => b.area - a.area)
    .slice(0, 3)) {
    out.push(place('DATA_SOCKET', r.centroid[0] - 0.03, r.centroid[1] + 0.03, `Data point — ${r.label}`, 0.68));
  }

  return out.map((p, i) => ({ ...p, zIndex: i }));
}
