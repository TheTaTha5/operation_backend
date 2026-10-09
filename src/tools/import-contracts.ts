/**
 * Copies legacy's agent contracts (`operation_schemas.sb_contracts` and `__programperiods`) into
 * this service (todo/contracts-model.md).
 *
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run import:contracts [-- --commit]
 *
 * Without `--commit` it is a dry run: the writes happen in one transaction on the target, the result
 * is printed, and the transaction is rolled back. The source is opened read-only either way.
 *
 * Re-runnable: until cutover legacy is the master, so legacy wins for every contract it has (its
 * periods and prices are replaced whole). A contract only this service has is left alone. Run it
 * after `seed:routes` and the agents and rate types imports: a contract needs its agent, and the
 * routes and rate type it names must exist. What does not fit is skipped or dropped and listed (`legacy-contracts.ts`).
 */
import { Client } from 'pg';
import { contractFromLegacy } from './legacy-contracts.js';

type Row = Record<string, unknown>;
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
    const ids = async (sql: string) => new Set((await target.query(sql)).rows.map((row) => String(row.id)));
    const catalogue = { agentIds: await ids('SELECT id FROM agents'), rateTypeIds: await ids('SELECT id FROM rate_types'), routeIds: await ids('SELECT id FROM routes') };
    const periodsOf = new Map<string, Row[]>();
    for (const p of (await source.query('SELECT * FROM sb_contracts__programperiods')).rows as Row[]) {
      const key = String(p.sb_contracts_id);
      (periodsOf.get(key) ?? periodsOf.set(key, []).get(key)!).push(p);
    }

    await target.query('BEGIN');
    let written = 0, periods = 0, prices = 0;
    const lines: string[] = [];
    for (const row of (await source.query('SELECT * FROM sb_contracts ORDER BY id')).rows as Row[]) {
      const mapped = contractFromLegacy(row, periodsOf.get(String(row.id)) ?? [], catalogue);
      if ('skip' in mapped) { lines.push(`skipped  ${String(row.id).padEnd(28)} ${mapped.skip}`); continue; }
      const { contract: c, notes } = mapped;
      for (const note of notes) lines.push(`note     ${c.id.padEnd(28)} ${note}`);
      await target.query(
        `INSERT INTO contracts (id, agent_id, kind, status, rate_type_id, active_from, active_to, priority, version, price_mode, discount_mode, discount_value,
           bonus_buy, bonus_free, bonus_basis, book_window, created_date, created_by, note, doc_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (id) DO UPDATE SET agent_id = EXCLUDED.agent_id, kind = EXCLUDED.kind, status = EXCLUDED.status, rate_type_id = EXCLUDED.rate_type_id,
           active_from = EXCLUDED.active_from, active_to = EXCLUDED.active_to, priority = EXCLUDED.priority, version = EXCLUDED.version,
           price_mode = EXCLUDED.price_mode, discount_mode = EXCLUDED.discount_mode, discount_value = EXCLUDED.discount_value,
           bonus_buy = EXCLUDED.bonus_buy, bonus_free = EXCLUDED.bonus_free, bonus_basis = EXCLUDED.bonus_basis, book_window = EXCLUDED.book_window,
           created_date = EXCLUDED.created_date, created_by = EXCLUDED.created_by, note = EXCLUDED.note, doc_id = EXCLUDED.doc_id`,
        [c.id, c.agent_id, c.kind, c.status, c.rate_type_id, c.active_from, c.active_to, c.priority, c.version, c.price_mode,
          c.discount?.mode ?? null, c.discount?.value ?? null, c.bonus?.buy ?? null, c.bonus?.free ?? null, c.bonus?.basis ?? null,
          c.book_window, c.created_date, c.created_by, c.note, c.doc_id]);
      await target.query('DELETE FROM contract_program_periods WHERE contract_id = $1', [c.id]);
      await target.query('DELETE FROM contract_seat_prices WHERE contract_id = $1', [c.id]);
      for (const [seq, p] of c.program_periods.entries()) {
        await target.query('INSERT INTO contract_program_periods (contract_id, seq, route_id, book_from, book_to, travel_from, travel_to, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [c.id, seq, p.route_id, p.book_from, p.book_to, p.travel_from, p.travel_to, p.note]);
      }
      for (const p of c.seat_prices) {
        await target.query('INSERT INTO contract_seat_prices (contract_id, route_id, zone, category, residency, price) VALUES ($1,$2,$3,$4,$5,$6)',
          [c.id, p.route_id, p.zone, p.category, p.residency, p.price]);
      }
      written++; periods += c.program_periods.length; prices += c.seat_prices.length;
    }
    await target.query(commit ? 'COMMIT' : 'ROLLBACK');
    console.log(commit ? 'COMMITTED' : 'DRY RUN (rolled back)');
    console.log(`contracts: ${written} written, ${periods} periods, ${prices} own prices`);
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
