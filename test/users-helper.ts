import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { OperationsStore } from '../src/domain/operations.js';
import type { StoredAgent } from '../src/domain/agents.js';
import { hashPassword, type NewUser, type StoredUser } from '../src/domain/users.js';
import { createStore, type Store } from '../src/routes/operations.js';

/**
 * Logins for tests, in whichever store the run uses (`DATABASE_URL`). The PostgreSQL suite shares one
 * database across files, so every file names its users and agents with its own prefix.
 */
export const testStore = (): Store => createStore();

export async function seedUser(store: Store, fields: Partial<NewUser> & { username: string; password?: string }): Promise<StoredUser> {
  const { password = 'pw', ...rest } = fields;
  const existing = await store.userByUsername(rest.username);
  const user: NewUser = {
    pass_hash: hashPassword(password), name: rest.username, role: 'staff', can_edit: true, edit_areas: null, actions: [], view_perms: null,
    sales_id: null, agent_id: null, dept: null, disabled_at: null, tokens_valid_after: null, legacy_id: null, ...rest,
  };
  // A rerun against the same database replaces the user it left behind.
  if (existing) {
    const { username: _u, legacy_id: _l, ...patch } = user;
    return (await store.updateUser(existing.id, patch))!;
  }
  return store.transaction(async () => store.createUser(user));
}

export async function tokenFor(app: FastifyInstance, username: string, password = 'pw'): Promise<{ authorization: string }> {
  const login = await app.inject({ method: 'POST', url: '/v1/login', payload: { username, password } });
  if (login.statusCode !== 200) throw new Error(`login as ${username} failed: ${login.body}`);
  return { authorization: `Bearer ${login.json().access_token}` };
}

export const blankAgent = (id: string, sales_id: string | null): StoredAgent => ({
  id, code: null, name: id, market_id: null, sub_market: null, sales_id, color: null, pay_type: null, vat_mode: 'none', credit_days: null, credit_limit: null,
  contact: null, email: null, phone: null, note: null, rate_type_id: null, contract_template_id: null, contract_status: null, contract_version: null,
  contract_start: null, contract_end: null, legal_name: null, tax_id: null, tat_license: null, address: null, company_tel: null, hotline: null, fax: null,
  website: null, signatory_name: null, signatory_designation: null, signatory_tel: null, signatory_signed_date: null, booking_method: null,
  booking_cutoff: null, booking_cancel_policy: null, booking_email: null, booking_phone: null, house: false, active: true,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', programs: [],
});

/** Salespeople and agents (`{agent_id: sales_id}`), as the import would leave them. */
export async function seedAgents(store: Store, sales: string[], agents: Record<string, string | null>): Promise<void> {
  if (store instanceof OperationsStore) {
    store.seedAgents({
      sales: sales.map((id) => ({ id, code: null, name: id, full_name: null, designation: null, email: null, tel: null, color: null, active: true })),
      agents: Object.entries(agents).map(([id, salesId]) => blankAgent(id, salesId)),
    });
    return;
  }
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    for (const id of sales) await db.query('INSERT INTO sales_people (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
    for (const [id, salesId] of Object.entries(agents)) {
      await db.query('INSERT INTO agents (id, name, sales_id) VALUES ($1, $1, $2) ON CONFLICT (id) DO UPDATE SET sales_id = EXCLUDED.sales_id', [id, salesId]);
    }
  } finally { await db.end(); }
}
