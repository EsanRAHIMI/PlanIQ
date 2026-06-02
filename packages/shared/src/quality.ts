/**
 * Placement quality control (mirror of services/ai/app/rules/quality.py).
 * Filters rooms and accepts/rejects device suggestions with reasons.
 */
import type { Placement, Room, Zone, AnalysisQcSummary, QcRejection } from './types';

export type { AnalysisQcSummary, QcRejection };

export const QC_LIMITS = {
  maxRoomsPerFloor: 18,
  minRoomArea: 0.012,
  minRoomConfidence: 0.48,
  maxDevicesPerFloor: 32,
  minDeviceConfidence: 0.62,
  maxDevicesPerRoom: 3,
  perDevice: {
    CCTV: 6, WIFI_AP: 3, DATA_SOCKET: 5, LIGHT_SWITCH: 6, SENSOR: 4,
    THERMOSTAT: 3, SPEAKER: 2, VOLUME_CONTROL: 1, PROJECTOR: 1, SCREEN: 1,
    CURTAIN_MOTOR: 3, SMART_LOCK: 2, INTERCOM_SCREEN: 1, INTERCOM_BELL: 1,
    GATE_MOTOR: 1, ELV_RACK: 1, SWITCH: 1, NVR: 1,
  } as Record<string, number>,
};

const OUTDOOR = new Set(['outdoor', 'garden', 'parking', 'gate', 'roof']);
const SKIP = new Set([...OUTDOOR, 'bathroom', 'roof', 'lift', 'store']);
const WIFI = new Set(['living_room', 'majlis', 'sitting_area']);
const DATA = new Set(['living_room', 'majlis', 'master_bedroom']);
const SWITCH = new Set(['entrance', 'main_door', 'corridor', 'living_room', 'majlis', 'master_bedroom']);
const ENT = new Set(['majlis', 'living_room']);

export function spaceCategory(type: string): string {
  if (OUTDOOR.has(type)) return 'outdoor';
  if (['corridor', 'entrance', 'staircase', 'lift', 'main_door'].includes(type)) return 'circulation';
  if (['service_area', 'store', 'bathroom', 'maid_room'].includes(type)) return 'service';
  if (['living_room', 'majlis', 'master_bedroom', 'bedroom', 'dining', 'kitchen', 'sitting_area'].includes(type)) return 'indoor';
  return 'other';
}

export function filterRooms(raw: Room[]): { accepted: Room[]; rejected: Room[]; rejections: QcRejection[] } {
  const sorted = [...raw].sort((a, b) => b.area - a.area);
  const accepted: Room[] = [];
  const rejected: Room[] = [];
  const rejections: QcRejection[] = [];

  for (const r of sorted) {
    const meta = { ...(r as any).meta, spaceCategory: spaceCategory(r.type) };
    if (r.area < QC_LIMITS.minRoomArea) {
      rejected.push({ ...r, meta: { ...meta, qcStatus: 'rejected', rejectionReason: 'Area too small' } } as Room);
      rejections.push({ deviceCode: '-', reason: 'Area too small', nearSpace: r.label });
      continue;
    }
    if (r.confidence < QC_LIMITS.minRoomConfidence) {
      rejected.push({ ...r, meta: { ...meta, qcStatus: 'rejected', rejectionReason: 'Low-confidence space' } } as Room);
      rejections.push({ deviceCode: '-', reason: 'Low-confidence space', nearSpace: r.label });
      continue;
    }
    if (accepted.length >= QC_LIMITS.maxRoomsPerFloor) {
      rejected.push({ ...r, meta: { ...meta, qcStatus: 'rejected', rejectionReason: 'Max spaces per floor' } } as Room);
      rejections.push({ deviceCode: '-', reason: 'Max spaces per floor', nearSpace: r.label });
      continue;
    }
    accepted.push({ ...r, meta: { ...meta, qcStatus: 'accepted' } } as Room);
  }
  return { accepted, rejected, rejections };
}

function nearestRoom(x: number, y: number, rooms: Room[]): Room | null {
  let best: Room | null = null;
  let bestD = Infinity;
  for (const r of rooms) {
    const d = (r.centroid[0] - x) ** 2 + (r.centroid[1] - y) ** 2;
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

export function applyPlacementQc(placements: Placement[], rooms: Room[]): {
  accepted: Placement[]; rejected: Placement[]; rejections: QcRejection[];
} {
  const accepted: Placement[] = [];
  const rejected: Placement[] = [];
  const rejections: QcRejection[] = [];
  const deviceCounts: Record<string, number> = {};
  const roomCounts: Record<string, number> = {};

  const ordered = [...placements].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

  for (const p of ordered) {
    const conf = p.confidence ?? 0;
    const near = nearestRoom(p.position.x, p.position.y, rooms);
    const roomType = near?.type ?? 'unknown';
    const roomLabel = near?.label ?? roomType;
    const meta = { ...(p.meta ?? {}), spaceCategory: spaceCategory(roomType) };

    const reject = (reason: string) => {
      rejected.push({ ...p, meta: { ...meta, qcStatus: 'rejected', rejectionReason: reason }, hidden: true });
      rejections.push({ deviceCode: p.deviceCode, reason, confidence: conf, nearSpace: roomLabel });
    };

    if (conf < QC_LIMITS.minDeviceConfidence) { reject(`Confidence below ${QC_LIMITS.minDeviceConfidence}`); continue; }
    if (accepted.length >= QC_LIMITS.maxDevicesPerFloor) { reject('Floor device limit reached'); continue; }
    const maxDev = QC_LIMITS.perDevice[p.deviceCode] ?? 2;
    if ((deviceCounts[p.deviceCode] ?? 0) >= maxDev) { reject(`Max ${maxDev} × ${p.deviceCode}`); continue; }
    if ((roomCounts[roomLabel] ?? 0) >= QC_LIMITS.maxDevicesPerRoom) { reject(`Max devices in ${roomLabel}`); continue; }

    if (p.deviceCode === 'WIFI_AP' && !WIFI.has(roomType)) { reject('Wi-Fi AP only in central indoor zones'); continue; }
    if (p.deviceCode === 'DATA_SOCKET' && !DATA.has(roomType)) { reject('Data points limited to main rooms'); continue; }
    if (p.deviceCode === 'LIGHT_SWITCH' && !SWITCH.has(roomType)) { reject('Switches near doors/main rooms only'); continue; }
    if (['SPEAKER', 'VOLUME_CONTROL', 'PROJECTOR', 'SCREEN'].includes(p.deviceCode) && !ENT.has(roomType)) {
      reject('Entertainment devices limited to majlis/living'); continue;
    }
    if (near && SKIP.has(roomType) && p.deviceCode !== 'CCTV') { reject(`No devices in ${roomType}`); continue; }

    accepted.push({
      ...p,
      meta: { ...meta, qcStatus: 'accepted', rejectionReason: undefined, nearSpace: roomLabel },
      hidden: false,
    });
    deviceCounts[p.deviceCode] = (deviceCounts[p.deviceCode] ?? 0) + 1;
    roomCounts[roomLabel] = (roomCounts[roomLabel] ?? 0) + 1;
  }

  return { accepted, rejected, rejections };
}

export function buildQcSummary(
  rawRooms: Room[],
  acceptedRooms: Room[],
  rejectedRooms: Room[],
  rawPlacements: Placement[],
  accepted: Placement[],
  rejected: Placement[],
  rejections: QcRejection[],
): AnalysisQcSummary {
  return {
    detectedSpaces: rawRooms.length,
    acceptedSpaces: acceptedRooms.length,
    rejectedSpaces: rejectedRooms.length,
    rawPlacements: rawPlacements.length,
    acceptedPlacements: accepted.length,
    rejectedPlacements: rejected.length,
    rejections,
  };
}

/** Full QC pipeline for rule-engine suggestions (API re-suggest). */
export function runQualityPipeline(rooms: Room[], zones: Zone[], rawPlacements: Placement[]) {
  const { accepted: acceptedRooms, rejected: rejectedRooms, rejections: roomRej } = filterRooms(rooms);
  const { accepted, rejected, rejections: placementRej } = applyPlacementQc(rawPlacements, acceptedRooms);
  const summary = buildQcSummary(
    rooms, acceptedRooms, rejectedRooms, rawPlacements, accepted, rejected,
    [...roomRej, ...placementRej],
  );
  return { placements: [...accepted, ...rejected], summary, acceptedRooms };
}

export function isAcceptedPlacement(p: Placement): boolean {
  return p.meta?.qcStatus !== 'rejected' && !p.hidden && (p.confidence ?? 1) >= QC_LIMITS.minDeviceConfidence;
}
