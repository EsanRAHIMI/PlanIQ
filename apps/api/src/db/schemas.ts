import { Schema, Types } from 'mongoose';

const opts = { timestamps: true };
const oid = Schema.Types.ObjectId;

/** Soft-delete query middleware applied to all schemas. */
function softDelete(schema: Schema) {
  schema.add({ deletedAt: { type: Date, default: null } });
  const filter = function (this: any) { if (!this.getFilter().includeDeleted) this.where({ deletedAt: null }); };
  ['find', 'findOne', 'countDocuments', 'findOneAndUpdate'].forEach((m) => schema.pre(m as any, filter));
}

export const TenantSchema = new Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  plan: { type: String, enum: ['free', 'pro', 'enterprise'], default: 'free' },
  settings: { defaultUnits: { type: String, default: 'm' }, logoKey: String, brandColor: String },
  limits: { maxProjects: { type: Number, default: 50 }, maxStorageMB: { type: Number, default: 10240 } },
}, opts);

export const UserSchema = new Schema({
  tenantId: { type: oid, ref: 'Tenant', required: true, index: true },
  email: { type: String, required: true, lowercase: true },
  passwordHash: { type: String, required: true },
  name: { type: String, required: true },
  globalRole: { type: String, enum: ['superadmin', 'admin', 'manager', 'editor', 'viewer'], default: 'editor' },
  status: { type: String, enum: ['active', 'invited', 'suspended'], default: 'active' },
  avatarKey: String,
  lastLoginAt: Date,
  mfa: { enabled: { type: Boolean, default: false }, secret: String },
}, opts);
UserSchema.index({ tenantId: 1, email: 1 }, { unique: true });

export const RefreshSessionSchema = new Schema({
  userId: { type: oid, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true },
  userAgent: String, ip: String,
  expiresAt: { type: Date, required: true },
  revokedAt: Date,
}, opts);
RefreshSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ProjectSchema = new Schema({
  tenantId: { type: oid, required: true, index: true },
  name: { type: String, required: true },
  code: String,
  client: { name: String, contact: String, phone: String, email: String, address: String },
  description: String,
  status: { type: String, enum: ['draft', 'in_progress', 'review', 'delivered', 'archived'], default: 'draft' },
  units: { type: String, enum: ['m', 'ft'], default: 'm' },
  ownerId: { type: oid, ref: 'User', required: true },
  members: [{ userId: { type: oid, ref: 'User' }, role: { type: String, enum: ['manager', 'editor', 'viewer'] }, addedAt: { type: Date, default: Date.now } }],
  cover: { assetKey: String },
  delivery: {
    status: { type: String, enum: ['draft', 'ready', 'exported', 'delivered'], default: 'draft' },
    deliveredAt: Date,
    updatedBy: oid,
    updatedAt: Date,
  },
  stats: { floors: { type: Number, default: 0 }, devices: { type: Number, default: 0 }, lastExportAt: Date },
}, opts);
ProjectSchema.index({ tenantId: 1, status: 1 });
ProjectSchema.index({ name: 'text', code: 'text' });

export const FloorSchema = new Schema({
  tenantId: { type: oid, required: true, index: true },
  projectId: { type: oid, ref: 'Project', required: true, index: true },
  name: { type: String, required: true },
  level: { type: Number, default: 0 },
  kind: { type: String, enum: ['site', 'ground', 'first', 'second', 'roof', 'basement', 'other'], default: 'other' },
  raster: { assetId: oid, key: String, width: Number, height: Number, dpi: Number },
  scale: { metersPerPixel: Number, calibrated: { type: Boolean, default: false } },
  analysis: {
    status: { type: String, enum: ['none', 'queued', 'processing', 'done', 'failed'], default: 'none' },
    jobId: String, version: Number, confidence: Number, error: String, finishedAt: Date,
    qcSummary: { type: Schema.Types.Mixed },
    rawRoomCount: Number,
    latestRunId: oid,
  },
  counts: { rooms: { type: Number, default: 0 }, placements: { type: Number, default: 0 } },
}, opts);
FloorSchema.index({ projectId: 1, level: 1 });

export const PlanAssetSchema = new Schema({
  tenantId: { type: oid, required: true, index: true },
  projectId: { type: oid, required: true, index: true },
  floorId: oid,
  kind: { type: String, enum: ['source', 'page_raster', 'export', 'thumbnail'], required: true },
  originalName: String,
  mime: String,
  ext: { type: String, enum: ['pdf', 'png', 'jpg', 'jpeg', 'dwg'] },
  s3Key: { type: String, required: true, unique: true },
  sizeBytes: Number, checksum: String, page: Number, width: Number, height: Number,
  status: { type: String, enum: ['pending', 'uploaded', 'scanned', 'rejected'], default: 'pending' },
  scan: { clean: Boolean, engine: String, at: Date },
}, opts);

const geometry = { kind: { type: String, enum: ['point', 'line', 'polygon'] }, coords: [[Number]] };

export const DetectedRoomSchema = new Schema({
  tenantId: { type: oid, required: true },
  floorId: { type: oid, required: true, index: true },
  label: String, rawLabel: String, type: String,
  polygon: [[Number]], centroid: [Number], area: Number,
  confidence: Number,
  source: { type: String, enum: ['cv', 'manual'], default: 'cv' },
  reviewed: { type: Boolean, default: false },
  meta: { type: Schema.Types.Mixed, default: {} },
}, opts);

export const DetectedZoneSchema = new Schema({
  tenantId: { type: oid, required: true },
  floorId: { type: oid, required: true, index: true },
  type: String, geometry, confidence: Number,
  source: { type: String, enum: ['cv', 'manual'], default: 'cv' },
}, opts);

export const PlacementSchema = new Schema({
  tenantId: { type: oid, required: true },
  floorId: { type: oid, required: true, index: true },
  projectId: { type: oid, required: true, index: true },
  deviceTypeId: oid,
  deviceCode: { type: String, required: true },
  label: String,
  position: { x: Number, y: Number },
  rotation: { type: Number, default: 0 },
  scale: { type: Number, default: 1 },
  layerId: oid,
  groupId: String,
  locked: { type: Boolean, default: false },
  hidden: { type: Boolean, default: false },
  source: { type: String, enum: ['ai', 'manual'], default: 'manual' },
  reviewed: { type: Boolean, default: false },
  rationale: String,
  confidence: Number,
  props: { type: Schema.Types.Mixed, default: {} },
  meta: { type: Schema.Types.Mixed, default: {} },
  zIndex: { type: Number, default: 0 },
}, opts);

export const LayerSchema = new Schema({
  tenantId: { type: oid, required: true },
  floorId: { type: oid, required: true, index: true },
  name: String, color: String, order: Number,
  visible: { type: Boolean, default: true }, locked: { type: Boolean, default: false },
}, opts);

export const DeviceLibrarySchema = new Schema({
  tenantId: { type: oid, default: null },
  code: { type: String, required: true },
  name: String,
  category: String, icon: String, color: String,
  defaultProps: { type: Schema.Types.Mixed, default: {} },
  placementRules: [String],
  enabled: { type: Boolean, default: true }, order: Number,
}, opts);
DeviceLibrarySchema.index({ tenantId: 1, code: 1 }, { unique: true });

export const VersionSchema = new Schema({
  tenantId: { type: oid, required: true },
  floorId: { type: oid, required: true, index: true },
  projectId: { type: oid, required: true },
  number: { type: Number, required: true },
  label: String,
  createdBy: oid,
  snapshot: { placements: [Schema.Types.Mixed], rooms: [Schema.Types.Mixed], zones: [Schema.Types.Mixed] },
  note: String,
}, opts);
VersionSchema.index({ floorId: 1, number: -1 });

export const ExportSchema = new Schema({
  tenantId: { type: oid, required: true },
  projectId: { type: oid, required: true, index: true },
  status: { type: String, enum: ['queued', 'processing', 'done', 'failed'], default: 'queued' },
  jobId: String,
  options: {
    floors: [oid], includeLegend: Boolean, includeSchedule: Boolean, includeAiSummary: Boolean,
    style: { type: String, enum: ['standard', 'detailed'], default: 'standard' },
    clientName: String, preparedBy: String, notes: String, versionName: String,
  },
  s3Key: String, pages: Number, sizeBytes: Number, error: String, finishedAt: Date,
  createdBy: oid,
}, opts);

/** target.id = entity/job id (string); target.key = setting key when type is "setting". */
export const AnalysisRunSchema = new Schema({
  tenantId: { type: oid, required: true, index: true },
  projectId: { type: oid, required: true, index: true },
  floorId: { type: oid, required: true, index: true },
  kind: { type: String, enum: ['full_analysis', 'rules_resuggest'], required: true },
  status: { type: String, enum: ['running', 'done', 'failed'], default: 'running' },
  jobId: String,
  triggeredBy: oid,
  provider: {
    type: String,
    enum: ['cv', 'openai', 'claude', 'gemini', 'hybrid', 'rules'],
    required: true,
  },
  modelName: String,
  fallbackChain: { type: [String], default: [] },
  qcSettings: { type: Schema.Types.Mixed, default: {} },
  startedAt: { type: Date, required: true, default: Date.now },
  finishedAt: Date,
  durationMs: Number,
  detectedSpaces: { type: Number, default: 0 },
  acceptedSpaces: { type: Number, default: 0 },
  rejectedSpaces: { type: Number, default: 0 },
  acceptedDevices: { type: Number, default: 0 },
  rejectedDevices: { type: Number, default: 0 },
  qcSummary: { type: Schema.Types.Mixed },
  errors: { type: [String], default: [] },
  warnings: { type: [String], default: [] },
}, opts);
AnalysisRunSchema.index({ floorId: 1, startedAt: -1 });
AnalysisRunSchema.index({ tenantId: 1, startedAt: -1 });

export const AuditLogSchema = new Schema({
  tenantId: { type: oid, required: true, index: true },
  actorId: oid,
  action: { type: String, required: true },
  target: {
    type: { type: String },
    id: { type: String },
    key: { type: String },
  },
  diff: { before: Schema.Types.Mixed, after: Schema.Types.Mixed },
  ip: String, userAgent: String,
  at: { type: Date, default: Date.now },
}, { timestamps: false });
AuditLogSchema.index({ tenantId: 1, at: -1 });

export const SettingSchema = new Schema({
  scope: { type: String, enum: ['system', 'tenant'] },
  tenantId: oid,
  key: { type: String, required: true },
  value: Schema.Types.Mixed,
}, opts);

[TenantSchema, UserSchema, ProjectSchema, FloorSchema, PlanAssetSchema, DetectedRoomSchema,
 DetectedZoneSchema, PlacementSchema, LayerSchema, DeviceLibrarySchema, VersionSchema,
 ExportSchema, SettingSchema].forEach(softDelete);

export const MODELS = {
  Tenant: 'Tenant', User: 'User', RefreshSession: 'RefreshSession', Project: 'Project',
  Floor: 'Floor', PlanAsset: 'PlanAsset', DetectedRoom: 'DetectedRoom', DetectedZone: 'DetectedZone',
  Placement: 'Placement', Layer: 'Layer', DeviceLibrary: 'DeviceLibrary', Version: 'Version',
  Export: 'Export', AuditLog: 'AuditLog', Setting: 'Setting', AnalysisRun: 'AnalysisRun',
} as const;

export const MONGOOSE_MODELS = [
  { name: MODELS.Tenant, schema: TenantSchema },
  { name: MODELS.User, schema: UserSchema },
  { name: MODELS.RefreshSession, schema: RefreshSessionSchema },
  { name: MODELS.Project, schema: ProjectSchema },
  { name: MODELS.Floor, schema: FloorSchema },
  { name: MODELS.PlanAsset, schema: PlanAssetSchema },
  { name: MODELS.DetectedRoom, schema: DetectedRoomSchema },
  { name: MODELS.DetectedZone, schema: DetectedZoneSchema },
  { name: MODELS.Placement, schema: PlacementSchema },
  { name: MODELS.Layer, schema: LayerSchema },
  { name: MODELS.DeviceLibrary, schema: DeviceLibrarySchema },
  { name: MODELS.Version, schema: VersionSchema },
  { name: MODELS.Export, schema: ExportSchema },
  { name: MODELS.AuditLog, schema: AuditLogSchema },
  { name: MODELS.Setting, schema: SettingSchema },
  { name: MODELS.AnalysisRun, schema: AnalysisRunSchema },
];
