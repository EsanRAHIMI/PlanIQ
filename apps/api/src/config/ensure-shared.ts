import { countsFromQcSummary } from '@planiq/shared';

/** Fail fast when @planiq/shared dist is stale (common after adding analysis-run exports). */
export function assertPlaniqSharedBuilt(): void {
  if (typeof countsFromQcSummary !== 'function') {
    throw new Error(
      'countsFromQcSummary is missing from @planiq/shared. Rebuild shared then restart API:\n'
      + '  pnpm --filter @planiq/shared build\n'
      + '  pnpm --filter @planiq/api build',
    );
  }
}
