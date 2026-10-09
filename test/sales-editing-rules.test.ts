import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateAgentCode, normalizeAgentName, salesScopeOf, similarAgent, yearLater, HOUSE_AGENT_IDS } from '../src/domain/agent-writes.js';
import { cleanNationalityName, nationalityList, planNationality, builtinNationalities } from '../src/domain/nationalities.js';
import { carryInsurance, parseAge } from '../src/domain/insurance.js';
import { effectiveTemplateId, nextTemplateCode, type ContractTemplate } from '../src/domain/contract-templates.js';
import { writeNeed } from '../src/domain/users.js';

// The pure rules behind sales editing (todo/sales-editing-model.md), checked against legacy's
// functions in allotment_v2/js/08-app.js, case by case.

test('legacy agFindDup: brackets opened, company words dropped, spaces optional', () => {
  assert.equal(normalizeAgentName('Hana Tour (Thailand) Co., Ltd.'), 'hana tour');
  assert.equal(normalizeAgentName('ทัวร์ไทย จำกัด'), 'ทัวร์ไทย จำกัด', 'Thai letters kept');
  const agents = [{ id: 'a1', code: 'HANATOUR', name: 'HANATOUR' }, { id: 'a2', code: null, name: 'X' }];
  assert.equal(similarAgent('Hana Tour Co., Ltd.', agents)?.id, 'a1', '"HANATOUR" = "Hana Tour"');
  assert.equal(similarAgent('Hana Tour', agents, 'a1'), undefined, 'not itself');
  assert.equal(similarAgent('X', agents), undefined, 'one letter is too short to call a duplicate');
});

test('legacy\'s generated code: 8 letters and digits of the name, else the id; a clash is numbered', () => {
  assert.equal(generateAgentCode('Phuket Mango Tours', 'a1', []), 'PHUKETMA');
  assert.equal(generateAgentCode('Phuket Mango Tours', 'a1', [{ id: 'x', code: 'phuketma', name: '' }, { id: 'y', code: 'PHUKETMA2', name: '' }]), 'PHUKETMA3');
  assert.equal(generateAgentCode('ทัวร์', 'amxyz', []), 'AMXYZ', 'no Latin letters: the id');
});

test('a contract runs a year less a day; the house accounts include a_company', () => {
  assert.equal(yearLater('2026-10-09'), '2027-10-08');
  assert.equal(yearLater('2028-02-29'), '2029-02-28');
  assert.ok((HOUSE_AGENT_IDS as readonly string[]).includes('a_company'));
});

test('a login is sales-bound when it has a salesperson and is not an admin (laSalesScoped)', () => {
  assert.equal(salesScopeOf({ role: 'staff', sales_id: 's1' }), 's1');
  assert.equal(salesScopeOf({ role: 'admin', sales_id: 's1' }), undefined);
  assert.equal(salesScopeOf({ role: 'staff', sales_id: null }), undefined);
  assert.equal(salesScopeOf(undefined), undefined);
});

test('legacy bkV2AddCustomNat: cleaned, matched by name or code, coded from three letters', () => {
  assert.equal(cleanNationalityName('  NG · Nigeria  '), 'NG · Nigeria', 'only a 2–4 character code is a label suffix (legacy kept this one, NGN)');
  assert.equal(cleanNationalityName('Barbados)'), 'Barbados');
  assert.equal(cleanNationalityName('Nigeria · NGA'), 'Nigeria');
  const all = builtinNationalities();
  const ctx = { now: '2026-10-09T00:00:00.000Z', by: 'nok' };
  assert.deepEqual(planNationality({ name: 'BRITISH' }, all, ctx), { existing: all.find((n) => n.code === 'GB') });
  assert.deepEqual(planNationality({ name: 'gb' }, all, ctx), { existing: all.find((n) => n.code === 'GB') });
  const made = planNationality({ name: 'Ghanaian' }, all, ctx);
  assert.ok('created' in made && made.created.code === 'GHA');
  const clash = planNationality({ name: 'Ghana' }, [...all, (made as { created: typeof all[number] }).created], ctx);
  assert.ok('created' in clash && clash.created.code === 'GHA2', 'a clash is numbered from 2, as legacy');
  assert.ok('created' in planNationality({ name: 'ไทยใหม่' }, all, ctx) && (planNationality({ name: 'ไทยใหม่' }, all, ctx) as { created: { code: string } }).created.code === 'CUS');
  assert.throws(() => planNationality({ name: 'Q.' }, all, ctx), (e: Error & { statusCode?: number }) => e.statusCode === 400);
  const list = nationalityList([...all, { code: 'ZZZ', name: 'Zed', builtin: false, sort: null, created_at: '2026-10-09T00:00:00.000Z', created_by: null }]);
  assert.deepEqual(list.slice(-2).map((n) => n.code), ['ZZZ', 'OTHER'], 'custom ones after the built-ins, Other last');
});

test('insurance: ages may be fractional; a passenger keeps them only in their own place', () => {
  assert.equal(parseAge('2.5', 'age'), 2.5);
  assert.equal(parseAge(null, 'age'), null);
  assert.throws(() => parseAge(1000, 'age'));
  const stored = [{ seq: 0, name: 'Ann', age: 30, insurance_reviewed_at: '2026-10-09T00:00:00.000Z', insurance_reviewed_by: 'nok' }, { seq: 1, name: 'Bob', age: 5 }];
  assert.deepEqual(carryInsurance(stored, [{ name: 'ann ' }, { name: 'Cy' }]), [
    { name: 'ann ', age: 30, insurance_reviewed_at: '2026-10-09T00:00:00.000Z', insurance_reviewed_by: 'nok' }, { name: 'Cy' },
  ]);
  assert.deepEqual(carryInsurance(stored, [{ name: 'Bob' }]), [{ name: 'Bob' }], 'Bob moved to Ann\'s place: his age does not follow, nor does hers stay');
});

test('templates: the next free CT-NN, and an inactive binding prints the default (ctTmplForAgent)', () => {
  const t = (id: string, code: string, extra: Partial<ContractTemplate> = {}): ContractTemplate => ({
    id, code, name: id, active: true, is_default: false, created_date: null, note: null, form: null, accent: null, accent_hex: null, font: null,
    sections: {}, text: {}, created_at: '', updated_at: '', ...extra,
  });
  const all = [t('a', 'CT-STD'), t('b', 'CT-06', { is_default: true }), t('c', 'CT-06'), t('d', 'CT-09', { active: false })];
  assert.equal(nextTemplateCode(all), 'CT-10');
  assert.equal(effectiveTemplateId('d', all), 'b');
  assert.equal(effectiveTemplateId('c', all), 'c');
  assert.equal(effectiveTemplateId(null, all), 'b');
  assert.equal(effectiveTemplateId('gone', all), 'b');
});

test('who may write: sales for agents and templates, config for salespeople and markets, operations for nationalities', () => {
  assert.deepEqual(writeNeed('/v1/contract-templates/ctt_1/default'), { kind: 'area', areas: ['sales'] });
  assert.deepEqual(writeNeed('/v1/contract-documents/gc_1'), { kind: 'area', areas: ['sales'] });
  assert.deepEqual(writeNeed('/v1/addon-services'), { kind: 'area', areas: ['sales'] });
  assert.deepEqual(writeNeed('/v1/agents/a1/renew'), { kind: 'area', areas: ['sales'] });
  assert.deepEqual(writeNeed('/v1/sales/s1'), { kind: 'area', areas: ['config'] });
  assert.deepEqual(writeNeed('/v1/markets/order'), { kind: 'area', areas: ['config'] });
  assert.deepEqual(writeNeed('/v1/nationalities'), { kind: 'area', areas: ['operations'] });
  assert.deepEqual(writeNeed('/v1/bookings/b1/insurance'), { kind: 'area', areas: ['operations'] });
  assert.deepEqual(writeNeed('/v1/salesboard'), { kind: 'admin' }, 'only the exact path');
});
