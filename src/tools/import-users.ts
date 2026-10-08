/**
 * Copies legacy's logins (`operation_schemas.users`) into this service, so staff log in to
 * `POST /v1/login` with their usernames and passwords as they are.
 *
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run import:users [-- --commit]
 *
 * Without `--commit` it is a dry run: the writes happen in one transaction on the target, the result
 * is printed, and the transaction is rolled back. The source is opened read-only either way.
 *
 * Re-runnable, matched by `legacy_id`: until cutover legacy is the master for its users, so a rerun
 * brings its password changes and rights here. The rights given here (`act-approve`, `agent_id`) are
 * kept. A login made here (no `legacy_id`) is never touched; a legacy user whose username it already
 * has is skipped and listed. Run it after the agents import, so `sales_id` finds its salesperson.
 */
import { Client } from 'pg';
import { userFromLegacy } from './legacy-users.js';

const commit = process.argv.includes('--commit');
const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;
if (!sourceUrl || !targetUrl) throw new Error('Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL');

async function main() {
  const source = new Client({ connectionString: sourceUrl, options: '-c default_transaction_read_only=on -c search_path=operation_schemas' });
  const target = new Client({ connectionString: targetUrl });
  await source.connect();
  await target.connect();
  try {
    const salesIds = new Set((await target.query('SELECT id FROM sales_people')).rows.map((row) => String(row.id)));
    await target.query('BEGIN');
    let created = 0, updated = 0;
    const lines: string[] = [];
    for (const row of (await source.query('SELECT * FROM users ORDER BY id')).rows) {
      const mapped = userFromLegacy(row, salesIds);
      if ('skip' in mapped) { lines.push(`skipped  ${String(row.id).padEnd(4)} ${mapped.skip}`); continue; }
      const { user, notes } = mapped;
      for (const note of notes) lines.push(`note     ${user.username.padEnd(16)} ${note}`);
      const { rows: [clash] } = await target.query('SELECT id, legacy_id FROM users WHERE lower(username) = lower($1)', [user.username]);
      if (clash && clash.legacy_id !== user.legacy_id) { lines.push(`skipped  ${user.username.padEnd(16)} username taken by login ${clash.id}, made here`); continue; }
      const { rowCount } = await target.query(
        `UPDATE users SET username = $2, pass_hash = $3, name = $4, role = $5, can_edit = $6, edit_areas = $7,
           actions = ARRAY(SELECT DISTINCT unnest($8::text[] || CASE WHEN 'act-approve' = ANY(actions) THEN ARRAY['act-approve'] ELSE '{}'::text[] END)), view_perms = $9, sales_id = $10, dept = $11,
           tokens_valid_after = GREATEST(tokens_valid_after, $12::timestamptz), updated_at = now()
         WHERE legacy_id = $1`,
        [user.legacy_id, user.username, user.pass_hash, user.name, user.role, user.can_edit, user.edit_areas, user.actions, user.view_perms, user.sales_id, user.dept, user.tokens_valid_after]);
      if (rowCount) { updated++; continue; }
      await target.query(
        `INSERT INTO users (username, pass_hash, name, role, can_edit, edit_areas, actions, view_perms, sales_id, dept, tokens_valid_after, legacy_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [user.username, user.pass_hash, user.name, user.role, user.can_edit, user.edit_areas, user.actions, user.view_perms, user.sales_id, user.dept, user.tokens_valid_after, user.legacy_id]);
      created++;
    }
    await target.query(commit ? 'COMMIT' : 'ROLLBACK');
    console.log(commit ? 'COMMITTED' : 'DRY RUN (rolled back)');
    console.log(`users: ${created} created, ${updated} updated`);
    for (const line of lines) console.log(`  ${line}`);
  } catch (error) {
    await target.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
