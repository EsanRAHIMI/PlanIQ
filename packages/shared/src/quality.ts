/**
 * Placement quality control (mirror of services/ai/app/rules/quality.py).
 * P5: QC is a GUARDRAIL (sanity caps, dedup, consistency) — the rule engine already
 * targets the right spaces per the customer rules, so QC does not re-reject by room type.
 * Placements carry meta.basis (room|zone|perimeter); per-room budget counts room-anchored
 * devices only, so perimeter/zone devices never starve a room.
 */
import type { Placement, Room, Zone, AnalysisQcSummary, QcRejection } from './types';

export type { AnalysisQcSummary, QcRejection };

export const QC_LIMITS = {
  maxRoomsPerFloor: 24,
  minRoomArea: 0.012,
  minRoomConfidence: 0.48,
  maxDevicesPerFloor: 160,
  minDeviceConfidence: 0.62,
  maxDevicesPerRoom: 12,
  dedupDist: 0.012,
  perDevice: {
    CCTV: 12, WIFI_AP: 8, DATA_SOCKET: 20, LIGHT_SWITCH: 30, SENSOR: 20,
    THERMOSTAT: 10, SPEAKER: 24, VOLUME_CONTROL: 12, PROJECTOR: 2, SCREEN: 2,
    CURTAIN_MOTOR: 8, SMART_LOCK: 3, INTERCOM_SCREEN: 6, INTERCOM_BELL: 4,
    GATE_MOTOR: 2, ELV_RACK: 1, SWITCH: 2, NVR: 2,
  } as Record<string, number>,
};

const OUTDOOR = new Set(['outdoor', 'garden', 'parking', 'gate', 'roof', 'pool', 'bbq', 'outdoor_seating', 'store_outdoor']);
// Pure-outdoor spaces never host an indoor device (cameras exempt). Service/bathroom/
// kitchen/store are intentionally NOT skipped — the engine targets them per the rules.
const SKIP = OUTDOOR;

export function spaceCategory(type: string): string {
  if (OUTDOOR.has(type)) return 'outdoor';
  if (['corridor', 'entrance', 'main_entrance', 'guest_entrance', 'service_entrance', 'staircase', 'lift', 'main_door'].includes(type)) return 'circulation';
  if (['service_area', 'store', 'store_indoor', 'bathroom', 'maid_room', 'laundry', 'pantry', 'electrical_room'].includes(type)) return 'service';
  if (['living_room', 'majlis', 'master_bedroom', 'bedroom', 'dining', 'kitchen', 'sitting_area', 'dressing'].includes(type)) return 'indoor';
  return 'other';
}

/** room | zone | perimeter — what a suggestion is anchored to. */
export function placementBasis(p: Placement): 'room' | 'zone' | 'perimeter' {
  const b = (p.meta as any)?.basis;
  if (b === 'room' || b === 'zone' || b === 'perimeter') return b;
  const r = (p.rationale ?? '').toLowerCase();
  if (r.includes('corner') || r.includes('perimeter')) return 'perimeter';
  if (r.includes('gate') || r.includes('parking')) return 'zone';
  return 'room';
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
  const seen: Array<[string, number, number]> = [];
  const hasRooms = rooms.length > 0;

  const ordered = [...placements].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

  for (const p of ordered) {
    const conf = p.confidence ?? 0;
    const px = p.position.x; const py = p.position.y;
    const near = nearestRoom(px, py, rooms);
    const roomType = near?.type ?? 'unknown';
    const roomLabel = near?.label ?? roomType;
    const basis = placementBasis(p);
    const meta: Record<string, unknown> = { ...(p.meta ?? {}), basis, spaceCategory: near ? spaceCategory(roomType) : 'unknown' };

    const reject = (reason: string) => {
      rejected.push({ ...p, meta: { ...meta, qcStatus: 'rejected', rejectionReason: reason }, hidden: true });
      rejections.push({ deviceCode: p.deviceCode, reason, confidence: conf, nearSpace: roomLabel });
    };

    if (basis === 'room' && !hasRooms) { reject('No interior spaces accepted — room-based device suppressed for consistency'); continue; }
    if (conf < QC_LIMITS.minDeviceConfidence) { reject(`Confidence below ${QC_LIMITS.minDeviceConfidence}`); continue; }
    if (seen.some(([c, sx, sy]) => c === p.deviceCode && Math.abs(sx - px) < QC_LIMITS.dedupDist && Math.abs(sy - py) < QC_LIMITS.dedupDist)) {
      reject('Duplicate of a nearby identical device'); continue;
    }
    if (accepted.length >= QC_LIMITS.maxDevicesPerFloor) { reject('Floor device limit reached'); continue; }
    const maxDev = QC_LIMITS.perDevice[p.deviceCode] ?? 8;
    if ((deviceCounts[p.deviceCode] ?? 0) >= maxDev) { reject(`Max ${maxDev} × ${p.deviceCode}`); continue; }
    if (basis === 'room' && (roomCounts[roomLabel] ?? 0) >= QC_LIMITS.maxDevicesPerRoom) { reject(`Max devices in ${roomLabel}`); continue; }
    if (basis === 'room' && near && SKIP.has(roomType) && p.deviceCode !== 'CCTV') { reject(`No indoor devices in outdoor ${roomType}`); continue; }

    const acceptedP: Placement = {
      ...p,
      meta: { ...meta, qcStatus: 'accepted', rejectionReason: undefined, nearSpace: roomLabel },
      hidden: false,
    };
    if ((basis === 'zone' || basis === 'perimeter') && !hasRooms) {
      (acceptedP.meta as any).placementContext = 'perimeter_fallback';
      acceptedP.rationale = `[Perimeter/zone fallback — no interior spaces detected] ${p.rationale ?? p.deviceCode}`;
      acceptedP.label = p.label ?? `${p.deviceCode} (perimeter/zone fallback)`;
    }
    accepted.push(acceptedP);
    deviceCounts[p.deviceCode] = (deviceCounts[p.deviceCode] ?? 0) + 1;
    if (basis === 'room') roomCounts[roomLabel] = (roomCounts[roomLabel] ?? 0) + 1;
    seen.push([p.deviceCode, px, py]);
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
  const roomBased = accepted.filter((p) => placementBasis(p) === 'room').length;
  const zoneBased = accepted.filter((p) => placementBasis(p) === 'zone').length;
  const perimeterBased = accepted.filter((p) => placementBasis(p) === 'perimeter').length;
  const acceptedSpaces = acceptedRooms.length;
  const acceptedDevices = accepted.length;
  const fallback = zoneBased + perimeterBased;

  const consistent =
    roomBased + zoneBased + perimeterBased === acceptedDevices &&
    rawPlacements.length === acceptedDevices + rejected.length &&
    !(acceptedSpaces === 0 && roomBased > 0);

  let summary: string;
  if (acceptedSpaces === 0 && acceptedDevices === 0) {
    summary = 'No interior spaces were confidently detected and no devices were placed. Try a higher-resolution plan or verify the drawing quality, then re-run analysis.';
  } else if (acceptedSpaces === 0 && acceptedDevices > 0) {
    summary = `No interior spaces were confidently detected. The ${acceptedDevices} suggestion(s) shown are perimeter/zone-based only (e.g. gate, parking, building perimeter) and are NOT tied to interior rooms — treat them as fallback placements and review the plan.`;
  } else {
    const fb = fallback ? `, ${fallback} perimeter/zone-based` : '';
    summary = `Detected ${rawRooms.length} space(s); ${acceptedSpaces} accepted. Placed ${acceptedDevices} device(s): ${roomBased} room-based${fb}. ${rejected.length} suggestion(s) withheld by QC.`;
  }

  return {
    detectedSpaces: rawRooms.length,
    acceptedSpaces,
    rejectedSpaces: rejectedRooms.length,
    rawPlacements: rawPlacements.length,
    acceptedPlacements: acceptedDevices,
    rejectedPlacements: rejected.length,
    roomBasedPlacements: roomBased,
    zoneBasedPlacements: zoneBased,
    perimeterBasedPlacements: perimeterBased,
    consistent,
    summary,
    rejections,
  };
}

/** Full QC pipeline for rule-engine suggestions (API re-suggest). */
export function runQualityPipeline(rooms: Room[], zones: Zone[], rawPlacements: Placement[]) {
  const { accepted: acceptedRooms, rejected: rejectedRooms, rejections: roomRej } = filterRooms(rooms);
  const { accepted, rejected, rejections: placementRej } = applyPlacementQc(rawPlacements, acceptedRooms);
  const summary = buildQcSummary(
    rooms, acceptedRooms, rejectedRooms, rawPlacements, accepted, rejected,
    [...placementRej, ...roomRej],
  );
  return { placements: [...accepted, ...rejected], summary, acceptedRooms };
}

export function isAcceptedPlacement(p: Placement): boolean {
  return p.meta?.qcStatus !== 'rejected' && !p.hidden && (p.confidence ?? 1) >= QC_LIMITS.minDeviceConfidence;
}
