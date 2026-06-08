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

// ── Diagnostics: on a failing request, print the REAL backend response + full context ──
type Diag = { payload?: unknown; projectId?: string; floorId?: string; role?: string };
function dump(res: any, label: string, ctx: Diag = {}) {
  const req = res?.req ?? {};
  const lines = [
    `\n──────── ${label} ────────`,
    `  request : ${req.method ?? '?'} ${req.path ?? req.url ?? '?'}`,
    `  status  : ${res?.status}`,
    `  body    : ${JSON.stringify(res?.body)}`,
  ];
  if ((!res?.body || Object.keys(res.body).length === 0) && res?.text) lines.push(`  text    : ${res.text}`);
  if (ctx.payload !== undefined) lines.push(`  payload : ${JSON.stringify(ctx.payload)}`);
  if (ctx.role) lines.push(`  role    : ${ctx.role}`);
  if (ctx.projectId) lines.push(`  project : ${ctx.projectId}`);
  if (ctx.floorId) lines.push(`  floor   : ${ctx.floorId}`);
  // eslint-disable-next-line no-console
  console.error(lines.join('\n'));
}
function expectOk(res: any, label: string, ctx?: Diag) {
  if (!ok(res?.status)) dump(res, label, ctx);
  expect(ok(res?.status)).toBe(true);
}
function expectStatusIn(res: any, allowed: number[], label: string, ctx?: Diag) {
  if (!allowed.includes(res?.status)) dump(res, label, ctx);
  expect(allowed).toContain(res?.status);
}
function expectStatus(res: any, code: number, label: string, ctx?: Diag) {
  if (res?.status !== code) dump(res, label, ctx);
  expect(res?.status).toBe(code);
}

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
  const createdProjectIds: string[] = [];   // extra projects the workflow test creates (cleaned via tenantId)

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
        const add = await request(API!).post(`/projects/${projectId}/members`).set(auth(owner.token))
          .send({ userId: String(u?._id), role });
        // eslint-disable-next-line no-console
        console.error(`  seed member ${role}: userId=${u?._id} addStatus=${add.status} members=${JSON.stringify(add.body?.members ?? add.body)}`);
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
    const payload = { upserts: [newDevice('WIFI_AP', 0.5, 0.5)], deletes: [] };
    const res = await request(API!).patch(`/floors/${floor1}/placements`).set(auth(outsider.token)).send(payload);
    expectStatusIn(res, [403, 404], 'outsider WRITE placements', { payload, floorId: floor1, projectId, role: 'outsider' });
  });

  test('owner can read + write', async () => {
    const read = await request(API!).get(`/floors/${floor1}/placements`).set(auth(owner.token));
    expectStatus(read, 200, 'owner READ placements', { floorId: floor1, projectId, role: 'owner' });
    const payload = { upserts: [newDevice('WIFI_AP', 0.4, 0.4)], deletes: [] };
    const w = await request(API!).patch(`/floors/${floor1}/placements`).set(auth(owner.token)).send(payload);
    expectOk(w, 'owner WRITE placements', { payload, floorId: floor1, projectId, role: 'owner' });
  });

  // ── role-graded membership (needs MONGO_URI to seed members) ──
  (MONGO ? test : test.skip)('viewer can READ but not WRITE', async () => {
    const read = await request(API!).get(`/floors/${floor1}/placements`).set(auth(roleTokens.viewer));
    expectStatus(read, 200, 'viewer READ placements', { floorId: floor1, projectId, role: 'viewer' });
    const payload = { upserts: [newDevice('SENSOR', 0.3, 0.3)], deletes: [] };
    const w = await request(API!).patch(`/floors/${floor1}/placements`).set(auth(roleTokens.viewer)).send(payload);
    expectStatus(w, 403, 'viewer WRITE placements (must be 403)', { payload, floorId: floor1, projectId, role: 'viewer' });
  });

  (MONGO ? test : test.skip)('editor can WRITE', async () => {
    const payload = { upserts: [newDevice('SPEAKER', 0.2, 0.2)], deletes: [] };
    const w = await request(API!).patch(`/floors/${floor1}/placements`).set(auth(roleTokens.editor)).send(payload);
    expectOk(w, 'editor WRITE placements', { payload, floorId: floor1, projectId, role: 'editor' });
  });

  (MONGO ? test : test.skip)('editor cannot change status; manager drives the full lifecycle chain', async () => {
    // editor lacks the project 'manager' role → any status change is forbidden
    const e = await request(API!).patch(`/projects/${projectId}/status`).set(auth(roleTokens.editor)).send({ status: 'in_progress' });
    expectStatus(e, 403, 'editor STATUS (must be 403)', { payload: { status: 'in_progress' }, projectId, role: 'editor' });
    // manager walks the REAL chain in order — no shortcuts (project starts at 'draft')
    for (const status of ['in_progress', 'review', 'approved', 'exported', 'delivered']) {
      const m = await request(API!).patch(`/projects/${projectId}/status`).set(auth(roleTokens.manager)).send({ status });
      expectOk(m, `manager STATUS → ${status}`, { payload: { status }, projectId, role: 'manager' });
    }
  });

  // ── H2: batch save floor-scoping ──
  test('batch on floor1 cannot delete floor2 placements', async () => {
    const payload = { upserts: [newDevice('SENSOR', 0.6, 0.6)], deletes: [] };
    const wrote = await request(API!).patch(`/floors/${floor2}/placements`).set(auth(owner.token)).send(payload);
    expectOk(wrote, 'owner WRITE on floor2', { payload, floorId: floor2, projectId, role: 'owner' });
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

  // ── batch insert/update integrity (the _id:null regression) ──
  test('batch inserts multiple NEW placements and updates an existing one (no _id collision)', async () => {
    const f = await request(API!).post(`/projects/${projectId}/floors`).set(auth(owner.token)).send({ name: 'Batch', level: 9 });
    const fid = f.body._id ?? f.body.id;
    expect(fid).toBeTruthy();
    // insert THREE new placements in one batch — each must get its own _id (no dup-key 500)
    const multi = { upserts: [newDevice('WIFI_AP', 0.1, 0.1), newDevice('SENSOR', 0.2, 0.2), newDevice('SPEAKER', 0.3, 0.3)], deletes: [] };
    const ins = await request(API!).patch(`/floors/${fid}/placements`).set(auth(owner.token)).send(multi);
    expectOk(ins, 'batch insert x3', { payload: multi, floorId: fid, role: 'owner' });
    const list = await request(API!).get(`/floors/${fid}/placements`).set(auth(owner.token));
    const arr = list.body.placements ?? list.body;
    expect(arr.length).toBe(3);
    // update ONE existing placement by its real id — count must stay 3 (no new doc), pos changes
    const target = arr[0];
    const tid = target.id ?? target._id;
    const upd = { upserts: [{ id: tid, deviceCode: target.deviceCode, position: { x: 0.9, y: 0.9 }, rotation: 0, scale: 1 }], deletes: [] };
    const u = await request(API!).patch(`/floors/${fid}/placements`).set(auth(owner.token)).send(upd);
    expectOk(u, 'batch update existing', { payload: upd, floorId: fid, role: 'owner' });
    const list2 = await request(API!).get(`/floors/${fid}/placements`).set(auth(owner.token));
    const arr2 = list2.body.placements ?? list2.body;
    expect(arr2.length).toBe(3);                                   // updated in place, not inserted
    const moved = arr2.find((p: any) => (p.id ?? p._id) === tid);
    expect(moved?.position).toMatchObject({ x: 0.9, y: 0.9 });
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

  // ── workflow lifecycle (own fresh project → order-independent of the role test above) ──
  test('create → in_progress → review → approved → exported → delivered; invalid shortcut rejected', async () => {
    const p = await request(API!).post('/projects').set(auth(owner.token)).send({ name: `QA ${RUN} wf` });
    const pid = p.body._id ?? p.body.id;
    expect(pid).toBeTruthy();
    createdProjectIds.push(pid);
    // the REAL chain, in order
    for (const status of ['in_progress', 'review', 'approved', 'exported', 'delivered']) {
      const res = await request(API!).patch(`/projects/${pid}/status`).set(auth(owner.token)).send({ status });
      expectOk(res, `workflow STATUS → ${status}`, { payload: { status }, projectId: pid, role: 'owner' });
    }
    // an impossible shortcut on a fresh project is rejected (draft → delivered)
    const p2 = await request(API!).post('/projects').set(auth(owner.token)).send({ name: `QA ${RUN} wf2` });
    const pid2 = p2.body._id ?? p2.body.id;
    createdProjectIds.push(pid2);
    const bad = await request(API!).patch(`/projects/${pid2}/status`).set(auth(owner.token)).send({ status: 'delivered' });
    expect(bad.status).toBeGreaterThanOrEqual(400);                // draft → delivered has no path
  });
});
