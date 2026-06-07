/**
 * Runnable smoke test for the authorization helper used by every by-id endpoint
 * (placements / floors / rooms / versions / assets / analysis-runs).
 *
 * This exercises the REAL `assertProjectMember` — the core of the C1 permission fix —
 * without a database. Endpoint wiring (each route calls it with the right role) is covered
 * by the e2e suite (test/smoke.e2e-spec.ts), which needs the dev stack.
 *
 * Run: node --experimental-strip-types apps/api/test/permission.smoke.ts   (from repo root)
 */
import { assertProjectMember } from '../src/common/project-access.ts';

let pass = 0, fail = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.log('  FAIL', name, '->', (e as Error).message); fail++; }
}
function throws(fn: () => void): boolean {
  try { fn(); return false; } catch { return true; }
}

const owner = { id: 'u-owner', tenantId: 't1', globalRole: 'editor' } as any;
const admin = { id: 'u-admin', tenantId: 't1', globalRole: 'admin' } as any;
const viewer = { id: 'u-viewer', tenantId: 't1', globalRole: 'editor' } as any;
const editor = { id: 'u-editor', tenantId: 't1', globalRole: 'editor' } as any;
const manager = { id: 'u-mgr', tenantId: 't1', globalRole: 'editor' } as any;
const outsider = { id: 'u-out', tenantId: 't1', globalRole: 'editor' } as any;

const project = {
  ownerId: 'u-owner',
  members: [
    { userId: 'u-viewer', role: 'viewer' },
    { userId: 'u-editor', role: 'editor' },
    { userId: 'u-mgr', role: 'manager' },
  ],
};

console.log('Permission smoke (assertProjectMember):');

// non-member is rejected at every level
check('non-member rejected (viewer read)', () => { if (!throws(() => assertProjectMember(outsider, project, 'viewer'))) throw new Error('should have thrown'); });
check('non-member rejected (editor write)', () => { if (!throws(() => assertProjectMember(outsider, project, 'editor'))) throw new Error('should have thrown'); });

// viewer can read, cannot write
check('viewer can read', () => assertProjectMember(viewer, project, 'viewer'));
check('viewer cannot write (editor)', () => { if (!throws(() => assertProjectMember(viewer, project, 'editor'))) throw new Error('viewer must not write'); });

// editor can read + write, cannot manage
check('editor can read', () => assertProjectMember(editor, project, 'viewer'));
check('editor can write', () => assertProjectMember(editor, project, 'editor'));
check('editor cannot manage', () => { if (!throws(() => assertProjectMember(editor, project, 'manager'))) throw new Error('editor must not manage'); });

// manager can manage (approve/export/deliver)
check('manager can manage', () => assertProjectMember(manager, project, 'manager'));

// owner + global admin bypass everything
check('owner bypass (manage)', () => assertProjectMember(owner, project, 'manager'));
check('global admin bypass (manage)', () => assertProjectMember(admin, project, 'manager'));

// missing/empty project => not a member
check('empty project rejects non-admin', () => { if (!throws(() => assertProjectMember(editor, {}, 'viewer'))) throw new Error('should reject'); });
check('empty project allows admin', () => assertProjectMember(admin, {}, 'viewer'));

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
