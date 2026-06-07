/**
 * Reliability e2e smoke tests for the stabilization fixes (C1/C2/H1/H2 + lifecycle).
 *
 * Runs against a RUNNING dev stack. The suite is self-seeding, idempotent, and only ever
 * creates clearly-marked QA data (tenant name + emails prefixed `qa-e2e-`); it cleans up
 * after itself when MONGO_URI is provided. It never touches real customer data.
 *
 *   # minimum (isolation + workflow + batch + version restore):
 *   API_URL=http://localhost:4000/api/v1 npm --workspace apps/api run test:e2e
 *
 *   # full (adds viewer/editor/manager role checks — needs DB access to seed same-tenant
 *   #       non-admin members, because the API has no "invite user into tenant" endpoint,
 *   #       and registered users are tenant-admins who bypass project membership):
 *   API_URL=http://localhost:4000/api/v1 MONGO_URI=mongodb://localhost:27017/planiq \
 *     npm --workspace apps/api run test:e2e
 *
 * Without API_URL the whole suite skips cleanly (so CI without a stack stays green).
 */
// @ts-ignore — supertest ships no bundled types; the dev stack has it at runtime.
import request from 'supertest';
// @ts-ignore — argon2 + mongoose are runtime deps of the API; used only when MONGO_URI is set.
import * as argon2 from 'argon2';
import mongoose from 'mongoose';
import { UserSchema, TenantSchema } from '../src/db/schemas';

const API = process.env.API_URL;
const MONGO = process.env.MONGO_URI;
const d = API ? describe : describe.skip;
const RUN = `qa-e2e-${Date.now().toString(36)}`;          // unique per run → safe to re-run
const PW = 'Passw0rd!E2E';

function auth(token: string) { return { Authorization: `Bearer ${token}` }; }
const ok = (s: number) => s >= 200 && s < 300;
// A NEW placement as the editor sends it: no `id` (the client strips its local `loc_*` ids;
// the server assigns a real _id on insert). Sending a `loc_*` id would fail the _id cast.
const newDevice = (deviceCode: string, x: number, y: number) =>
  ({ deviceCode, position: { x, y }, rotation: 0, scale: 1 });

async function registerOwner() {
  const res = await request(API!).post('/auth/register').send({
    email: `${RUN}-owner@example.com`, password: PW, name: 'QA Owner', tenantName: `QA ${RUN}`,
  });
  return { token: res.body.accessToken as string, tenantId: res.body.user?.tenantId as string };
}
async function registerOutsider() {
  const res = await request(API!).post('/auth/register').send({
    email: `${RUN}-out@example.com`, password: PW, name: 'QA Outsider', tenantName: `QA ${RUN} OUT`,
  });
  return { token: res.body.accessToken as string, tenantId: res.body.user?.tenantId as string };
}
async function login(email: string) {
  const res = await request(API!).post('/auth/login').send({ email, password: PW });
  return res.body.accessToken as string;
}

d('Reliability e2e (requires API_URL)', () => {
  let conn: mongoose.Connection | undefined;
  let owner: { token: string; tenantId: string };
  let outsider: { token: string };
  let projectId: string, floor1: string, floor2: string;
  const roleTokens: Record<string, string> = {};
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    owner = await registerOwner();
    outsider = await registerOutsider();
    createdTenantIds.push(owner.tenantId);

    // Same-tenant non-admin members (viewer/editor/manager) can only be created in the DB —
    // the API has no invite endpoint and register always mints a tenant-admin.
    if (MONGO) {
      conn = (await mongoose.createConnection(MONGO).asPromise());
      const User = conn.model('User', UserSchema);
      const Tenant = conn.model('Tenant', TenantSchema);
      const t = await Tenant.findById(owner.tenantId).lean();
      if (!t) throw new Error('owner tenant not found in MONGO_URI db — is API_URL pointing at the same stack?');
      const hash = await argon2.hash(PW, { type: argon2.argon2id });
      for (const role of ['viewer', 'editor', 'manager']) {
        await User.create({
          tenantId: owner.tenantId, email: `${RUN}-${role}@example.com`, passwordHash: hash,
          name: `QA ${role}`, globalRole: 'editor', status: 'active',   // non-admin → membership applies
        });
        roleTokens[role] = await login(`${RUN}-${role}@example.com`);
      }
    }

    const proj = await request(API!).post('/projects').set(auth(owner.token)).send({ name: `QA ${RUN}` });
    projectId = proj.body._id ?? proj.body.id;
    if (!projectId) throw new Error(`project create failed (status ${proj.status}): ${JSON.stringify(proj.body)}`);
    const mk = async (name: string, level: number) => {
      const r = await request(API!).post(`/projects/${projectId}/floors`).set(auth(owner.token)).send({ name, level });
      const id = r.body._id ?? r.body.id;
      if (!id) throw new Error(`floor create failed (status ${r.status}): ${JSON.stringify(r.body)}`);
      return id;
    };
    floor1 = await mk('Ground', 0);
    floor2 = await mk('First', 1);

    if (MONGO) {
      // add the seeded users to THIS project with their roles
      for (const role of ['viewer', 'editor', 'manager']) {
        const u = await conn!.model('User').findOne({ email: `${RUN}-${role}@example.com` }).lean<any>();
        await request(API!).post(`/projects/${projectId}/members`).set(auth(owner.token))
          .send({ userId: String(u._id), role });
      }
    }
  }, 30000);

  afterAll(async () => {
    // Clean up ALL data created by this run (only qa-e2e tenants). Requires MONGO_URI.
    if (conn) {
      const db: any = conn.db;
      const oids = createdTenantIds.map((id) => new mongoose.Types.ObjectId(id));
      for (const col of ['users', 'tenants', 'projects', 'floors', 'placements', 'detectedrooms',
        'detectedzones', 'versions', 'analysisruns', 'layers', 'planassets']) {
        await db.collection(col).deleteMany({ $or: [{ tenantId: { $in: oids } }, { _id: { $in: oids } }] }).catch(() => {});
      }
      // outsider tenant + any stray users by this run's email prefix
      await db.collection('users').deleteMany({ email: { $regex: `^${RUN}-` } }).catch(() => {});
      await db.collection('tenants').deleteMany({ name: { $regex: `^QA ${RUN}` } }).catch(() => {});
      await conn.close();
    }
  }, 20000);

  // ── C1: tenant/project isolation ──
  test('outsider cannot READ another tenant/project by id (403/404)', async () => {
    for (const url of [
      `/floors/${floor1}`, `/floors/${floor1}/placements`, `/floors/${floor1}/rooms`,
      `/floors/${floor1}/versions`, `/floors/${floor1}/analysis-runs`,
    ]) {
      const res = await request(API!).get(url).set(auth(outsider.token));
      expect([403, 404]).toContain(res.status);
    }
  });

  test('outsider cannot WRITE placements on another project (403/404)', async () => {
    const res = await request(API!).patch(`/floors/${floor1}/placements`).set(auth(outsider.token))
      .send({ upserts: [newDevice('WIFI_AP', 0.5, 0.5)], deletes: [] });
    expect([403, 404]).toContain(res.status);
  });

  test('owner can read + write', async () => {
    expect((await request(API!).get(`/floors/${floor1}/placements`).set(auth(owner.token))).status).toBe(200);
    const w = await request(API!).patch(`/floors/${floor1}/placements`).set(auth(owner.token))
      .send({ upserts: [newDevice('WIFI_AP', 0.4, 0.4)], deletes: [] });
    expect(ok(w.status)).toBe(true);
  });

  // ── role-graded membership (needs MONGO_URI to seed members) ──
  (MONGO ? test : test.skip)('viewer can READ but not WRITE', async () => {
    expect((await request(API!).get(`/floors/${floor1}/placements`).set(auth(roleTokens.viewer))).status).toBe(200);
    const w = await request(API!).patch(`/floors/${floor1}/placements`).set(auth(roleTokens.viewer))
      .send({ upserts: [newDevice('SENSOR', 0.3, 0.3)], deletes: [] });
    expect(w.status).toBe(403);
  });

  (MONGO ? test : test.skip)('editor can WRITE', async () => {
    const w = await request(API!).patch(`/floors/${floor1}/placements`).set(auth(roleTokens.editor))
      .send({ upserts: [newDevice('SPEAKER', 0.2, 0.2)], deletes: [] });
    expect(ok(w.status)).toBe(true);
  });

  (MONGO ? test : test.skip)('editor cannot approve; manager can approve/deliver', async () => {
    const e = await request(API!).patch(`/projects/${projectId}/status`).set(auth(roleTokens.editor)).send({ status: 'approved' });
    expect(e.status).toBe(403);
    for (const status of ['approved', 'exported', 'delivered']) {
      const m = await request(API!).patch(`/projects/${projectId}/status`).set(auth(roleTokens.manager)).send({ status });
      expect(ok(m.status)).toBe(true);
    }
  });

  // ── H2: batch save floor-scoping ──
  test('batch on floor1 cannot delete floor2 placements', async () => {
    const wrote = await request(API!).patch(`/floors/${floor2}/placements`).set(auth(owner.token))
      .send({ upserts: [newDevice('SENSOR', 0.6, 0.6)], deletes: [] });
    expect(ok(wrote.status)).toBe(true);                      // write must actually succeed
    const before = await request(API!).get(`/floors/${floor2}/placements`).set(auth(owner.token));
    const arr = before.body.placements ?? before.body;
    const f2id = arr[0]?.id ?? arr[0]?._id;
    expect(f2id).toBeTruthy();                                // a real server-assigned id exists
    await request(API!).patch(`/floors/${floor1}/placements`).set(auth(owner.token)).send({ upserts: [], deletes: [f2id] });
    const after = await request(API!).get(`/floors/${floor2}/placements`).set(auth(owner.token));
    const afterArr = after.body.placements ?? after.body;
    expect(afterArr.length).toBe(arr.length);                 // floor2's device is untouched
    expect((afterArr).some((p: any) => (p.id ?? p._id) === f2id)).toBe(true);
  });

  // ── C2: version restore ──
  test('version restore creates an auto-snapshot; outsider cannot restore', async () => {
    await request(API!).post(`/floors/${floor1}/versions`).set(auth(owner.token)).send({ label: 'v1' });
    const list1 = await request(API!).get(`/floors/${floor1}/versions`).set(auth(owner.token));
    const v1 = list1.body[0]?._id ?? list1.body[0]?.id;
    await request(API!).patch(`/floors/${floor1}/placements`).set(auth(owner.token))
      .send({ upserts: [newDevice('CCTV', 0.7, 0.7)], deletes: [] });
    const r = await request(API!).post(`/versions/${v1}/restore`).set(auth(owner.token));
    expect(ok(r.status)).toBe(true);
    const list2 = await request(API!).get(`/floors/${floor1}/versions`).set(auth(owner.token));
    expect(list2.body.length).toBeGreaterThan(list1.body.length);          // auto-snapshot before restore
    const denied = await request(API!).post(`/versions/${v1}/restore`).set(auth(outsider.token));
    expect([403, 404]).toContain(denied.status);
  });

  // ── workflow lifecycle ──
  test('create → approve → export → deliver works; impossible transition rejected', async () => {
    for (const status of ['in_progress', 'review', 'approved', 'exported', 'delivered']) {
      const res = await request(API!).patch(`/projects/${projectId}/status`).set(auth(owner.token)).send({ status });
      expect(ok(res.status)).toBe(true);
    }
    const bad = await request(API!).patch(`/projects/${projectId}/status`).set(auth(owner.token)).send({ status: 'draft' });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });
});
