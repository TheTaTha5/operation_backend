/**
 * Freezes the proof that `priceBooking` prices as legacy does (README "Quote", decided
 * 2026-10-09): legacy's own bookings, each with the price legacy stored, and the catalogue our
 * importers made of legacy's rates, written to `test/fixtures/quote-legacy.json.gz`.
 *
 *   SOURCE_DATABASE_URL=<legacy> TARGET_DATABASE_URL=<a database the importers filled> \
 *     npx tsx src/tools/build-quote-fixture.ts [--compare <reprice results.json>]
 *
 * TARGET is a scratch database after `seed:routes`, `seed:boats`, `import-legacy.ts --commit` and
 * `import:contracts --commit`: the rates, agents, contracts and boats are read from it, as the API
 * would read them. The bookings are read from legacy, read-only.
 *
 * Kept: every rate-priced, non-B2C booking without a partial cancel whose every price field (seats,
 * add-ons, FOC value, discount, extras, total) and per-trip subtotals `priceBooking` reproduces exactly. The rest are listed by what differs: legacy
 * keeps no history of rate edits, so a booking whose rate was edited after it was saved cannot match.
 * Customers' details are not read: pricing needs none.
 */
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { PostgresOperationsStore } from '../domain/postgres-operations.js';
import { parsePaxGrid } from '../domain/pax.js';
import { priceBooking, type PricingAgent, type QuoteInput } from '../domain/pricing.js';
import type { RateType } from '../domain/rate-types.js';
import type { Contract } from '../domain/contracts.js';

type Row = Record<string, unknown>;
const sourceUrl = process.env.SOURCE_DATABASE_URL, targetUrl = process.env.TARGET_DATABASE_URL;
if (!sourceUrl || !targetUrl) throw new Error('Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL');
const compareAt = process.argv.indexOf('--compare');
const debugAt = process.argv.indexOf('--debug');
const debugIds = new Set(debugAt > 0 ? process.argv[debugAt + 1].split(',') : []);
const str = (v: unknown): string => (v == null ? '' : String(v).trim());
const num = (v: unknown): number | undefined => (v == null || v === '' ? undefined : Number(v));

async function main() {
  const source = new Client({ connectionString: sourceUrl, options: '-c default_transaction_read_only=on -c search_path=operation_schemas' });
  await source.connect();
  const store = new PostgresOperationsStore(targetUrl!);
  try {
    const read = async (sql: string) => (await source.query(sql)).rows as Row[];
    const group = (rows: Row[]) => { const m = new Map<string, Row[]>(); for (const r of rows) { const k = str(r.sb_bookings_id); (m.get(k) ?? m.set(k, []).get(k)!).push(r); } return m; };
    const trips = group(await read('SELECT * FROM sb_bookings__trips ORDER BY sb_bookings_id, idx'));
    const addOns = group(await read('SELECT sb_bookings_id, idx, type, qty, jad, jchd FROM sb_bookings__addons ORDER BY sb_bookings_id, idx'));
    const adjustments = group(await read('SELECT sb_bookings_id, idx, kind, mode, value FROM sb_bookings__adjustments ORDER BY sb_bookings_id, idx'));
    const partial = new Set((await read('SELECT DISTINCT sb_bookings_id FROM sb_bookings__partialcancels')).map((r) => str(r.sb_bookings_id)));
    const bookings = await read(`SELECT id, agentid, ratetyperef, bookingdate, pricemode, pricebreakdown_seat, pricebreakdown_addon, pricebreakdown_focdiscount,
      pricebreakdown_discount, pricebreakdown_extra, pricebreakdown_total FROM sb_bookings ORDER BY id`);

    const rateTypes = new Map<string, RateType | null>();
    const rateType = async (id: string | null | undefined) => {
      if (!id) return;
      if (!rateTypes.has(id)) rateTypes.set(id, (await store.rateType(id)) ?? null);
    };
    const agents = new Map<string, PricingAgent | null>(), contracts = new Map<string, Contract[]>();
    const boatTypes = new Map((await store.listBoats()).map((b) => [b.id, b.type ?? '']));

    const kept: { id: string; input: QuoteInput; expected: Row }[] = [];
    const misses = new Map<string, number>();
    let eligible = 0;
    for (const b of bookings) {
      const id = str(b.id);
      if (id.startsWith('b2c_') || str(b.pricemode) === 'manual' || partial.has(id)) continue;
      eligible++;
      const agentId = str(b.agentid) || undefined;
      if (agentId && !agents.has(agentId)) {
        const a = await store.agent(agentId);
        agents.set(agentId, a ? { id: a.id, code: a.code, rate_type_id: a.rate_type_id, rate_seasons: a.rate_seasons } : null);
        contracts.set(agentId, a ? await store.listContracts({ agentId }) : []);
      }
      const agent = agentId ? agents.get(agentId) ?? undefined : undefined;
      for (const id2 of [str(b.ratetyperef), agent?.rate_type_id, ...(agentId ? contracts.get(agentId)! : []).map((c) => c.rate_type_id)]) await rateType(id2);

      const input: QuoteInput = {
        agent_id: agentId, booking_date: str(b.bookingdate), price_mode: 'rate', rate: 'kept', rate_type_ref: str(b.ratetyperef) || null,
        trips: (trips.get(id) ?? []).map((t) => {
          const grid: Record<string, number> = {};
          for (const c of ['ad', 'chd', 'inf', 'foc']) for (const s of ['_fr', '_th', '']) { const v = Number(t[`pax_${c}${s}`] ?? 0); if (v > 0) grid[`${c}${s}`] = v; }
          return {
            route_id: str(t.routeid), service_date: str(t.date), booking_mode: str(t.bookingmode) || 'seat',
            ...(str(t.charterboatid) ? { charter_boat_id: str(t.charterboatid) } : {}), ...(str(t.zone) ? { zone: str(t.zone) } : {}),
            ...(str(t.ovn) ? { ovn: str(t.ovn) } : {}), ...(t.ovnleg === true ? { ovn_leg: true } : {}),
            ...(num(t.ovncharge) !== undefined ? { ovn_charge: num(t.ovncharge) } : {}),
            ...(str(t.charterpricemode) === 'manual' ? { charter_price_mode: 'manual' as const } : {}),
            ...(num(t.charterpricemanual) !== undefined ? { charter_price_manual: num(t.charterpricemanual) } : {}),
            pax: parsePaxGrid(grid), kept_rate_type_id: null,
          };
        }),
        add_ons: (addOns.get(id) ?? []).map((a) => ({
          type: str(a.type), ...(num(a.qty) ? { qty: num(a.qty) } : {}),
          ...(num(a.jad) !== undefined ? { join_adults: num(a.jad) } : {}), ...(num(a.jchd) !== undefined ? { join_children: num(a.jchd) } : {}),
        })),
        adjustments: (adjustments.get(id) ?? []).map((a) => ({ kind: str(a.kind) as 'discount' | 'extra', mode: (str(a.mode) || 'amount') as 'amount' | 'percent', value: Number(a.value) })),
      };
      const catalogue = {
        rateTypes: new Map([...rateTypes].filter(([, r]) => r) as [string, RateType][]),
        agent, contracts: agentId ? contracts.get(agentId)! : [], boatTypes,
      };
      const q = priceBooking(input, catalogue);
      const stored = (trips.get(id) ?? []).map((t) => num(t.subtotal) ?? 0);
      const expected = {
        seat: num(b.pricebreakdown_seat) ?? 0, add_on: num(b.pricebreakdown_addon) ?? 0, foc_discount: num(b.pricebreakdown_focdiscount) ?? 0,
        discount: num(b.pricebreakdown_discount) ?? 0, extra: num(b.pricebreakdown_extra) ?? 0, total: num(b.pricebreakdown_total) ?? 0, trips: stored,
      };
      const diff = [
        q.seat !== expected.seat && 'seat', q.add_on !== expected.add_on && 'add_on', q.total !== expected.total && 'total',
        q.foc_discount !== expected.foc_discount && 'FOC value', q.discount !== expected.discount && 'discount', q.extra !== expected.extra && 'extra',
        q.trips.some((t, i) => t.subtotal !== stored[i]) && 'trip subtotal',
      ].filter(Boolean).join(', ');
      if (debugIds.has(id)) console.log(id, JSON.stringify({ input, quote: q, expected }));
      if (diff) { misses.set(diff, (misses.get(diff) ?? 0) + 1); continue; }
      kept.push({ id, input, expected });
    }

    // Only what the kept bookings read goes into the fixture.
    const usedAgents = new Set(kept.map((k) => k.input.agent_id).filter(Boolean) as string[]);
    const fixture = {
      built_from: { legacy: 'wt-lk-inbox@658298d', at: new Date().toISOString().slice(0, 10) },
      rate_types: [...rateTypes.values()].filter((r): r is RateType => !!r),
      agents: [...usedAgents].map((a) => agents.get(a)).filter(Boolean),
      contracts: [...usedAgents].flatMap((a) => contracts.get(a) ?? []),
      boat_types: Object.fromEntries(boatTypes),
      bookings: kept,
    };
    writeFileSync('test/fixtures/quote-legacy.json.gz', gzipSync(JSON.stringify(fixture)));
    console.log(`eligible ${eligible}, reproduced exactly ${kept.length} (${(100 * kept.length / eligible).toFixed(1)}%)`);
    for (const [what, count] of [...misses].sort((a, b) => b[1] - a[1])) console.log(`  differs in ${what}: ${count}`);
    if (compareAt > 0) {
      const theirs = new Set((JSON.parse(readFileSync(process.argv[compareAt + 1], 'utf8')) as { id: string; refMatch: boolean }[]).filter((r) => r.refMatch).map((r) => r.id));
      const mine = new Set(kept.map((k) => k.id));
      console.log(`independent re-pricing: ${theirs.size} match; both ${[...mine].filter((i) => theirs.has(i)).length}, only mine ${[...mine].filter((i) => !theirs.has(i)).length}, only theirs ${[...theirs].filter((i) => !mine.has(i)).length}`);
      console.log(`  only theirs: ${[...theirs].filter((i) => !mine.has(i)).slice(0, 20).join(' ')}`);
    }
  } finally {
    await source.end();
    await store.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
