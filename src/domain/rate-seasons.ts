/**
 * Which rate type an agent is priced at, by travel date (migration 030; README, "Rate seasons").
 * Legacy's `§rtSeason`: a season is a rate type from a travel date, open-ended when it has no `to`.
 * Pure, so both stores, the screens and the quote all read one rule.
 */
import { isIsoDate } from './calendar.js';
import { refuse } from './booking-actions.js';

export type RateSeason = { rate_type_id: string; from: string; to: string | null };
export type RateTypeAt = { rate_type_id: string | null; source: 'season' | 'agent'; season: RateSeason | null };

/**
 * `PUT /v1/agents/{id}/rate-seasons`: the whole table, sorted by `from`. Legacy's `{rt, from, to}`
 * spelling is accepted and a blank `to` means no end. Refused where legacy is not (decided
 * 2026-10-09): a season ending before it starts, and two starting the same day.
 */
export function parseRateSeasons(body: Record<string, unknown>): RateSeason[] {
  const list = body.seasons ?? body.rateSeasons;
  if (!Array.isArray(list)) refuse('seasons must be a list', 400);
  const seasons = (list as unknown[]).map((raw, i): RateSeason => {
    const row = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : refuse(`seasons[${i}] must be an object`, 400);
    const rateTypeId = row.rate_type_id ?? row.rt;
    if (typeof rateTypeId !== 'string' || rateTypeId === '') refuse(`seasons[${i}].rate_type_id is required`, 400);
    const from = row.from;
    if (typeof from !== 'string' || !isIsoDate(from)) refuse(`seasons[${i}].from must be YYYY-MM-DD`, 400);
    const to = row.to === undefined || row.to === null || row.to === '' ? null : row.to;
    if (to !== null && (typeof to !== 'string' || !isIsoDate(to))) refuse(`seasons[${i}].to must be YYYY-MM-DD, or empty for no end`, 400);
    if (to !== null && (to as string) < (from as string)) refuse(`seasons[${i}] ends (${to}) before it starts (${from})`, 400);
    return { rate_type_id: rateTypeId as string, from: from as string, to: to as string | null };
  });
  const sorted = [...seasons].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].from === sorted[i - 1].from) refuse(`Two seasons start on ${sorted[i].from}; each must start on a different day`, 400);
  }
  return sorted;
}

/**
 * Legacy's `laSeasonAt` then `laMainRtIdFor`: the season with the latest `from` that covers the
 * date wins; none covers it (or there are none), the agent's own rate type.
 */
export function rateTypeFor(agentRateTypeId: string | null, seasons: readonly RateSeason[], date: string): RateTypeAt {
  const sorted = [...seasons].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i];
    if (date >= s.from && (s.to === null || date <= s.to)) return { rate_type_id: s.rate_type_id, source: 'season', season: { ...s } };
  }
  return { rate_type_id: agentRateTypeId, source: 'agent', season: null };
}

/** The activity line legacy's `rtmSave` writes, word for word. `name` gives a rate type's name. */
export function seasonsActivityText(seasons: readonly RateSeason[], name: (rateTypeId: string) => string): string {
  if (seasons.length === 0) return 'เอาตารางฤดูกาลออก · กลับไปใช้ชุดราคาเดียวทั้งปี';
  return `ตั้งตารางฤดูกาล ${seasons.length} ช่วง · ${seasons.map((s) => `${name(s.rate_type_id)} ${s.from}→${s.to ?? 'ไม่มีวันสิ้นสุด'}`).join(' · ')}`;
}
