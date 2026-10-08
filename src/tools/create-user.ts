/**
 * Creates one login, for a database with none yet (a fresh local stack, a new environment):
 *
 *   DATABASE_URL=… npm run user:create -- <username> <password> [--admin]
 *
 * Without `--admin` the user may edit every area (no list, `can_edit`), like a legacy user with no
 * area list. Everything else is set through `PATCH /v1/users/{id}` once an admin can log in. Staff
 * logins come from legacy with `npm run import:users`.
 */
import { PostgresOperationsStore } from '../domain/postgres-operations.js';
import { hashPassword } from '../domain/users.js';

const [username, password] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL');
if (!username || !password) throw new Error('Usage: npm run user:create -- <username> <password> [--admin]');

const store = new PostgresOperationsStore(url);
try {
  const user = await store.transaction(async () => store.createUser({
    username, pass_hash: hashPassword(password), name: username, role: process.argv.includes('--admin') ? 'admin' : 'staff',
    can_edit: true, edit_areas: null, actions: [], view_perms: null, sales_id: null, agent_id: null, dept: null,
    disabled_at: null, tokens_valid_after: null, legacy_id: null,
  }));
  console.log(`created login ${user.id}: ${user.username} (${user.role})`);
} finally {
  await store.close();
}
