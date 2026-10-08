import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { priceBooking, type PricingAgent, type QuoteInput } from '../src/domain/pricing.js';
import type { RateType } from '../src/domain/rate-types.js';
import type { Contract } from '../src/domain/contracts.js';

// The proof that `priceBooking` prices as legacy does (README "Quote"): legacy's own bookings,
// each with the price legacy stored, and the catalogue our importers made of legacy's rates. Built by
// `src/tools/build-quote-fixture.ts`; every booking in it must come out exactly as legacy stored it.
type Expected = { seat: number; add_on: number; foc_discount: number; discount: number; extra: number; total: number; trips: number[] };
const fixture = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/quote-legacy.json.gz', import.meta.url))).toString()) as {
  rate_types: RateType[]; agents: PricingAgent[]; contracts: Contract[]; boat_types: Record<string, string>;
  bookings: { id: string; input: QuoteInput; expected: Expected }[];
};
const rateTypes = new Map(fixture.rate_types.map((r) => [r.id, r]));
const agents = new Map(fixture.agents.map((a) => [a.id, a]));
const boatTypes = new Map(Object.entries(fixture.boat_types));

test(`legacy's ${fixture.bookings.length} bookings re-price exactly as legacy stored them`, () => {
  assert.ok(fixture.bookings.length > 4000, 'the fixture holds the proof');
  const wrong: string[] = [];
  for (const { id, input, expected } of fixture.bookings) {
    const agent = input.agent_id ? agents.get(input.agent_id) : undefined;
    const q = priceBooking(input, { rateTypes, agent, contracts: fixture.contracts.filter((c) => c.agent_id === input.agent_id), boatTypes });
    const got = { seat: q.seat, add_on: q.add_on, foc_discount: q.foc_discount, discount: q.discount, extra: q.extra, total: q.total, trips: q.trips.map((t) => t.subtotal) };
    if (JSON.stringify(got) !== JSON.stringify(expected)) wrong.push(`${id}: got ${JSON.stringify(got)}, legacy ${JSON.stringify(expected)}`);
  }
  assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} differ`);
});
