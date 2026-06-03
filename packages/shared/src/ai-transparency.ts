import type { AiSettings } from './ai-settings';
import type { AnalysisRunTrace } from './analysis-run';

export interface AiCapabilities {
  aiServiceOk: boolean;
  yoloWeightsAvailable: boolean;
  yoloWeightsPath?: string | null;
  fallbackProvider: AiSettings['fallbackProvider'];
}

/** Badge + helper for Re-run Rule Suggestions (always rules engine). */
export const RULES_ENGINE_BADGE = 'Engine: Internal Rules + QC';
export const RULES_ENGINE_HELPER =
  'Uses existing detected spaces. Does not call OpenAI or re-read the plan image.';

export function fullAnalysisBadge(caps: AiCapabilities): string {
  if (caps.yoloWeightsAvailable) {
    return 'Engine: CV Pipeline + YOLOv11 + OCR + QC';
  }
  return 'Engine: CV Pipeline + OCR + QC';
}

export function fullAnalysisFallbackBadge(caps: AiCapabilities): string {
  if (caps.fallbackProvider === 'disabled') return 'OpenAI fallback off';
  if (caps.fallbackProvider === 'openai') return 'OpenAI fallback enabled';
  if (caps.fallbackProvider === 'claude') return 'Claude fallback enabled';
  if (caps.fallbackProvider === 'gemini') return 'Gemini fallback enabled';
  return 'Vision-LLM fallback enabled';
}

export function fullAnalysisHelper(caps: AiCapabilities): string {
  const base = caps.yoloWeightsAvailable
    ? 'Re-reads the plan image with OpenCV, YOLOv11 symbol detection, OCR, and QC.'
    : 'Re-reads the plan image with OpenCV geometry + OCR (YOLO weights not loaded).';
  const fb = caps.fallbackProvider === 'disabled'
    ? ' Vision-LLM fallback is disabled — CV pipeline only.'
    : ` If tenant fallback is enabled (${caps.fallbackProvider}), the worker may use it instead of CV.`;
  return base + fb;
}

export function rulesRunStartToast(): string {
  return 'Running internal rule engine…';
}

export function fullAnalysisStartToast(caps: AiCapabilities): string {
  const engine = caps.yoloWeightsAvailable
    ? 'CV Pipeline + OCR + YOLOv11'
    : 'CV Pipeline + OCR';
  return `Running full AI analysis with ${engine}…`;
}

export function fullAnalysisFallbackToast(caps: AiCapabilities): string | null {
  if (caps.fallbackProvider === 'disabled') return null;
  return 'OpenAI fallback is enabled and may be used if CV confidence is low.';
}

export function lastRunSummaryLabel(run: AnalysisRunTrace | null | undefined): string {
  if (!run) return 'No analysis run recorded yet';
  if (run.kind === 'rules_resuggest' || run.provider === 'rules') {
    return 'Last run used: Internal Rules + QC';
  }
  if (run.provider === 'openai' || run.provider === 'claude' || run.provider === 'gemini') {
    const name = run.provider === 'openai' ? 'OpenAI' : run.provider === 'claude' ? 'Claude' : 'Gemini';
    return `Last run used: ${name} fallback`;
  }
  if (run.fallbackChain.some((s) => s.startsWith('llm_fallback'))) {
    return 'Last run used: Vision-LLM fallback';
  }
  if (run.modelName?.includes('yolo') || run.fallbackChain.includes('cv')) {
    return 'Last run used: CV Pipeline + YOLOv11 + OCR';
  }
  return 'Last run used: CV Pipeline + OCR + QC';
}

export function runCompletionSummary(run: AnalysisRunTrace): string {
  let engine: string;
  if (run.kind === 'rules_resuggest') {
    engine = 'Internal Rules + QC';
  } else if (run.provider === 'openai') {
    engine = 'OpenAI fallback';
  } else if (run.provider === 'claude') {
    engine = 'Claude fallback';
  } else if (run.provider === 'gemini') {
    engine = 'Gemini fallback';
  } else {
    engine = run.modelName?.toLowerCase().includes('yolo')
      ? 'CV Pipeline + YOLOv11 + OCR'
      : 'CV Pipeline + OCR + QC';
  }
  const model = run.modelName ? ` · Model: ${run.modelName}` : '';
  const dur = run.durationMs != null ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : '';
  const fb = usedFallback(run) ? ' · Fallback used' : ' · No fallback';
  return `${engine}${model}${dur} · ${run.acceptedDevices} accepted / ${run.rejectedDevices} rejected devices${fb}`;
}

export function usedFallback(run: AnalysisRunTrace): boolean {
  return run.provider === 'openai' || run.provider === 'claude' || run.provider === 'gemini'
    || run.fallbackChain.some((c) => c.startsWith('llm_fallback') || c === 'cv_skipped');
}

export function noVisibleChangesMessage(
  beforeCount: number,
  afterCount: number,
  run: AnalysisRunTrace,
): string | null {
  if (beforeCount === afterCount && run.acceptedDevices === 0 && run.rejectedDevices === 0) {
    return 'No visible changes were produced by this run.';
  }
  if (beforeCount === afterCount && run.kind === 'rules_resuggest') {
    return 'No visible changes were produced by this run (device count unchanged).';
  }
  return null;
}

export function formatRunEngineShort(run: AnalysisRunTrace): string {
  if (run.kind === 'rules_resuggest') return 'Internal Rules + QC';
  if (['openai', 'claude', 'gemini'].includes(run.provider)) {
    return `${run.provider} fallback`;
  }
  return capsFromRun(run);
}

function capsFromRun(run: AnalysisRunTrace): string {
  if (run.modelName?.toLowerCase().includes('yolo')) return 'CV + YOLOv11 + OCR';
  return 'CV Pipeline + OCR + QC';
}
