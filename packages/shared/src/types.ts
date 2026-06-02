import type { RoomType, ZoneType } from './space-types';

export type Point = { x: number; y: number };

export interface Room {
  id?: string;
  label: string;
  rawLabel?: string;
  type: RoomType;
  polygon: number[][];     // normalized vertices
  centroid: [number, number];
  area: number;            // normalized
  confidence: number;
  source: 'cv' | 'manual';
  reviewed?: boolean;
}

export interface Zone {
  id?: string;
  type: ZoneType;
  geometry: { kind: 'point' | 'line' | 'polygon'; coords: number[][] };
  confidence: number;
  source: 'cv' | 'manual';
}

export interface Placement {
  id?: string;
  deviceCode: string;
  label?: string;
  position: Point;        // normalized
  rotation: number;
  scale: number;
  layerId?: string;
  groupId?: string;
  locked: boolean;
  hidden: boolean;
  source: 'ai' | 'manual';
  reviewed: boolean;
  rationale?: string;
  confidence?: number;
  props: Record<string, unknown>;
  meta?: Record<string, unknown>;
  zIndex: number;
}

export interface QcRejection {
  deviceCode: string;
  reason: string;
  confidence?: number;
  nearSpace?: string;
}

export interface AnalysisQcSummary {
  detectedSpaces: number;
  acceptedSpaces: number;
  rejectedSpaces: number;
  rawPlacements: number;
  acceptedPlacements: number;
  rejectedPlacements: number;
  rejections: QcRejection[];
}

export interface AnalysisResult {
  floorId?: string;
  image: { width: number; height: number };
  rooms: Room[];
  zones: Zone[];
  detections: { class: string; bbox: number[]; confidence: number }[];
  placements: Placement[];
  confidence: number;
  provider: 'cv' | 'llm_fallback';
  warnings: string[];
  qcSummary?: AnalysisQcSummary;
  rawRoomCount?: number;
}

export interface RuleConfig {
  wifiAreaPerAp: number;       // normalized area covered by one AP
  thermostatRooms: RoomType[];
  speakerRooms: RoomType[];
  sensorRooms: RoomType[];
  cctvPerBuildingCorner: boolean;
}

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  wifiAreaPerAp: 0.12,
  thermostatRooms: ['bedroom', 'master_bedroom', 'living_room', 'majlis'],
  speakerRooms: ['living_room', 'majlis', 'dining', 'sitting_area'],
  sensorRooms: ['corridor', 'entrance', 'staircase'],
  cctvPerBuildingCorner: true,
};

export type GlobalRole = 'superadmin' | 'admin' | 'manager' | 'editor' | 'viewer';
export type ProjectRole = 'manager' | 'editor' | 'viewer';
