# PlanIQ — Database Schema (MongoDB / Mongoose)

All collections include `createdAt`, `updatedAt` (timestamps) and a soft-delete `deletedAt?`. IDs are Mongo `ObjectId`. Multi-tenancy is enforced by `tenantId` (organization) on every tenant-scoped document and compound indexes lead with it.

Geometry convention: coordinates are stored in a **normalized floor space** `[0..1]` relative to the floor raster (origin top-left). This makes placements resolution-independent and ready for re-rendering, export, and future cable-routing/3D work.

---

## 1. `users`
```ts
{
  _id, tenantId,
  email: string,          // unique per tenant, lowercased
  passwordHash: string,   // argon2id
  name: string,
  globalRole: 'superadmin'|'admin'|'manager'|'editor'|'viewer',
  status: 'active'|'invited'|'suspended',
  avatarKey?: string,     // S3 key
  lastLoginAt?: Date,
  mfa?: { enabled: boolean, secret?: string },
}
// indexes: { tenantId:1, email:1 } unique; { tenantId:1, status:1 }
```

## 2. `tenants` (organizations)
```ts
{
  _id, name, slug: string /*unique*/, plan: 'free'|'pro'|'enterprise',
  settings: { defaultUnits:'m'|'ft', logoKey?:string, brandColor?:string },
  limits: { maxProjects:number, maxStorageMB:number },
}
```

## 3. `refreshSessions`
```ts
{
  _id, userId, tokenHash: string /*sha256 of refresh token*/,
  userAgent, ip, expiresAt: Date, revokedAt?: Date,
}
// TTL index on expiresAt; index { userId:1 }
```

## 4. `projects`
```ts
{
  _id, tenantId, name, code?: string,
  client: { name?:string, contact?:string, phone?:string, email?:string, address?:string },
  description?: string,
  status: 'draft'|'in_progress'|'review'|'delivered'|'archived',
  units: 'm'|'ft',
  ownerId: ObjectId,
  members: [{ userId, role:'manager'|'editor'|'viewer', addedAt }],
  cover?: { assetKey?:string },
  stats: { floors:number, devices:number, lastExportAt?:Date },
}
// indexes: { tenantId:1, status:1 }; { tenantId:1, 'members.userId':1 }; text on name/code
```

## 5. `floors`
A floor = one page/level of a plan (Site Plan, Ground, First, Roof…).
```ts
{
  _id, tenantId, projectId,
  name: string,              // "Ground Floor"
  level: number,             // ordering: site=-1, ground=0, first=1, roof=99
  kind: 'site'|'ground'|'first'|'second'|'roof'|'basement'|'other',
  raster: {                  // chosen display image (from upload/analysis)
    assetId: ObjectId, key:string, width:number, height:number, dpi?:number
  },
  scale?: { metersPerPixel?:number, calibrated:boolean },
  analysis: {
    status:'none'|'queued'|'processing'|'done'|'failed',
    jobId?:string, version?:number, confidence?:number, error?:string, finishedAt?:Date
  },
  counts: { rooms:number, placements:number },
}
// indexes: { projectId:1, level:1 }; { tenantId:1, projectId:1 }
```

## 6. `planAssets`
Every uploaded/derived file.
```ts
{
  _id, tenantId, projectId, floorId?,
  kind:'source'|'page_raster'|'export'|'thumbnail',
  originalName?:string, mime:string, ext:'pdf'|'png'|'jpg'|'jpeg'|'dwg',
  s3Key:string, sizeBytes:number, checksum?:string,
  page?:number, width?:number, height?:number,
  status:'pending'|'uploaded'|'scanned'|'rejected',
  scan?: { clean:boolean, engine?:string, at?:Date },
}
// indexes: { projectId:1, kind:1 }; unique { s3Key:1 }
```

## 7. `detectedRooms`  (CV output, editable)
```ts
{
  _id, tenantId, floorId,
  label: string,             // normalized: 'master_bedroom','majlis','kitchen'...
  rawLabel?: string,         // OCR text as-found
  type: RoomType,            // enum (see shared/space-types)
  polygon: [[x,y]...],       // normalized vertices
  centroid: [x,y],
  area: number,              // normalized area
  confidence: number,        // 0..1
  source: 'cv'|'manual',
  reviewed: boolean,
}
// indexes: { floorId:1 }
```

## 8. `detectedZones`  (outdoor/structural areas)
```ts
{
  _id, tenantId, floorId,
  type:'gate'|'parking'|'garden'|'driveway'|'entrance'|'wall'|'staircase'|'lift'|'outdoor',
  geometry: { kind:'point'|'line'|'polygon', coords: number[][] },
  confidence:number, source:'cv'|'manual',
}
```

## 9. `placements`  (devices on the canvas — the heart of the editor)
```ts
{
  _id, tenantId, floorId, projectId,
  deviceTypeId: ObjectId,    // → deviceLibrary
  deviceCode: string,        // denormalized: 'CCTV','WIFI_AP','ELV_RACK'...
  label?: string,            // user override / auto e.g. "CAM-01"
  position: { x:number, y:number },   // normalized
  rotation: number,          // degrees
  scale: number,             // icon scale multiplier
  layerId?: ObjectId,
  groupId?: string,          // client-generated group key
  locked: boolean,
  hidden: boolean,
  source: 'ai'|'manual',
  reviewed: boolean,         // user accepted AI suggestion
  rationale?: string,        // why the rule engine placed it (audit/help)
  props: Record<string,any>, // device-specific (mountHeight, model, coverageRadius…)
  meta: Record<string,any>,  // reserved: BOQ/pricing/cable nodes
  zIndex: number,
}
// indexes: { floorId:1 }; { projectId:1, deviceCode:1 }
```

## 10. `layers`
```ts
{ _id, tenantId, floorId, name:string, color?:string, order:number, visible:boolean, locked:boolean }
// default layers seeded per floor: CCTV, Network/WiFi, ELV, Smart Home, Annotations
```

## 11. `deviceLibrary`  (catalog — seeded, tenant-overridable)
```ts
{
  _id, tenantId?: ObjectId|null,  // null = global default catalog
  code: string,                   // 'CCTV','WIFI_AP','ELV_RACK','INTERCOM_SCREEN'...
  name: string,
  category: 'cctv'|'network'|'elv'|'smart_home'|'audio'|'access'|'annotation',
  iconKey: string,                // S3/static svg key
  color: string,                  // legend color (#E11D2A style red from sample)
  defaultProps: Record<string,any>,// mountHeight, coverageRadius, fov, power…
  placementRules: string[],       // rule ids this device participates in
  enabled: boolean, order:number,
}
// indexes: { tenantId:1, code:1 } unique (null tenant = global)
```

## 12. `versions`  (immutable floor snapshots)
```ts
{
  _id, tenantId, floorId, projectId,
  number: number,            // monotonically increasing per floor
  label?: string,            // "Client review v2"
  createdBy: ObjectId,
  snapshot: {
    placements: Placement[],  // full embedded copy
    rooms: DetectedRoom[],
    zones: DetectedZone[],
  },
  note?: string,
}
// indexes: { floorId:1, number:-1 }
```

## 13. `exports`
```ts
{
  _id, tenantId, projectId,
  status:'queued'|'processing'|'done'|'failed',
  jobId:string, options: { floors:ObjectId[], includeLegend:boolean, includeSchedule:boolean, notes?:string },
  s3Key?:string, pages?:number, sizeBytes?:number, error?:string, finishedAt?:Date,
  createdBy: ObjectId,
}
```

## 14. `auditLogs`
```ts
{
  _id, tenantId, actorId, action:string /*'placement.update'*/,
  target: { type:string, id:ObjectId },
  diff?: { before?:any, after?:any },
  ip?:string, userAgent?:string, at:Date,
}
// TTL/retention configurable; index { tenantId:1, at:-1 }; { 'target.id':1 }
```

## 15. `settings` (tenant + system)
```ts
{ _id, scope:'system'|'tenant', tenantId?, key:string, value:any }
// e.g. ai.fallbackProvider='disabled', export.brand, rules.* overrides
```

---

## Relationships (ER summary)
```
tenant 1─* users
tenant 1─* projects 1─* floors 1─* placements *─1 deviceLibrary
                         floors 1─* detectedRooms / detectedZones / layers / versions
project 1─* planAssets / exports
user   1─* refreshSessions
* ─ auditLogs (polymorphic target)
```

## Indexing & integrity notes
- Compound indexes always lead with `tenantId` for tenant isolation + query performance.
- Soft delete via `deletedAt`; a global Mongoose query middleware filters it out by default.
- Version snapshots are **fully embedded** (not referenced) so a restore is deterministic even if the library changes.
- Transactions (replica set) wrap multi-doc operations: create-floor-with-layers, snapshot-version, batch placement upsert.
