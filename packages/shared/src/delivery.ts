/**
 * Client delivery workflow contracts. Extends the existing export system —
 * ExportOptions are stored on Export.options and forwarded to the PDF renderer.
 */
export type OutputStyle = 'standard' | 'detailed';

export type DeliveryStatus = 'draft' | 'ready' | 'exported' | 'delivered';
export const DELIVERY_STATUSES: DeliveryStatus[] = ['draft', 'ready', 'exported', 'delivered'];

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  draft: 'Draft',
  ready: 'Ready for review',
  exported: 'Exported',
  delivered: 'Delivered',
};

export interface ExportOptions {
  floors?: string[];           // floor ids to include; empty/undefined = all
  includeLegend: boolean;
  includeSchedule: boolean;
  includeAiSummary: boolean;
  style: OutputStyle;
  clientName?: string;         // overrides project.client.name on the cover
  preparedBy?: string;         // overrides the exporting user's name
  notes?: string;
  versionName?: string;        // revision label shown on the cover/footer
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  includeLegend: true,
  includeSchedule: true,
  includeAiSummary: true,
  style: 'standard',
};

/** Devices whose absence/hiding materially affects a client-ready deliverable. */
export const CRITICAL_DEVICE_CODES = [
  'CCTV', 'CCTV_DOME', 'NVR', 'ELV_RACK', 'SWITCH', 'WIFI_AP',
  'GATE_MOTOR', 'SMART_LOCK', 'INTERCOM_SCREEN', 'INTERCOM_BELL',
];

export type ChecklistStatus = 'pass' | 'warn' | 'fail';
export interface ChecklistItem {
  id: string;
  label: string;
  status: ChecklistStatus;
  detail?: string;
}
