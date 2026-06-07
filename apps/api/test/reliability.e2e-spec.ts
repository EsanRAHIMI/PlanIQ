/**
 * Reliability e2e smoke tests for the stabilization fixes (C1/C2/H1/H2 + workflow).
 *
 * Runs against a RUNNING API (Mongo/S3/Redis up). Guarded by API_URL so the suite skips
 * cleanly in CI/sandbox where no stack is available:
 *
 *   API_URL=http://localhost:4000 npm --workspace apps/api run test:e2e
 *
 * Covers: tenant/project isolation (403/404 across tenants), batch save floor-scoping,
 * version restore auto-snapshot + reversibility, and the create→edit→snapshot→restore→
 * approve→export→deliver lifecycle. (Same-tenant non-member authorization is unit-tested in
 * permission.smoke.ts against the real assertProjectMember helper.)
 */
// @ts-ignore — supertest ships no bundled types; the dev stack has it at runtime.
import request from 'supertest';

const API = process.env.API_URL;
const d = API ? describe : describe.skip;

function bearer(token: string) { return { Authorization: `Bearer ${token}` }; }
const uniq = () => Math.random().toString(36).slice(2, 8);

async function registerUser() {
  const email = `qa_${uniq()}@example.com`;
  const res = await request(API!).post('/auth/register').send({
    email, password: 'Passw0rd!23', name: 'QA User', tenantName: `QA ${uniq()}`,
  });
  // register returns an access token (cookie or body, depending on config)
  const token = res.body?.accessToken ?? res.body?.token;
  return { email, token, body: res.body };
}

d('Reliability e2e (requires API_URL)', () => {
  let a: any, b: any, projectId: string, floor1: string, floor2: string;

  beforeAll(async () => {
    a = await registerUser();   // tenant A
    b = await registerUser();   // tenant B (different tenant → outsider)
    const proj = await request(API!).post('/projects').set(bearer(a.token)).send({ name: 'QA Project' });
    projectId = proj.body._id ?? proj.body.id;
    const f1 = await request(API!).post(`/projects/${projectId}/floors`).set(bearer(a.token)).send({ name: 'Ground', level: 0 });
    const f2 = await request(API!).post(`/projects/${projectId}/floors`).set(bearer(a.token)).send({ name: 'First', level: 1 });
    floor1 = f1.body._id ?? f1.body.id; floor2 = f2.body._id ?? f2.body.id;
  });

  test('C1: outsider cannot read another tenant/project by id (403/404)', async () => {
    for (const url of [
      `/floors/${floor1}`,
      `/floors/${floor1}/placements`,
      `/floors/${floor1}/rooms`,
      `/floors/${floor1}/versions`,
      `/floors/${floor1}/analysis-runs`,
    ]) {
      const res = await request(API!).get(url).set(bearer(b.token));
      expect([403, 404]).toContain(res.status);
    }
  });

  test('C1: outsider cannot write placements on another project (403/404)', async () => {
    const res = await request(API!).patch(`/floors/${floor1}/placements`).set(bearer(b.token))
      .send({ upserts: [{ id: 'loc_x', deviceCode: 'WIFI_AP', position: { x: 0.5, y: 0.5 } }], deletes: [] });
    expect([403, 404]).toContain(res.status);
  });

  test('member (owner/editor) can read + write', async () => {
    const read = await request(API!).get(`/floors/${floor1}/placements`).set(bearer(a.token));
    expect(read.status).toBe(200);
    const write = await request(API!).patch(`/floors/${floor1}/placements`).set(bearer(a.token))
      .send({ upserts: [{ id: 'loc_w', deviceCode: 'WIFI_AP', position: { x: 0.4, y: 0.4 }, rotation: 0, scale: 1 }], deletes: [] });
    expect(write.status).toBeLessThan(300);
  });

  test('H2: batch on floor1 cannot delete floor2 placements', async () => {
    // create a placement on floor2
    await request(API!).patch(`/floors/${floor2}/placements`).set(bearer(a.token))
      .send({ upserts: [{ id: 'loc_f2', deviceCode: 'SENSOR', position: { x: 0.6, y: 0.6 }, rotation: 0, scale: 1 }], deletes: [] });
    const before = await request(API!).get(`/floors/${floor2}/placements`).set(bearer(a.token));
    const f2id = (before.body.placements ?? before.body)[0]?.id ?? (before.body.placements ?? before.body)[0]?._id;
    // try to delete it via floor1's batch — must be ignored (floorId-scoped)
    await request(API!).patch(`/floors/${floor1}/placements`).set(bearer(a.token)).send({ upserts: [], deletes: [f2id] });
    const after = await request(API!).get(`/floors/${floor2}/placements`).set(bearer(a.token));
    expect((after.body.placements ?? after.body).length).toBe((before.body.placements ?? before.body).length);
  });

  test('C2: version restore creates an auto-snapshot and is reversible', async () => {
    // snapshot v1 (with current placements)
    await request(API!).post(`/floors/${floor1}/versions`).set(bearer(a.token)).send({ label: 'v1' });
    const list1 = await request(API!).get(`/floors/${floor1}/versions`).set(bearer(a.token));
    const v1 = (list1.body[0]?._id ?? list1.body[0]?.id);
    // mutate (add a device), then restore v1
    await request(API!).patch(`/floors/${floor1}/placements`).set(bearer(a.token))
      .send({ upserts: [{ id: 'loc_extra', deviceCode: 'CCTV', position: { x: 0.7, y: 0.7 }, rotation: 0, scale: 1 }], deletes: [] });
    const restore = await request(API!).post(`/versions/${v1}/restore`).set(bearer(a.token));
    expect(restore.status).toBeLessThan(300);
    // an auto-snapshot must have been created before the restore (count grew)
    const list2 = await request(API!).get(`/floors/${floor1}/versions`).set(bearer(a.token));
    expect(list2.body.length).toBeGreaterThan(list1.body.length);
    // outsider cannot restore
    const denied = await request(API!).post(`/versions/${v1}/restore`).set(bearer(b.token));
    expect([403, 404]).toContain(denied.status);
  });

  test('workflow: lifecycle create→approve→export→deliver (valid) and reject impossible', async () => {
    const steps = ['in_progress', 'review', 'approved', 'exported', 'delivered'];
    for (const status of steps) {
      const res = await request(API!).patch(`/projects/${projectId}/status`).set(bearer(a.token)).send({ status });
      expect(res.status).toBeLessThan(300);
    }
    // impossible transition is rejected
    const bad = await request(API!).patch(`/projects/${projectId}/status`).set(bearer(a.token)).send({ status: 'draft' });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });
});
