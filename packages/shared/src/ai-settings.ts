/**
 * Canonical AI / quality-control settings. Mirrors the defaults hardcoded in
 * services/ai/app/rules/quality.py so the admin UI, the API, the worker, and the
 * Python pipeline all agree on keys and defaults. Stored per-tenant in the
 * Setting collection under AI_SETTINGS_KEY; the worker forwards overrides to the
 * AI /analyze call so changes here actually affect suggestions.
 */
export type FallbackProvider = 'disabled' | 'openai' | 'gemini' | 'claude';

export interface AiSettings {
  fallbackProvider: FallbackProvider;
  maxRoomsPerFloor: number;
  maxDevicesPerFloor: number;
  maxDevicesPerRoom: number;
  minRoomConfidence: number;
  minDeviceConfidence: number;
}

export const AI_SETTINGS_KEY = 'ai.qc';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  fallbackProvider: 'disabled',
  maxRoomsPerFloor: 18,
  maxDevicesPerFloor: 32,
  maxDevicesPerRoom: 3,
  minRoomConfidence: 0.48,
  minDeviceConfidence: 0.62,
};

/** Validation bounds for each tunable — enforced by the admin API before save. */
export const AI_SETTINGS_BOUNDS: Record<keyof Omit<AiSettings, 'fallbackProvider'>, [number, number]> = {
  maxRoomsPerFloor: [1, 60],
  maxDevicesPerFloor: [1, 200],
  maxDevicesPerRoom: [1, 20],
  minRoomConfidence: [0, 1],
  minDeviceConfidence: [0, 1],
};

export const FALLBACK_PROVIDERS: FallbackProvider[] = ['disabled', 'openai', 'gemini', 'claude'];

/** Merge stored partial settings over defaults and clamp to valid bounds. */
export function normalizeAiSettings(partial?: Partial<AiSettings> | null): AiSettings {
  const merged: AiSettings = { ...DEFAULT_AI_SETTINGS, ...(partial ?? {}) };
  if (!FALLBACK_PROVIDERS.includes(merged.fallbackProvider)) {
    merged.fallbackProvider = DEFAULT_AI_SETTINGS.fallbackProvider;
  }
  (Object.keys(AI_SETTINGS_BOUNDS) as (keyof typeof AI_SETTINGS_BOUNDS)[]).forEach((k) => {
    const [min, max] = AI_SETTINGS_BOUNDS[k];
    const v = Number(merged[k]);
    merged[k] = Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : DEFAULT_AI_SETTINGS[k];
  });
  return merged;
}
