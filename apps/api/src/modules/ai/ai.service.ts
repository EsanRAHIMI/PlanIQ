import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { analysisResultSchema, type AnalysisResult } from '@planiq/shared';

/** Thin client to the self-hosted FastAPI CV service. */
@Injectable()
export class AiService {
  private readonly logger = new Logger('AiClient');
  private readonly base: string;
  private readonly timeout: number;
  private readonly fallback: string;

  constructor(config: ConfigService) {
    const ai = config.get('ai') as any;
    this.base = ai.url;
    this.timeout = ai.timeoutMs;
    this.fallback = ai.fallbackProvider;
  }

  async analyze(params: {
    imageUrl: string; floorId: string; units: string; provider?: 'cv' | 'llm_fallback';
  }): Promise<AnalysisResult> {
    const provider = params.provider === 'llm_fallback' && this.fallback !== 'disabled'
      ? 'llm_fallback' : 'cv';
    const body = JSON.stringify({ ...params, provider, fallbackProvider: this.fallback });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeout);
    try {
      const res = await fetch(`${this.base}/analyze`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ctrl.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new UnprocessableEntityException(`AI analysis failed (${res.status}): ${txt.slice(0, 200)}`);
      }
      const json = await res.json();
      return analysisResultSchema.parse(json); // validate AI output before it touches the DB
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new UnprocessableEntityException('AI analysis timed out');
      this.logger.error(e?.message);
      throw e instanceof UnprocessableEntityException ? e : new UnprocessableEntityException('AI service unreachable');
    } finally {
      clearTimeout(t);
    }
  }

  async health(): Promise<boolean> {
    try { const r = await fetch(`${this.base}/health`); return r.ok; } catch { return false; }
  }
}
