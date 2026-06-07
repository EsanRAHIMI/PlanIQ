/**
 * Runnable smoke test for the project lifecycle state machine (single source of truth).
 * Asserts the real `canTransitionProject` allows the intended paths and rejects impossible
 * ones. Run: node --experimental-strip-types apps/api/test/lifecycle.smoke.ts (from repo root)
 */
// @ts-ignore - load the built shared package
import { canTransitionProject, deliveryMirror } from '../../../packages/shared/dist/lifecycle.js';

let pass = 0, fail = 0;
const ck = (n: string, c: boolean) => { if (c) { console.log('  PASS', n); pass++; } else { console.log('  FAIL', n); fail++; } };

console.log('Lifecycle smoke (canTransitionProject):');
// Intended forward flow
ck('draft->in_progress', canTransitionProject('draft', 'in_progress'));
ck('in_progress->review', canTransitionProject('in_progress', 'review'));
ck('review->approved', canTransitionProject('review', 'approved'));
ck('approved->exported', canTransitionProject('approved', 'exported'));
ck('exported->delivered', canTransitionProject('exported', 'delivered'));
ck('delivered->archived', canTransitionProject('delivered', 'archived'));
// Intended shortcuts (single-engineer flow / export at any working stage — by design)
ck('in_progress->approved (single-engineer)', canTransitionProject('in_progress', 'approved'));
ck('review->exported (export anytime)', canTransitionProject('review', 'exported'));
// Impossible transitions are rejected
ck('reject draft->delivered', !canTransitionProject('draft', 'delivered'));
ck('reject draft->approved', !canTransitionProject('draft', 'approved'));
ck('reject delivered->draft', !canTransitionProject('delivered', 'draft'));
ck('reject unknown target status', !canTransitionProject('draft', 'banana'));
// Delivery mirror stays consistent
ck('mirror approved->ready', deliveryMirror('approved') === 'ready');
ck('mirror delivered->delivered', deliveryMirror('delivered') === 'delivered');
ck('mirror draft->draft', deliveryMirror('draft') === 'draft');

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
