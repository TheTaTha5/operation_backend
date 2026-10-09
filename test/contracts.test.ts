import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import type { Contract } from '../src/domain/contracts.js';
import { OperationsStore } from '../src/domain/operations.js';
import { buildApp } from '../src/app.js';
import { seedAgents, testStore } from './users-helper.js';

// GET /v1/contracts on whichever store DATABASE_URL selects, seeded as import-contracts writes it.
const store = testStore();
const app = buildApp({ store });
after(async () => app.close());

const base: Omit<Contract, 'id' | 'kind' | 'active_from' | 'active_to' | 'program_periods'> = {
  agent_id: 'ctr_a1', status: 'active', rate_type_id: null, priority: 0, version: 'v2025-1', price_mode: null, discount: null, bonus: null,
  book_window: false, created_date: '2025-10-01', created_by: 'migration', note: null, doc_id: null, voided_at: null, voided_by: null, seat_prices: [],
};
const contracts: Contract[] = [
  { ...base, id: 'ct_main_ctr_a1', kind: 'main', active_from: '2025-10-01', active_to: '2026-09-30',
    program_periods: [
      { route_id: 'r4', book_from: '2025-10-01', book_to: '2026-09-30', travel_from: '2025-10-01', travel_to: '2026-09-30', note: null },
      { route_id: 'r10', book_from: '2025-10-01', book_to: '2026-09-30', travel_from: null, travel_to: null, note: 'archived window' },
    ] },
  { ...base, id: 'ct_hist_ctr_a1_v2024', kind: 'main', status: 'expired', active_from: '2024-10-01', active_to: '2025-09-30', note: 'archived', program_periods: [] },
  { ...base, id: 'ctr_promo1', kind: 'promo', price_mode: 'own', priority: 10, book_window: true, active_from: '2026-10-08', active_to: '2026-10-15',
    created_by: 'SALES.MAM', program_periods: [{ route_id: 'r10', book_from: '2026-10-08', book_to: '2026-10-15', travel_from: '2026-10-08', travel_to: '2026-10-15', note: null }],
    seat_prices: [
      { route_id: 'r10', zone: 'PK', category: 'chd', residency: 'thai', price: 1200 },
      { route_id: 'r10', zone: 'PK', category: 'ad', residency: 'thai', price: 1500 },
    ] },
  { ...base, id: 'ct_main_ctr_a2', agent_id: 'ctr_a2', kind: 'main', active_from: '2025-10-01', active_to: '2026-09-30', program_periods: [] },
];

async function seed(): Promise<void> {
  await seedAgents(store, [], { ctr_a1: null, ctr_a2: null });
  if (store instanceof OperationsStore) { store.seedContracts(contracts); return; }
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    for (const c of contracts) {
      await db.query(`INSERT INTO contracts (id, agent_id, kind, status, rate_type_id, active_from, active_to, priority, version, price_mode, book_window, created_date, created_by, note, doc_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO NOTHING`,
        [c.id, c.agent_id, c.kind, c.status, c.rate_type_id, c.active_from, c.active_to, c.priority, c.version, c.price_mode, c.book_window, c.created_date, c.created_by, c.note, c.doc_id]);
      for (const [seq, p] of c.program_periods.entries()) {
        await db.query('INSERT INTO contract_program_periods VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING', [c.id, seq, p.route_id, p.book_from, p.book_to, p.travel_from, p.travel_to, p.note]);
      }
      for (const p of c.seat_prices) {
        await db.query('INSERT INTO contract_seat_prices VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [c.id, p.route_id, p.zone, p.category, p.residency, p.price]);
      }
    }
  } finally { await db.end(); }
}
const seeded = seed();
const get = async (url: string) => { await seeded; return app.inject({ method: 'GET', url }); };

test('an agent\'s contracts: main before promo, the newest first, each with its periods', async () => {
  const listed = await get('/v1/contracts?agent_id=ctr_a1');
  assert.equal(listed.statusCode, 200, listed.body);
  const list = listed.json().contracts as Contract[];
  assert.deepEqual(list.map((c) => c.id), ['ct_main_ctr_a1', 'ct_hist_ctr_a1_v2024', 'ctr_promo1']);
  assert.deepEqual(list[0].program_periods.map((p) => [p.route_id, p.travel_from]), [['r4', '2025-10-01'], ['r10', null]], 'legacy\'s order, open windows kept');
});

test('one contract, with an own-price promo\'s prices in order', async () => {
  const { state, bonus_progress, ...promo } = (await get('/v1/contracts/ctr_promo1')).json() as Contract & { state: string; bonus_progress: unknown };
  // The badge is legacy's `_ctContractStatus` against today; the promo has no bonus to count.
  assert.ok(['scheduled', 'active', 'expired'].includes(state), state);
  assert.equal(bonus_progress, null);
  assert.deepEqual(promo, {
    ...contracts[2],
    seat_prices: [
      { route_id: 'r10', zone: 'PK', category: 'ad', residency: 'thai', price: 1500 },
      { route_id: 'r10', zone: 'PK', category: 'chd', residency: 'thai', price: 1200 },
    ],
  });
  assert.equal((await get('/v1/contracts/nope')).statusCode, 404);
});

test('filters by kind and status, and refuses an unknown one', async () => {
  assert.deepEqual(((await get('/v1/contracts?agent_id=ctr_a1&kind=promo')).json().contracts as Contract[]).map((c) => c.id), ['ctr_promo1']);
  assert.deepEqual(((await get('/v1/contracts?agent_id=ctr_a1&status=expired')).json().contracts as Contract[]).map((c) => c.id), ['ct_hist_ctr_a1_v2024']);
  assert.equal((await get('/v1/contracts?kind=special')).statusCode, 400);
});
