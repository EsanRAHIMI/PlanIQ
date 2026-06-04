/**
 * Training & Feedback Center — shared types, DTOs and the LEARNED layers
 * (placement priors + hybrid scoring). These EXTEND the rule engine; they never
 * replace it. With no trained model yet, the hybrid score reduces to the rule
 * engine's own confidence plus small prior/feedback nudges.
 */
import { z } from 'zod';

/** Device symbol classes the detector/annotator supports (YOLO class order = index). */
export const DEVICE_CLASSES = [
  'CCTV', 'WIFI_AP', 'INTERCOM_BELL', 'INTERCOM_SCREEN', 'SPEAKER',
  'VOLUME_CONTROL', 'ELV_RACK', 'GATE_MOTOR', 'SENSOR', 'DATA_SOCKET',
  'SWITCH', 'SMART_LOCK', 'PROJECTOR', 'SCREEN', 'THERMOSTAT',
] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];
export const DEVICE_CLASS_INDEX: Record<string, number> =
  Object.fromEntries(DEVICE_CLASSES.map((c, i) => [c, i]));

export const SAMPLE_STATUSES = ['draft', 'uploaded', 'annotated', 'reviewed', 'in_dataset'] as const;
export type SampleStatus = (typeof SAMPLE_STATUSES)[number];

export const MODEL_STATUSES = ['draft', 'training', 'trained', 'evaluated', 'approved', 'production', 'archived'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

/** Allowed status transitions for the promotion workflow. */
export const MODEL_TRANSITIONS: Record<ModelStatus, ModelStatus[]> = {
  draft: ['training', 'archived'],
  training: ['trained', 'draft', 'archived'],
  trained: ['evaluated', 'archived'],
  evaluated: ['approved', 'archived'],
  approved: ['production', 'archived'],
  production: ['archived'],
  archived: ['draft'],
};
export const canTransition = (from: ModelStatus, to: ModelStatus): boolean =>
  (MODEL_TRANSITIONS[from] ?? []).includes(to);

// ── DTOs ───────────────────────────────────────────────────────────────────────
export const createSampleSchema = z.object({
  name: z.string().min(1),
  projectType: z.string().optional(),
  floorKind: z.string().optional(),
  drawingType: z.string().optional(),
  engineer: z.string().optional(),
  date: z.string().optional(),
  notes: z.string().optional(),
});
export const updateSampleSchema = createSampleSchema.partial().extend({
  split: z.enum(['train', 'val']).optional(),
  status: z.enum(SAMPLE_STATUSES).optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' });

export const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]); // [x,y,w,h] normalized
export const annotationSchema = z.object({
  id: z.string().optional(),
  deviceCode: z.enum(DEVICE_CLASSES),
  bboxNorm: bboxSchema,
  spaceTypeHint: z.string().optional(),
  source: z.enum(['heuristic', 'human']).default('human'),
  status: z.enum(['pending', 'confirmed', 'false_positive']).default('confirmed'),
});
export const saveAnnotationsSchema = z.object({ annotations: z.array(annotationSchema) });

export const uploadRoleSchema = z.object({ role: z.enum(['before', 'after']), mime: z.string() });
export const exportDatasetSchema = z.object({
  sampleIds: z.array(z.string()).optional(),
  valRatio: z.number().min(0).max(0.5).default(0.2),
});
export const feedbackSchema = z.object({
  projectId: z.string().optional(),
  floorId: z.string().optional(),
  deviceCode: z.string(),
  action: z.enum(['accepted', 'rejected', 'moved', 'added', 'deleted', 'retyped']),
  fromPos: z.object({ x: z.number(), y: z.number() }).optional(),
  toPos: z.object({ x: z.number(), y: z.number() }).optional(),
  nearSpace: z.string().optional(),
  runId: z.string().optional(),
});
export const modelStatusSchema = z.object({ status: z.enum(MODEL_STATUSES), notes: z.string().optional() });

// ── YOLO export helpers ──────────────────────────────────────────────────────--
/** One YOLO label line: "<class> <cx> <cy> <w> <h>" (all normalized). bboxNorm is [x,y,w,h] top-left. */
export function yoloLabelLine(a: { deviceCode: string; bboxNorm: number[] }): string | null {
  const cls = DEVICE_CLASS_INDEX[a.deviceCode];
  if (cls === undefined) return null;
  const [x, y, w, h] = a.bboxNorm;
  const cx = x + w / 2, cy = y + h / 2;
  const cl = (v: number) => Math.min(1, Math.max(0, v));
  return `${cls} ${cl(cx).toFixed(6)} ${cl(cy).toFixed(6)} ${cl(w).toFixed(6)} ${cl(h).toFixed(6)}`;
}

/** data.yaml content for ultralytics. */
export function dataYaml(trainDir = 'images/train', valDir = 'images/val'): string {
  return [
    `# PlanIQ device-symbol dataset (auto-generated)`,
    `train: ${trainDir}`,
    `val: ${valDir}`,
    `nc: ${DEVICE_CLASSES.length}`,
    `names: [${DEVICE_CLASSES.map((c) => `'${c}'`).join(', ')}]`,
    ``,
  ].join('\n');
}

// ── Learned placement priors ────────────────────────────────────────────────────
export interface PlacementPriors {
  sampleN: number;
  /** spaceType → deviceCode → { meanCount per such space, rate = fraction of spaces with ≥1 } */
  perSpace: Record<string, Record<string, { meanCount: number; rate: number; n: number }>>;
}

interface PriorSample { annotations: { deviceCode: string; spaceTypeHint?: string; status?: string }[] }

/**
 * Learn priors from confirmed annotations: for each space type, how many of each device
 * the engineers typically place. Real statistics from the samples — no GPU.
 */
export function learnPriors(samples: PriorSample[]): PlacementPriors {
  const spaceInstances: Record<string, number> = {};
  const spaceWith: Record<string, Record<string, number>> = {}; // space → code → #spaces having ≥1
  const spaceTotal: Record<string, Record<string, number>> = {}; // space → code → total boxes
  for (const s of samples) {
    const confirmed = s.annotations.filter((a) => a.status !== 'false_positive');
    // count device boxes per (space, code) within this sample
    const perSpaceCode: Record<string, Record<string, number>> = {};
    const spacesSeen = new Set<string>();
    for (const a of confirmed) {
      const sp = a.spaceTypeHint || 'unknown';
      spacesSeen.add(sp);
      (perSpaceCode[sp] ??= {})[a.deviceCode] = (perSpaceCode[sp]?.[a.deviceCode] ?? 0) + 1;
    }
    for (const sp of spacesSeen) spaceInstances[sp] = (spaceInstances[sp] ?? 0) + 1;
    for (const [sp, codes] of Object.entries(perSpaceCode)) {
      for (const [code, n] of Object.entries(codes)) {
        (spaceTotal[sp] ??= {})[code] = (spaceTotal[sp]?.[code] ?? 0) + n;
        (spaceWith[sp] ??= {})[code] = (spaceWith[sp]?.[code] ?? 0) + 1;
      }
    }
  }
  const perSpace: PlacementPriors['perSpace'] = {};
  for (const sp of Object.keys(spaceInstances)) {
    perSpace[sp] = {};
    const inst = spaceInstances[sp] || 1;
    for (const code of Object.keys(spaceTotal[sp] ?? {})) {
      perSpace[sp][code] = {
        meanCount: +(spaceTotal[sp][code] / inst).toFixed(2),
        rate: +((spaceWith[sp]?.[code] ?? 0) / inst).toFixed(2),
        n: spaceTotal[sp][code],
      };
    }
  }
  return { sampleN: samples.length, perSpace };
}

// ── Hybrid decision engine (additive scoring) ────────────────────────────────────
export interface HybridWeights {
  rule: number; prior: number; detector: number; qc: number; feedback: number;
}
export const DEFAULT_HYBRID_WEIGHTS: HybridWeights = {
  rule: 1.0, prior: 0.25, detector: 0.0, qc: 0.15, feedback: 0.2,
};

/**
 * Blend signals into a final confidence WITHOUT changing which devices the rule engine
 * proposed. Returns a copy with meta.hybridScore + meta.priorRate set. Detector weight is
 * 0 until a model is approved, so today this only gently nudges confidence by learned
 * priors and editor feedback.
 */
export function hybridScore(
  p: { deviceCode: string; confidence?: number; meta?: Record<string, any> },
  ctx: {
    spaceType?: string;
    priors?: PlacementPriors;
    detectorAgreement?: number;   // 0..1, future
    qcPass?: boolean;
    rejectionRate?: number;       // 0..1 from feedback
    weights?: HybridWeights;
  } = {},
): number {
  const w = ctx.weights ?? DEFAULT_HYBRID_WEIGHTS;
  const ruleConf = p.confidence ?? 0.7;
  const prior = ctx.spaceType ? ctx.priors?.perSpace[ctx.spaceType]?.[p.deviceCode]?.rate : undefined;
  const priorTerm = prior ?? 0;
  const qcTerm = ctx.qcPass === false ? 0 : 1;
  const det = ctx.detectorAgreement ?? 0;
  const rej = ctx.rejectionRate ?? 0;
  const raw =
    w.rule * ruleConf + w.prior * priorTerm + w.detector * det + w.qc * qcTerm - w.feedback * rej;
  const norm = w.rule + w.prior + w.detector + w.qc; // feedback only subtracts
  return +(Math.min(1, Math.max(0, raw / (norm || 1)))).toFixed(3);
}
