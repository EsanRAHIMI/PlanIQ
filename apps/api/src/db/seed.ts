/**
 * Seed script: global device library + a demo tenant/user + sample project with floors,
 * detected rooms/zones, and AI-suggested placements (so the editor has data on first run).
 * Run: pnpm --filter @planiq/api seed
 */
import mongoose from 'mongoose';
import * as argon2 from 'argon2';
import config from '../config/configuration';
import { MONGOOSE_MODELS } from './schemas';
import { DEVICE_LIBRARY, DEFAULT_LAYERS, suggestPlacements, type Room, type Zone } from '@planiq/shared';

async function run() {
  const cfg = config();
  await mongoose.connect(cfg.mongoUri);
  const M = Object.fromEntries(MONGOOSE_MODELS.map((m) => [m.name, mongoose.model(m.name, m.schema)]));

  // 1) Global device catalog (idempotent upsert).
  for (const d of DEVICE_LIBRARY) {
    await M.DeviceLibrary.updateOne(
      { tenantId: null, code: d.code },
      { $set: { ...d, tenantId: null, enabled: true } },
      { upsert: true },
    );
  }
  console.log(`Seeded ${DEVICE_LIBRARY.length} device types.`);

  // 2) Demo tenant + admin user.
  let tenant = await M.Tenant.findOne({ slug: 'demo' });
  if (!tenant) tenant = await M.Tenant.create({ name: 'Demo Co', slug: 'demo', plan: 'pro' });
  const email = 'demo@planiq.app';
  let user = await M.User.findOne({ email });
  if (!user) {
    user = await M.User.create({
      tenantId: tenant._id, email, name: 'Demo Admin', globalRole: 'admin',
      passwordHash: await argon2.hash('Password123!', { type: argon2.argon2id }),
    });
    console.log(`Created demo user: ${email} / Password123!`);
  }

  // 3) Sample project + a ground floor with mock rooms/zones, then rule-engine placements.
  let project = await M.Project.findOne({ tenantId: tenant._id, code: 'VILLA-001' });
  if (!project) {
    project = await M.Project.create({
      tenantId: tenant._id, name: 'Proposed Villa (G+1)', code: 'VILLA-001', ownerId: user._id,
      client: { name: 'Al Habtoor Residence', contact: 'Eng. Khalid', phone: '+971 50 000 0000', address: 'Dubai, UAE' },
      status: 'in_progress',
    });
  }

  const sampleRooms: Room[] = [
    { label: 'Majlis', type: 'majlis', polygon: [[0.1, 0.1], [0.45, 0.1], [0.45, 0.45], [0.1, 0.45]], centroid: [0.27, 0.27], area: 0.12, confidence: 0.86, source: 'cv' },
    { label: 'Living Room', type: 'living_room', polygon: [[0.5, 0.1], [0.9, 0.1], [0.9, 0.5], [0.5, 0.5]], centroid: [0.7, 0.3], area: 0.16, confidence: 0.82, source: 'cv' },
    { label: 'Master Bedroom', type: 'master_bedroom', polygon: [[0.5, 0.55], [0.85, 0.55], [0.85, 0.9], [0.5, 0.9]], centroid: [0.67, 0.72], area: 0.12, confidence: 0.8, source: 'cv' },
    { label: 'Kitchen', type: 'kitchen', polygon: [[0.1, 0.5], [0.35, 0.5], [0.35, 0.75], [0.1, 0.75]], centroid: [0.22, 0.62], area: 0.06, confidence: 0.78, source: 'cv' },
    { label: 'Service Area', type: 'service_area', polygon: [[0.1, 0.78], [0.3, 0.78], [0.3, 0.92], [0.1, 0.92]], centroid: [0.2, 0.85], area: 0.03, confidence: 0.7, source: 'cv' },
    { label: 'Entrance', type: 'entrance', polygon: [[0.4, 0.85], [0.5, 0.85], [0.5, 0.95], [0.4, 0.95]], centroid: [0.45, 0.9], area: 0.01, confidence: 0.75, source: 'cv' },
  ];
  const sampleZones: Zone[] = [
    { type: 'gate', geometry: { kind: 'point', coords: [[0.45, 0.98]] }, confidence: 0.8, source: 'cv' },
    { type: 'parking', geometry: { kind: 'polygon', coords: [[0.6, 0.9], [0.95, 0.9], [0.95, 1.0], [0.6, 1.0]] }, confidence: 0.72, source: 'cv' },
  ];

  let floor = await M.Floor.findOne({ projectId: project._id, level: 0 });
  if (!floor) {
    floor = await M.Floor.create({
      tenantId: tenant._id, projectId: project._id, name: 'Ground Floor', kind: 'ground', level: 0,
      raster: { width: 1200, height: 900 },
    });
    await M.Layer.insertMany(DEFAULT_LAYERS.map((l, i) => ({ tenantId: tenant._id, floorId: floor._id, name: l.name, color: l.color, order: i, visible: true })));
    await M.DetectedRoom.insertMany(sampleRooms.map((r) => ({ ...r, tenantId: tenant._id, floorId: floor._id })));
    await M.DetectedZone.insertMany(sampleZones.map((z) => ({ ...z, tenantId: tenant._id, floorId: floor._id })));

    const placements = suggestPlacements(sampleRooms, sampleZones);
    await M.Placement.insertMany(placements.map((p) => ({ ...p, _id: undefined, tenantId: tenant._id, floorId: floor._id, projectId: project._id })));
    floor.counts = { rooms: sampleRooms.length, placements: placements.length };
    floor.analysis = { status: 'done', confidence: 0.8, version: 1, finishedAt: new Date() };
    await floor.save();
    await M.Project.updateOne({ _id: project._id }, { 'stats.floors': 1, 'stats.devices': placements.length });
    console.log(`Seeded sample floor with ${placements.length} rule-based placements.`);
  }

  console.log('Seed complete.');
  await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
