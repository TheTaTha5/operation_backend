import assert from 'node:assert/strict';
import { after, test } from 'node:test';

// Who may approve (decided 2026-10-08): over the allotment and FOC, an admin or a login with
// `act-approve`; a discount, the agent's salesperson or an admin. Legacy checked no one.
process.env.AUTH_JWT_SECRET = 'approval-rights-test-secret';
const { buildApp } = await import('../src/app.js');
const { seedAgents, seedUser, testStore, tokenFor } = await import('./users-helper.js');
const store = testStore();
const app = buildApp({ store });
after(async () => app.close());

const as = async (username: string, fields: object = {}) => { await seedUser(store, { username, edit_areas: ['operations'], ...fields }); return tokenFor(app, username); };
let admin: { authorization: string };
let boats = 0;
async function waiting(date: string, payload: object): Promise<string> {
  admin ??= await as('rights.admin', { role: 'admin' });
  await app.inject({ method: 'POST', url: '/operations/deployments', headers: admin, payload: { boat_id: `boat-rights-${++boats}`, route_id: 'r3', service_date: date, capacity: 20, license_pax: 25 } });
  const created = await app.inject({ method: 'POST', url: '/v1/bookings', headers: admin, payload: { trips: [{ routeId: 'r3', date, pax: { ad: 2 } }], ...payload } });
  assert.equal(created.statusCode, 201, created.body);
  return created.json().id;
}
const decide = async (headers: { authorization: string }, id: string, command = 'approve') => app.inject({ method: 'POST', url: `/v1/bookings/${id}/${command}`, headers, payload: {} });

test('over the allotment: act-approve or an admin, not any editor', async () => {
  const over = await waiting('2041-02-01', { trips: [{ routeId: 'r3', date: '2041-02-01', pax: { ad: 22 } }] });
  const editor = await as('rights.editor');
  const refused = await decide(editor, over);
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().message, 'Approving over the allotment needs an admin or the act-approve right');
  assert.equal((await decide(editor, over, 'reject')).statusCode, 403, 'rejecting is deciding too');
  const approver = await as('rights.approver', { actions: ['act-approve'] });
  const approved = await decide(approver, over);
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().approvals[0].decided_by, 'rights.approver');
});

test('FOC passengers: act-approve or an admin', async () => {
  const foc = await waiting('2041-02-02', { trips: [{ routeId: 'r3', date: '2041-02-02', pax: { ad: 2, foc: 1 } }], focReason: 'tour leader' });
  assert.equal((await decide(await as('rights.editor2'), foc)).json().message, 'Approving FOC passengers needs an admin or the act-approve right');
  assert.equal((await decide(admin, foc)).statusCode, 200);
});

test('a discount: the agent\'s salesperson or an admin, and act-approve is not enough', async () => {
  await seedAgents(store, ['rights_s1', 'rights_s2'], { rights_a1: 'rights_s1' });
  const discounted = await waiting('2041-02-03', { agent_id: 'rights_a1', adjustments: [{ kind: 'discount', value: 100 }] });
  const approver = await as('rights.approver2', { actions: ['act-approve'] });
  assert.equal((await decide(approver, discounted)).json().message, 'A discount is approved by the agent\'s salesperson or an admin');
  assert.equal((await decide(await as('rights.s2', { sales_id: 'rights_s2' }), discounted)).statusCode, 403, 'another agent\'s salesperson');
  const own = await decide(await as('rights.s1', { sales_id: 'rights_s1' }), discounted);
  assert.equal(own.statusCode, 200, own.body);
});
