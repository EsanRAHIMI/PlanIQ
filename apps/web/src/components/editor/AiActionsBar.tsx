'use client';

import type { AiCapabilities } from '@planiq/shared';
import {
  RULES_ENGINE_BADGE,
  RULES_ENGINE_HELPER,
  fullAnalysisBadge,
  fullAnalysisFallbackBadge,
  fullAnalysisHelper,
} from '@planiq/shared';
import { LEXICON } from '@/lib/lexicon';

function EngineBadge({ children, variant = 'default' }: { children: string; variant?: 'default' | 'fallback' | 'warn' }) {
  const cls = variant === 'fallback'
    ? 'border-violet-200 bg-violet-50 text-violet-800'
    : variant === 'warn'
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : 'border-sky-200 bg-sky-50 text-sky-800';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`}>
      {children}
    </span>
  );
}

export function AiActionsBar({
  capabilities,
  rulesBusy,
  analysisBusy,
  hasRaster,
  onRulesResuggest,
  onFullAnalysis,
}: {
  capabilities: AiCapabilities | null;
  rulesBusy: boolean;
  analysisBusy: boolean;
  hasRaster: boolean;
  onRulesResuggest: () => void;
  onFullAnalysis: () => void;
}) {
  const caps = capabilities ?? {
    aiServiceOk: false,
    yoloWeightsAvailable: false,
    fallbackProvider: 'disabled' as const,
  };

  return (
    <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
      <div className="grid gap-3 lg:grid-cols-2">
        {/* A) Re-run Rule Suggestions */}
        <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-primary px-3 py-1.5 text-xs"
              onClick={onRulesResuggest}
              disabled={rulesBusy || analysisBusy}
            >
              {rulesBusy ? LEXICON.suggestDevicesBusy : LEXICON.suggestDevices}
            </button>
            <EngineBadge>{RULES_ENGINE_BADGE}</EngineBadge>
          </div>
          <p className="text-[11px] leading-relaxed text-slate-500">{RULES_ENGINE_HELPER}</p>
        </div>

        {/* B) Run Full AI Analysis */}
        <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-primary px-3 py-1.5 text-xs"
              onClick={onFullAnalysis}
              disabled={rulesBusy || analysisBusy || !hasRaster}
              title={!hasRaster ? 'Upload a plan image first' : undefined}
            >
              {analysisBusy ? LEXICON.analyzePlanBusy : LEXICON.analyzePlan}
            </button>
            <EngineBadge>{fullAnalysisBadge(caps)}</EngineBadge>
            <EngineBadge variant={caps.fallbackProvider === 'disabled' ? 'default' : 'fallback'}>
              {fullAnalysisFallbackBadge(caps)}
            </EngineBadge>
            {!caps.aiServiceOk && (
              <EngineBadge variant="warn">AI service offline</EngineBadge>
            )}
          </div>
          <p className="text-[11px] leading-relaxed text-slate-500">{fullAnalysisHelper(caps)}</p>
        </div>
      </div>
    </div>
  );
}
