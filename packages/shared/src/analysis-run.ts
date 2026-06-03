import type { AnalysisQcSummary } from './types';
import type { AiSettings } from './ai-settings';

/** Engine that produced a run (display + persistence). */
export type AiProviderKind =
  | 'cv'
  | 'openai'
  | 'claude'
  | 'gemini'
  | 'hybrid'
  | 'rules';

export type AnalysisRunKind = 'full_analysis' | 'rules_resuggest';
export type AnalysisRunStatus = 'running' | 'done' | 'failed';

export interface AnalysisRunTrace {
  id?: string;
  tenantId?: string;
  projectId: string;
  floorId: string;
  floorName?: string;
  projectName?: string;
  kind: AnalysisRunKind;
  status: AnalysisRunStatus;
  jobId?: string | null;
  triggeredBy?: string | null;

  provider: AiProviderKind;
  modelName: string | null;
  fallbackChain: string[];
  qcSettings: Partial<AiSettings> | Record<string, unknown>;

  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;

  detectedSpaces: number;
  acceptedSpaces: number;
  rejectedSpaces: number;
  acceptedDevices: number;
  rejectedDevices: number;
  qcSummary?: AnalysisQcSummary | null;

  errors: string[];
  warnings: string[];
}

export function countsFromQcSummary(summary?: AnalysisQcSummary | null) {
  return {
    detectedSpaces: summary?.detectedSpaces ?? 0,
    acceptedSpaces: summary?.acceptedSpaces ?? 0,
    rejectedSpaces: summary?.rejectedSpaces ?? 0,
    acceptedDevices: summary?.acceptedPlacements ?? 0,
    rejectedDevices: summary?.rejectedPlacements ?? 0,
  };
}

export const PROVIDER_LABELS: Record<AiProviderKind, string> = {
  cv: 'Computer vision (OpenCV + YOLO + OCR)',
  openai: 'OpenAI Vision',
  claude: 'Anthropic Claude Vision',
  gemini: 'Google Gemini Vision',
  hybrid: 'Hybrid (CV + fallback)',
  rules: 'Deterministic rules engine (TypeScript)',
};
