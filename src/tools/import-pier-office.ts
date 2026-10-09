/**
 * Imports legacy's pier office (todo/pier-office-model.md): petty cash (ledger rows, the longtail and
 * park sheets, the company name) and the office lists. The mapping is `legacy-pier-office.ts`.
 *
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run import:pier-office [-- --commit] [--all]
 *
 * Run it after `seed:boats` (the sheets name boats). Without `--commit` it is a dry run: everything is
 * written in one transaction, the report printed, and the transaction rolled back. The source is
 * opened read-only.
 *
 * Until the pier area cuts over, legacy is its master and a rerun mirrors it: the lists are replaced
 * whole (the seeds of migration 171 with them), petty cash rows with legacy's ids are replaced (rows
 * made here, `pc_…`, are kept), every sheet cell is replaced, and so is the company name.
 */
import { Client, type PoolClient } from 'pg';
import { PostgresPierOfficeRepo } from '../domain/pier-office-postgres.js';
import type { PierList } from '../domain/pier-office.js';
import { mapLegacyPierOffice } from './legacy-pier-office.js';

const commit = process.argv.includes('--commit');
const all = process.argv.includes('--all');
const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;
if (!sourceUrl || !targetUrl) throw new Error('Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL');

const baht = (n: number): string => `฿${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

async function main() {
  const source = new Client({ connectionString: sourceUrl, options: '-c default_transaction_read_only=on -c search_path=operation_schemas' });
  const target = new Client({ connectionString: targetUrl });
  await source.connect();
  await target.connect();
  const read = async (sql: string) => (await source.query(sql)).rows as Record<string, unknown>[];
  try {
    const legacy = {
      cashRows: await read('SELECT * FROM po_cash_rows'), longtail: await read('SELECT * FROM po_cash_lt'), park: await read('SELECT * FROM po_cash_pk'),
      company: (await read("SELECT value FROM app_meta WHERE key = 'po_cash_co'"))[0]?.value ?? null,
      kinds: await read('SELECT * FROM pier_kinds'), items: await read('SELECT * FROM pier_items'), codes: await read('SELECT * FROM pier_codes'),
      sections: await read('SELECT * FROM pier_sect'), staff: await read('SELECT * FROM pier_staff'),
      licenseTypes: await read('SELECT * FROM pier_lic_types'), licenseClasses: await read('SELECT * FROM pier_lic_classes'),
    };
    const boats = new Set((await target.query('SELECT id FROM boats')).rows.map((r) => r.id as string));
    const skipped: [string, string, string][] = [];
    const notes = new Map<string, number>();
    const report = { skip: (kind: string, id: string, reason: string) => { skipped.push([kind, id, reason]); }, note: (what: string) => { notes.set(what, (notes.get(what) ?? 0) + 1); } };
    const out = mapLegacyPierOffice(legacy, { boats, now: new Date().toISOString() }, report);

    await target.query('BEGIN');
    const repo = new PostgresPierOfficeRepo(() => target as unknown as PoolClient);
    // Children before parents, then parents first.
    for (const table of ['pier_staff', 'pier_items', 'pier_license_classes', 'pier_sections', 'pier_item_kinds', 'pier_license_types', 'pier_attendance_codes']) {
      await target.query(`DELETE FROM ${table}`);
    }
    for (const list of ['item-kinds', 'items', 'attendance-codes', 'sections', 'staff', 'license-types', 'license-classes'] as PierList[]) {
      await repo.putListRows(list, out.lists[list]);
    }
    await target.query("DELETE FROM pier_cash_rows WHERE id NOT LIKE 'pc\\_%'");
    await target.query('DELETE FROM pier_cash_longtail');
    await target.query('DELETE FROM pier_cash_park');
    for (const r of out.rows) await repo.putCashRow(r);
    for (const c of out.longtail) await repo.putLongtail(c);
    for (const c of out.park) await repo.putPark(c);
    await repo.putCashSettings({ company_name: out.companyName, updated_at: new Date().toISOString(), updated_by: 'import' });

    const sum = (rows: Record<string, unknown>[], f: (r: Record<string, unknown>) => unknown) => rows.reduce((s, r) => s + (Number(f(r)) || 0), 0);
    console.log('What                                    legacy                  imported');
    const line = (what: string, l: string, n: string) => console.log(`${what.padEnd(40)}${l.padEnd(24)}${n}`);
    for (const pier of ['panwa', 'tublamu', 'ranong']) {
      for (const kind of ['in', 'out']) {
        const l = legacy.cashRows.filter((r) => r.pier === pier && r.kind === kind), n = out.rows.filter((r) => r.pier === pier && r.kind === kind);
        if (l.length || n.length) line(`petty cash ${pier} ${kind}`, `${l.length} ${baht(sum(l, (r) => r.amt))}`, `${n.length} ${baht(n.reduce((s, r) => s + r.amount, 0))}`);
      }
    }
    line('longtail cells', `${legacy.longtail.length} ${baht(sum(legacy.longtail, (r) => r.amt))}`, `${out.longtail.length} ${baht(out.longtail.reduce((s, c) => s + (c.amount ?? 0), 0))}`);
    line('park cells (park fees)', `${legacy.park.length} ${baht(sum(legacy.park, (r) => r.amt))}`, `${out.park.length} ${baht(out.park.reduce((s, c) => s + (c.amount ?? 0), 0))}`);
    line('  dock fees', baht(sum(legacy.park, (r) => r.dock)), baht(out.park.reduce((s, c) => s + (c.dock ?? 0), 0)));
    line('company name', String(legacy.company ?? ''), String(out.companyName ?? ''));
    for (const [what, l, list] of [['item kinds', legacy.kinds, 'item-kinds'], ['items', legacy.items, 'items'], ['roster codes', legacy.codes, 'attendance-codes'],
      ['roster groups', legacy.sections, 'sections'], ['staff', legacy.staff, 'staff'], ['licence types', legacy.licenseTypes, 'license-types'],
      ['licence classes', legacy.licenseClasses, 'license-classes']] as const) {
      line(what, String(l.length), String(out.lists[list as PierList].length));
    }
    if (notes.size) { console.log('\nNotes:'); for (const [k, n] of notes) console.log(`  ${n} ${k}`); }
    console.log(`\nSkipped (${skipped.length}):`);
    for (const [kind, id, reason] of skipped.slice(0, all ? skipped.length : 20)) console.log(`  ${kind} ${id}: ${reason}`);
    if (skipped.length > 20 && !all) console.log(`  … ${skipped.length - 20} more (--all lists every row)`);
    await target.query(commit ? 'COMMIT' : 'ROLLBACK');
    console.log(`\n${commit ? 'COMMIT' : 'DRY RUN (rolled back)'}`);
  } catch (error) {
    await target.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
