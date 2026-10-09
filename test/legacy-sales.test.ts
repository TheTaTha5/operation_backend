import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyLegacyInsurance, mapLegacyNationalities, mapLegacySales, mapLegacyStaffAndBoard } from '../src/tools/legacy-sales.js';

// The import's mapping of legacy's sales data (`legacy-sales.ts`), on rows shaped as legacy's tables
// hold them (read from production 2026-10-09).

test('templates keep legacy\'s ids, codes and one default; a shared code is listed', () => {
  const tpl = (id: string, code: string, isDefault: boolean) => ({ id, value: JSON.stringify({ id, code, name: 'Template ใหม่', active: true, isDefault, createdDate: '2026-08-14',
    note: '', form: 'sheet', accent: 'navy', accentHex: '', font: 'manrope', sections: { cover: true }, text: { en: { childRateTitle: 'Children' }, th: {} } }) });
  const out = mapLegacySales({ templates: [tpl('ctt_a', 'CT-06', false), tpl('ctt_b', 'CT-06', true), tpl('ctt_c', 'CT-07', true)], artifacts: [], history: [], agentIds: new Set(), contractIds: new Set() });
  assert.deepEqual(out.templates.map((t) => [t.id, t.code, t.is_default]), [['ctt_a', 'CT-06', false], ['ctt_b', 'CT-06', true], ['ctt_c', 'CT-07', false]]);
  assert.equal(out.templates[0].accent_hex, null, 'legacy\'s blank hex');
  assert.deepEqual(out.templates[1].text, { en: { childRateTitle: 'Children' }, th: {} });
  assert.equal(out.issues.length, 2, 'the shared code and the second default');
});

test('issued documents: frozen content, under an imported agent, linked to a contract that is here', () => {
  const artifacts = [{ id: 'a13', value: JSON.stringify([{ id: 'gc_1789708629206', version: 'v2025-1', generatedAt: '2026-09-18T05:17:09.206Z', lang: 'en',
    sections: { cover: true }, templateId: 'ctt_b', templateName: 'Template ใหม่', form: 'classic', accent: 'steel', accentHex: '', font: 'dmsans',
    tmplText: { en: {} }, overrides: {}, customClauses: [], rateTypeRef: 'RT-1', rateTypeName: 'Main', contractId: 'ct_main_a13', pageCount: 6 }]) },
  { id: 'a_gone', value: '[]' }];
  const out = mapLegacySales({ templates: [], artifacts, history: [], agentIds: new Set(['a13']), contractIds: new Set() });
  assert.equal(out.documents.length, 1);
  const d = out.documents[0];
  assert.deepEqual([d.id, d.agent_id, d.contract_id, d.version, d.lang, d.page_count, d.rate_type_name], ['gc_1789708629206', 'a13', null, 'v2025-1', 'en', 6, 'Main']);
  assert.deepEqual((d.content as { form: string }).form, 'classic');
  assert.ok(out.issues.some((i) => i.includes('contract ct_main_a13 is not here')));
  assert.ok(out.issues.some((i) => i.includes('a_gone')));
});

test('the renewal archive is written oldest first, its periods as programmes', () => {
  const row = (idx: number, version: string) => ({ sb_agents_id: 'a73', idx, version, archivedat: `202${idx + 4}-09-30`, contractstart: '2024-10-01', contractend: '2025-09-30',
    snapshot_agentsignatory_name: 'K. A', snapshot_agentsignatory_designation: null, snapshot_agentsignatory_tel: null, snapshot_agentsignatory_signeddate: '',
    snapshot_programperiods: JSON.stringify([{ routeId: 'r6', bookFrom: '2024-10-01', bookTo: '2025-09-30', travelFrom: '2024-10-01', note: '' }]) });
  const out = mapLegacySales({ templates: [], artifacts: [], history: [row(0, 'v2024-1'), row(1, 'v2023-1')], agentIds: new Set(['a73']), contractIds: new Set() });
  assert.deepEqual(out.history.map((h) => h.version), ['v2023-1', 'v2024-1']);
  assert.deepEqual(out.history[1].programs, [{ route_id: 'r6', book_from: '2024-10-01', book_to: '2025-09-30', note: null }]);
  assert.deepEqual(out.history[1].signatory, { name: 'K. A', designation: null, tel: null, signed_date: null });
});

test('custom nationalities: unmerged, but never a built-in\'s code', () => {
  const out = mapLegacyNationalities([{ code: 'NGN', name: 'NG · Nigeria' }, { code: 'NG', name: 'NG' }, { code: 'TH', name: 'thai' }, { code: 'NG', name: 'again' }]);
  assert.deepEqual(out.nationalities.map((n) => n.code), ['NGN', 'NG']);
  assert.equal(out.issues.length, 2);
});

test('insurance: the lead on the booking, a passenger by legacy index, text ages read as numbers', () => {
  const booking = { id: 'lg_BK-1' } as Record<string, unknown>;
  const second = { booking_id: 'lg_BK-1', seq: 1 } as Record<string, unknown>;
  const notes: string[] = [];
  const applied = applyLegacyInsurance([
    { key: 'BK-1::lead', value: JSON.stringify({ age: '47', at: 1791522226454, reviewed: true }) },
    // Legacy index 2 is seq 1 here: the passenger at index 1 had no name and was dropped.
    { key: 'BK-1::2', value: JSON.stringify({ age: '2.5', at: 1791522247640, reviewed: false }) },
    { key: 'BK-1::1', value: JSON.stringify({ age: '9' }) },
    { key: 'BK-9::lead', value: JSON.stringify({ age: '30' }) },
    { key: 'BK-1::lead', value: 'not json' },
  ], { bookingId: (id) => `lg_${id}`, bookings: new Map([['lg_BK-1', booking]]), passengerSeq: new Map([['BK-1::0', 0], ['BK-1::2', 1]]),
    passengers: new Map([['lg_BK-1::1', second]]) }, (what) => notes.push(what));
  assert.equal(applied, 2);
  assert.deepEqual([booking.lead_age, booking.lead_insurance_reviewed_at], [47, new Date(1791522226454).toISOString()]);
  assert.deepEqual([second.age, second.insurance_reviewed_at], [2.5, null]);
  assert.equal(notes.length, 3);
});

test('staff keep legacy\'s ids and codes (clashes included) and their 2026 quota; targets and marks parse legacy\'s keys', () => {
  const at = '2026-10-10T00:00:00.000Z';
  const out = mapLegacyStaffAndBoard({
    at, salesIds: new Set(['s01', 's05']), agentIds: new Set(['a56']),
    staff: [
      { id: 'st01', code: 'EMP-001', name: 'Natthaphat Chotejirawarachat · ', dept: 'Sales', active: true, quota_2026: '3' },
      { id: 'st03', code: 'EMP-010', name: 'Nirin', dept: 'Sales', active: null, quota_2026: '0' },
      { id: 'st10', code: 'EMP-010', name: 'Suchawadee', dept: '', active: false, quota_2026: null },
      { id: 'st11', code: '', name: '', dept: null, active: true, quota_2026: '-1' },
      { id: '', name: 'nobody' },
    ],
    sales: [
      { id: 's01', targets: JSON.stringify({ '2026-07': 120, '2026-08': 0, 'July': 5 }), followup: JSON.stringify({ '2026-07::a56': true, 'foc:2026-07::a56': true, '2026-07::a99': true, '2026-13::a56': true, '2026-08::a56': false }) },
      { id: 's05', targets: null, followup: '{}' },
      { id: 's_gone', targets: JSON.stringify({ '2026-07': 10 }), followup: null },
      { id: 's01x', targets: 'not json', followup: null },
    ],
  });
  assert.deepEqual(out.staff, [
    { id: 'st01', code: 'EMP-001', name: 'Natthaphat Chotejirawarachat ·', dept: 'Sales', active: true },
    { id: 'st03', code: 'EMP-010', name: 'Nirin', dept: 'Sales', active: true },
    { id: 'st10', code: 'EMP-010', name: 'Suchawadee', dept: null, active: false },
    { id: 'st11', code: null, name: '', dept: null, active: true },
  ]);
  assert.deepEqual(out.quotas, [{ staff_id: 'st01', year: 2026, free_seats: 3 }, { staff_id: 'st03', year: 2026, free_seats: 0 }]);
  assert.deepEqual(out.targets, [{ sales_id: 's01', month: '2026-07', pax: 120, set_at: at, set_by: null }]);
  assert.deepEqual(out.followups.map((f) => [f.sales_id, f.month, f.agent_id, f.kind]), [['s01', '2026-07', 'a56', 'agent'], ['s01', '2026-07', 'a56', 'foc']]);
  assert.equal(out.issues.length, 6, out.issues.join('\n'));
  assert.ok(out.issues.some((i) => i.includes('agent a99 is not here')));
});
