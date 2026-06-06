/**
 * Single source of truth for a project's lifecycle.
 *
 * `project.status` is canonical. `project.delivery.status` is a DERIVED MIRROR kept for
 * backward compatibility only — never written independently. Every status change goes
 * through one validated transition (`canTransitionProject`) so the UI cannot diverge.
 */
import type { DeliveryStatus } from './delivery';

export const PROJECT_STATUSES = [
  'draft', 'in_progress', 'review', 'approved', 'exported', 'delivered', 'archived',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  draft: 'Draft',
  in_progress: 'In progress',
  review: 'In review',
  approved: 'Approved',
  exported: 'Exported',
  delivered: 'Delivered',
  archived: 'Archived',
};

/** Allowed forward + sensible backward transitions. Unknown/legacy sources are permissive. */
export const PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  // Engineers can approve or export directly from editing (single-engineer flow), or go
  // through an explicit review. Export can also happen at any working stage.
  draft: ['in_progress', 'archived'],
  in_progress: ['review', 'approved', 'exported', 'in_progress', 'archived'],
  review: ['approved', 'exported', 'in_progress', 'archived'],
  approved: ['exported', 'delivered', 'review', 'in_progress', 'archived'],
  exported: ['delivered', 'approved', 'in_progress', 'archived'],
  delivered: ['archived', 'exported', 'approved'],
  archived: ['draft', 'in_progress'],
};

export function canTransitionProject(from: string, to: string): boolean {
  if (!PROJECT_STATUSES.includes(to as ProjectStatus)) return false;
  if (from === to) return true;
  const allowed = PROJECT_TRANSITIONS[from as ProjectStatus];
  if (!allowed) return true; // legacy/unknown source — don't block real data
  return allowed.includes(to as ProjectStatus);
}

/** Canonical status → legacy delivery.status (back-compat mirror). */
export function deliveryMirror(status: string): DeliveryStatus {
  switch (status) {
    case 'review':
    case 'approved': return 'ready';
    case 'exported': return 'exported';
    case 'delivered': return 'delivered';
    case 'archived': return 'delivered';
    default: return 'draft'; // draft, in_progress, unknown
  }
}

/** Legacy delivery.status (from the old endpoint) → canonical project status. */
export function projectStatusFromDelivery(d: string): ProjectStatus {
  switch (d) {
    case 'ready': return 'review';
    case 'exported': return 'exported';
    case 'delivered': return 'delivered';
    default: return 'in_progress';
  }
}

/**
 * The 10-stage lifecycle spine. Stages 1–5 are derived from floor data (upload/analysis/
 * spaces/devices) because they precede a project-level status; stages 6–10 map to the
 * canonical `project.status`. `statuses` lists which project statuses mean "this stage done".
 */
export interface LifecycleStageDef { key: string; label: string; doneAt: ProjectStatus[] }
export const LIFECYCLE_STAGES: LifecycleStageDef[] = [
  { key: 'create', label: 'Project Creation', doneAt: ['in_progress', 'review', 'approved', 'exported', 'delivered', 'archived'] },
  { key: 'upload', label: 'Plan Upload', doneAt: ['in_progress', 'review', 'approved', 'exported', 'delivered', 'archived'] },
  { key: 'analysis', label: 'AI Analysis', doneAt: ['review', 'approved', 'exported', 'delivered', 'archived'] },
  { key: 'spaces', label: 'Space Review', doneAt: ['review', 'approved', 'exported', 'delivered', 'archived'] },
  { key: 'devices', label: 'Device Placement', doneAt: ['review', 'approved', 'exported', 'delivered', 'archived'] },
  { key: 'engineer', label: 'Engineer Review', doneAt: ['approved', 'exported', 'delivered', 'archived'] },
  { key: 'optimize', label: 'Optimization', doneAt: [] },
  { key: 'delivery', label: 'Client Delivery', doneAt: ['delivered', 'archived'] },
  { key: 'training', label: 'Training & Feedback', doneAt: [] },
  { key: 'archive', label: 'Archive', doneAt: ['archived'] },
];

/** True when the given project status marks the stage as complete. */
export function isStageDone(stageKey: string, status: string): boolean {
  const stage = LIFECYCLE_STAGES.find((s) => s.key === stageKey);
  return !!stage && stage.doneAt.includes(status as ProjectStatus);
}
