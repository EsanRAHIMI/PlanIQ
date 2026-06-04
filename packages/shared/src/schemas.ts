import { z } from 'zod';
import { ROOM_TYPES, ZONE_TYPES } from './space-types';

export const pointSchema = z.object({ x: z.number(), y: z.number() });

export const roomSchema = z.object({
  id: z.string().optional(),
  label: z.string(),
  rawLabel: z.string().optional(),
  type: z.enum(ROOM_TYPES),
  polygon: z.array(z.array(z.number())),
  centroid: z.tuple([z.number(), z.number()]),
  area: z.number(),
  confidence: z.number().min(0).max(1),
  source: z.enum(['cv', 'manual']),
  reviewed: z.boolean().optional(),
  reviewStatus: z.enum(['ai_detected', 'rejected', 'accepted', 'user_corrected']).optional(),
  aiType: z.enum(ROOM_TYPES).nullable().optional(),
  aiConfidence: z.number().nullable().optional(),
  rejectionReason: z.string().nullable().optional(),
  meta: z.record(z.unknown()).optional(),
});

/** Body for manual space creation / room edits from the editor's Spaces panel. */
export const createRoomSchema = z.object({
  type: z.enum(ROOM_TYPES),
  label: z.string().optional(),
  polygon: z.array(z.array(z.number())).optional(),
  centroid: z.tuple([z.number(), z.number()]).optional(),
  area: z.number().optional(),
});

export const updateRoomSchema = z.object({
  type: z.enum(ROOM_TYPES).optional(),
  label: z.string().optional(),
  reviewStatus: z.enum(['ai_detected', 'rejected', 'accepted', 'user_corrected']).optional(),
  centroid: z.tuple([z.number(), z.number()]).optional(),
  polygon: z.array(z.array(z.number())).optional(),
  // Manual marking: flag a space as double-height so ceiling devices (Wi-Fi/speakers)
  // relocate to the nearest normal-ceiling space per the customer rule.
  doubleHeight: z.boolean().optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' });

export const zoneSchema = z.object({
  id: z.string().optional(),
  type: z.enum(ZONE_TYPES),
  geometry: z.object({
    kind: z.enum(['point', 'line', 'polygon']),
    coords: z.array(z.array(z.number())),
  }),
  confidence: z.number().min(0).max(1),
  source: z.enum(['cv', 'manual']),
});

export const placementSchema = z.object({
  id: z.string().optional(),
  deviceCode: z.string(),
  label: z.string().optional(),
  position: pointSchema,
  rotation: z.number().default(0),
  scale: z.number().positive().default(1),
  layerId: z.string().optional(),
  groupId: z.string().optional(),
  locked: z.boolean().default(false),
  hidden: z.boolean().default(false),
  source: z.enum(['ai', 'manual']).default('manual'),
  reviewed: z.boolean().default(false),
  rationale: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  props: z.record(z.unknown()).default({}),
  meta: z.record(z.unknown()).optional(),
  zIndex: z.number().default(0),
});

export const analysisResultSchema = z.object({
  floorId: z.string().optional(),
  image: z.object({ width: z.number(), height: z.number() }),
  rooms: z.array(roomSchema),
  zones: z.array(zoneSchema),
  detections: z.array(z.object({ class: z.string(), bbox: z.array(z.number()), confidence: z.number() })),
  placements: z.array(placementSchema),
  confidence: z.number().min(0).max(1),
  provider: z.enum(['cv', 'llm_fallback']),
  warnings: z.array(z.string()),
  qcSummary: z.object({
    detectedSpaces: z.number(),
    acceptedSpaces: z.number(),
    rejectedSpaces: z.number(),
    rawPlacements: z.number(),
    acceptedPlacements: z.number(),
    rejectedPlacements: z.number(),
    roomBasedPlacements: z.number().optional(),
    zoneBasedPlacements: z.number().optional(),
    perimeterBasedPlacements: z.number().optional(),
    consistent: z.boolean().optional(),
    summary: z.string().optional(),
    rejections: z.array(z.object({
      deviceCode: z.string(),
      reason: z.string(),
      confidence: z.number().optional(),
      nearSpace: z.string().optional(),
    })),
  }).optional(),
  rawRoomCount: z.number().optional(),
  scale: z.object({
    metersPerPixel: z.number(),
    confidence: z.number(),
    source: z.string(),
  }).optional(),
});

// ── API DTO schemas ──
export const registerSchema = z.object({
  tenantName: z.string().min(2),
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
});
export const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
export const createProjectSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  units: z.enum(['m', 'ft']).default('m'),
  client: z.object({
    name: z.string().optional(), contact: z.string().optional(),
    phone: z.string().optional(), email: z.string().email().optional(), address: z.string().optional(),
  }).optional(),
});
export const batchPlacementSchema = z.object({
  upserts: z.array(placementSchema).default([]),
  deletes: z.array(z.string()).default([]),
});

export type AnalysisResultInput = z.infer<typeof analysisResultSchema>;
