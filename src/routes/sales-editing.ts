/**
 * Sales editing (todo/sales-editing-model.md, decided 2026-10-09): agents and their programmes, rate,
 * renewal and documents; promo contracts; contract templates; salespeople and markets; the add-on
 * catalogue; nationalities; passengers' insurance fields. Also the agent and contract reads, because a
 * sales-bound login sees only its own agents (decision 3).
 *
 * The rules are in `src/domain/` (`agent-writes.ts`, `team.ts`, `contract-templates.ts`,
 * `addon-services.ts`, `nationalities.ts`, `insurance.ts`). A handler reads what the rule needs from
 * the store, asks the rule, and writes what it answers, all in one transaction. Who may write is the
 * `preHandler` hook's (`writeNeed` in `users.ts`); an admin-only delete is checked here.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from './operations.js';
import type { Booking } from '../domain/operations.js';
import { actorOf, refuse, stampActor, type HistoryLine } from '../domain/booking-actions.js';
import { isIsoDate, todayInThailand } from '../domain/calendar.js';
import { creditOf } from '../domain/invoices.js';
import type { CreditBalance } from '../domain/refunds.js';
import type { AgentActivity, AgentListQuery, StoredAgent } from '../domain/agents.js';
import {
  AGENT_SERVER_OWNED, assertAgentDeletable, assertAgentInScope, newLegacyStyleId, parseAgentCreate, parseAgentFields, parsePrograms, parseRateTypeChange, parseRenewal,
  planActive, planAgentCreate, planAgentPatch, planPrograms, planRateTypeChange, planRenewal, salesScopeOf, type AgentWriteContext, type RateTypeRef,
} from '../domain/agent-writes.js';
import { withoutServerOwned } from '../domain/server-owned.js';
import { parseRateSeasons, rateTypeFor, seasonsActivityText } from '../domain/rate-seasons.js';
import { parseContractListQuery, type Contract } from '../domain/contracts.js';
import {
  assertEditable, bonusProgress, checkPromo, contractState, newPromoBase, parsePromoBody, planVoid, promoActivityText, promoFormOf, promoFrom,
  PROMO_SERVER_OWNED, samePromo, type PromoContext, type PromoForm,
} from '../domain/contract-writes.js';
import {
  assertMarketDeletable, assertSalesDeletable, planMarketCreate, planMarketOrder, planMarketPatch, planSalesCreate, planSalesPatch,
} from '../domain/team.js';
import {
  assertTemplateDeletable, documentLine, documentSummary, effectiveTemplateId, parseDocument, planDocument, planTemplateCreate, planTemplatePatch, templateSummary,
  type ContractTemplate,
} from '../domain/contract-templates.js';
import { parseActiveFilter, planAddonServiceCreate, planAddonServicePatch } from '../domain/addon-services.js';
import { nationalityList, planNationality } from '../domain/nationalities.js';
import { parseInsurance, planInsurance } from '../domain/insurance.js';

type Request = FastifyRequest;
const fail = (message: string, statusCode: number, code?: string): never => refuse(message, statusCode, code);
const notFound = (message: string): never => fail(message, 404);
const bad = (message: string): never => fail(message, 400);
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : bad('Request body must be an object'));
const param = (request: Request, name = 'id'): string => (request.params as Record<string, string>)[name];
const query = (request: Request): Record<string, unknown> => (request.query ?? {}) as Record<string, unknown>;
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
const nowIso = (): string => new Date().toISOString();

/** `?active=` on the agent list: active agents by default, `false` for inactive ones, `all` for both. */
function agentListQuery(q: Record<string, unknown>): AgentListQuery {
  const active = q.active === undefined || q.active === 'true' ? true : q.active === 'false' ? false : q.active === 'all' ? undefined : bad('active must be true, false or all');
  return { marketId: optional(q.market), salesId: optional(q.sales), q: optional(q.q), active };
}

export function registerSalesRoutes(app: FastifyInstance, deps: {
  store: Store;
  /** The booking write guard (`If-Match`), as every booking write uses it. */
  assertBookingFresh: (request: Request) => Promise<void>;
  /** Money kept for the agent (weather credits), spent as payments (`refunds.ts`). */
  agentCredit: (agentId: string) => Promise<CreditBalance>;
}): void {
  const { store } = deps;
  const by = (request: Request): string | null => actorOf(request.user) ?? null;
  const scope = (request: Request): string | undefined => salesScopeOf(request.user?.user);

  /** The agent as stored, `404` when unknown and `403` when it is another salesperson's (decision 3). */
  const ownAgent = async (request: Request, id = param(request)): Promise<StoredAgent> => {
    const agent = (await store.agentRecord(id)) ?? notFound('Agent not found');
    assertAgentInScope(agent, scope(request));
    return agent;
  };
  /** Every booking of an agent, all pages. */
  const agentBookings = async (agentId: string): Promise<Booking[]> => {
    const bookings: Booking[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listBookings({ agentId, limit: 1000, ...(cursor ? { cursor } : {}) });
      bookings.push(...page.bookings);
      cursor = page.next_cursor;
    } while (cursor);
    return bookings;
  };
  /** `GET /v1/agents/{id}`: the agent, its credit (legacy `agCreditState`), renewals and the template it prints with. */
  const agentDetail = async (id: string) => {
    const agent = (await store.agent(id)) ?? notFound('Agent not found');
    const bookings = await agentBookings(agent.id);
    return {
      ...agent, credit: creditOf(agent, bookings), credit_balance: await deps.agentCredit(agent.id), contract_history: await store.contractHistory(id),
      contract_template_effective_id: effectiveTemplateId(agent.contract_template_id, await store.listTemplates()),
    };
  };
  const writeContext = async (request: Request): Promise<AgentWriteContext> => ({
    agents: await store.agentRecords(),
    markets: await store.listMarkets(),
    sales: new Map((await store.listSalesPeople()).map((p) => [p.id, p.name])),
    templates: new Map((await store.listTemplates()).map((t) => [t.id, t.name])),
    scope: scope(request),
  });
  const rateRef = async (id: string | null | undefined): Promise<RateTypeRef | undefined> => {
    if (!id) return undefined;
    const r = await store.rateType(id);
    return r && { id: r.id, name: r.name, code: r.code, owner: r.owner, priced_routes: r.priced_routes };
  };
  const knownRate = async (id: string): Promise<RateTypeRef> => (await rateRef(id)) ?? bad(`Rate type ${id} does not exist (GET /v1/rate-types)`);
  const routeNames = async (): Promise<(id: string) => string> => {
    const names = new Map((await store.listRoutes()).map((r) => [r.id, r.name]));
    return (id) => names.get(id) ?? id;
  };
  const mainContracts = async (agentId: string) => store.listContracts({ agentId, kind: 'main' });
  /** Saves the agent, the activity, the contracts a rate change syncs and a market whose list grew. */
  const save = async (agent: StoredAgent, activity: readonly AgentActivity[], extra: { contracts?: string[]; market?: Awaited<ReturnType<typeof store.listMarkets>>[number] } = {}) => {
    await store.saveAgent(agent, activity);
    for (const id of extra.contracts ?? []) await store.setContractFields(id, { rate_type_id: agent.rate_type_id });
    if (extra.market) await store.saveMarket(extra.market);
  };

  // ── Agents: reads ──

  app.get('/v1/agents', async (request) => {
    const q = agentListQuery(query(request));
    const own = scope(request);
    // A sales-bound login lists its own agents only; asking for another salesperson's finds none.
    if (own !== undefined && q.salesId !== undefined && q.salesId !== own) return { agents: [] };
    return { agents: await store.listAgents(own === undefined ? q : { ...q, salesId: own }) };
  });
  app.get('/v1/agents/:id', async (request) => { await ownAgent(request); return agentDetail(param(request)); });
  app.get('/v1/agents/:id/activity', async (request) => {
    const q = query(request);
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) bad('limit must be an integer between 1 and 200');
    await ownAgent(request);
    return { activity: (await store.agentActivity(param(request), limit)) ?? notFound('Agent not found') };
  });
  /** Which rate type an agent is priced at, by travel date (README, "Rate seasons"). */
  app.get('/v1/agents/:id/rate-seasons', async (request) => {
    await ownAgent(request);
    return { seasons: (await store.rateSeasons(param(request))) ?? notFound('Agent not found') };
  });
  /** Replaces the table and logs legacy's line in the agent's activity. */
  app.put('/v1/agents/:id/rate-seasons', async (request) => {
    const agentId = param(request);
    const seasons = parseRateSeasons(record(request.body));
    const names = new Map<string, string>();
    for (const id of new Set(seasons.map((season) => season.rate_type_id))) {
      const rateType = await store.rateType(id);
      if (!rateType) bad(`Rate type ${id} does not exist (GET /v1/rate-types)`);
      names.set(id, rateType!.name || rateType!.code || id);
    }
    const activity = { at: nowIso(), by: by(request), kind: 'rate', text: seasonsActivityText(seasons, (id) => names.get(id) ?? id) };
    return { seasons: await store.transaction(async () => { await ownAgent(request, agentId); return (await store.setRateSeasons(agentId, seasons, activity)) ?? notFound('Agent not found'); }) };
  });
  /** The rate type for one travel date: the covering season with the latest `from`, else the agent's own. */
  app.get('/v1/agents/:id/rate-type', async (request) => {
    const date = query(request).date;
    if (typeof date !== 'string' || !isIsoDate(date)) bad('date must be YYYY-MM-DD');
    await ownAgent(request);
    const agent = (await store.agent(param(request))) ?? notFound('Agent not found');
    return rateTypeFor(agent.rate_type_id, agent.rate_seasons, date as string);
  });

  // ── Agents: writes (agent-writes.ts) ──

  app.post('/v1/agents', async (request, reply) => {
    const input = parseAgentCreate(record(request.body));
    const created = await store.transaction(async () => {
      const ctx = await writeContext(request);
      const rate = await knownRate(input.rate_type_id);
      const plan = planAgentCreate(input, rate, { ...ctx, id: newLegacyStyleId('a'), now: nowIso(), today: todayInThailand(), by: by(request) });
      await save(plan.agent, plan.activity, { market: plan.market });
      return agentDetail(plan.agent.id);
    });
    return reply.code(201).send(created);
  });
  app.patch('/v1/agents/:id', async (request) => store.transaction(async () => {
    const stored = await ownAgent(request);
    const fields = parseAgentFields(withoutServerOwned(record(request.body), await agentDetail(stored.id) as unknown as Record<string, unknown>, AGENT_SERVER_OWNED), []);
    const plan = planAgentPatch(stored, fields, { ...(await writeContext(request)), now: nowIso(), by: by(request) });
    await save(plan.agent, plan.activity, { market: plan.market });
    return agentDetail(stored.id);
  }));
  app.put('/v1/agents/:id/programs', async (request) => store.transaction(async () => {
    const stored = await ownAgent(request);
    const routes = await store.listRoutes();
    const programs = parsePrograms(record(request.body), stored.programs, routes.length ? new Set(routes.map((r) => r.id)) : undefined);
    const plan = planPrograms(stored, programs, { now: nowIso(), by: by(request) });
    if (plan.activity.length) await save(plan.agent, plan.activity);
    return agentDetail(stored.id);
  }));
  app.put('/v1/agents/:id/rate-type', async (request) => store.transaction(async () => {
    const change = parseRateTypeChange(record(request.body));
    const stored = await ownAgent(request);
    const rate = change.rate_type_id === null ? undefined : await knownRate(change.rate_type_id);
    const plan = planRateTypeChange(stored, change, rate, await rateRef(stored.rate_type_id), await mainContracts(stored.id),
      { now: nowIso(), by: by(request), routeName: await routeNames() });
    if (plan.activity.length) await save(plan.agent, plan.activity, { contracts: plan.contracts });
    return agentDetail(stored.id);
  }));
  app.post('/v1/agents/:id/renew', async (request) => store.transaction(async () => {
    const renewal = parseRenewal(record(request.body));
    const stored = await ownAgent(request);
    const rate = renewal.rate_type_id === undefined ? undefined : await knownRate(renewal.rate_type_id);
    const plan = planRenewal(stored, renewal, rate, await rateRef(stored.rate_type_id), await mainContracts(stored.id), { now: nowIso(), today: todayInThailand(), by: by(request) });
    await store.addContractHistory(stored.id, plan.history);
    await save(plan.agent, plan.activity, { contracts: plan.contracts });
    return agentDetail(stored.id);
  }));
  for (const [command, active] of [['deactivate', false], ['activate', true]] as const) {
    app.post(`/v1/agents/:id/${command}`, async (request) => store.transaction(async () => {
      const stored = await ownAgent(request);
      const plan = planActive(stored, active, { now: nowIso(), by: by(request) });
      if (plan.activity.length) await save(plan.agent, plan.activity);
      return agentDetail(stored.id);
    }));
  }
  /** Legacy `agDelete`: admin only, and (decision 1) only while nothing names the agent. */
  app.delete('/v1/agents/:id', async (request, reply) => {
    const user = request.user?.user;
    if (user && user.role !== 'admin') fail('Only an admin can delete an agent profile', 403, 'forbidden');
    await store.transaction(async () => {
      const stored = await ownAgent(request);
      assertAgentDeletable(stored.id, await store.agentUsage(stored.id));
      await store.deleteAgent(stored.id);
    });
    return reply.code(204).send();
  });

  // ── Contract documents issued to an agent (legacy `agent_artifacts`) ──

  app.get('/v1/agents/:id/documents', async (request) => {
    const agent = await ownAgent(request);
    return { documents: (await store.listDocuments(agent.id)).map(documentSummary) };
  });
  app.post('/v1/agents/:id/documents', async (request, reply) => {
    const req = parseDocument(record(request.body));
    const doc = await store.transaction(async () => {
      const agent = await ownAgent(request);
      const contract = req.contract_id ? await store.contract(req.contract_id) : undefined;
      const template = req.template_id ? (await store.listTemplates()).find((t) => t.id === req.template_id) : undefined;
      // The contract's own rate when it has one, else the agent's (legacy `_ctDocAgentRT`).
      const rate = await rateRef(contract && contract.agent_id === agent.id && contract.rate_type_id ? contract.rate_type_id : agent.rate_type_id);
      const issued = planDocument(req, { id: `gc_${randomUUID()}`, now: nowIso(), by: by(request), agent, contract, template, rate });
      await store.addDocument(issued);
      if (issued.contract_id) await store.setContractFields(issued.contract_id, { doc_id: issued.id });
      await store.addAgentActivity(agent.id, [{ at: issued.generated_at, by: issued.generated_by, kind: 'contract', text: documentLine(issued) }]);
      return issued;
    });
    return reply.code(201).send(doc);
  });
  const ownDocument = async (request: Request) => {
    const doc = (await store.contractDocument(param(request))) ?? notFound('Contract document not found');
    await ownAgent(request, doc.agent_id);
    return doc;
  };
  app.get('/v1/contract-documents/:id', async (request) => ownDocument(request));
  /** Legacy's "Remove from history" (`ctArtifactRemove`). */
  app.delete('/v1/contract-documents/:id', async (request, reply) => {
    await store.transaction(async () => {
      const doc = await ownDocument(request);
      await store.deleteDocument(doc.id);
      await store.addAgentActivity(doc.agent_id, [{ at: nowIso(), by: by(request), kind: 'contract', text: `Contract document removed · ${doc.version} · ${doc.id}` }]);
    });
    return reply.code(204).send();
  });

  // ── Contracts: reads, scoped like agents; promos written here (contract-writes.ts) ──

  /** A contract as the reads answer it: its badge (`state`) and a bonus promo's progress. */
  const contractViews = async (contracts: readonly Contract[]) => {
    const today = todayInThailand();
    const bookingsOf = new Map<string, Booking[]>();
    for (const agentId of new Set(contracts.filter((c) => c.bonus && c.status !== 'void').map((c) => c.agent_id))) bookingsOf.set(agentId, await agentBookings(agentId));
    return contracts.map((c) => ({ ...c, state: contractState(c, today), bonus_progress: bonusProgress(c, bookingsOf.get(c.agent_id) ?? []) }));
  };
  app.get('/v1/contracts', async (request) => {
    const q = parseContractListQuery(query(request));
    const own = scope(request);
    const contracts = await store.listContracts(q);
    if (own === undefined) return { contracts: await contractViews(contracts) };
    const mine = new Set((await store.listAgents({ salesId: own })).map((a) => a.id));
    return { contracts: await contractViews(contracts.filter((c) => mine.has(c.agent_id))) };
  });
  const ownContract = async (request: Request): Promise<Contract> => {
    const contract = (await store.contract(param(request))) ?? notFound('Contract not found');
    const agent = await store.agentRecord(contract.agent_id);
    if (agent) assertAgentInScope(agent, scope(request));
    return contract;
  };
  app.get('/v1/contracts/:id', async (request) => (await contractViews([await ownContract(request)]))[0]);

  /** What a promo's checks read: the main rate legacy discounts from, the routes the form offers, the rate type named. */
  const promoContext = async (agent: StoredAgent, form: PromoForm, editing?: Contract): Promise<PromoContext> => {
    const mains = await mainContracts(agent.id);
    // Legacy `laPromoMainRt` without a date: the first main contract by id (whatever its status), else the agent's rate.
    const first = [...mains].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    const mainRateId = first?.rate_type_id ?? agent.rate_type_id;
    const offered = new Set([...agent.programs.map((p) => p.route_id), ...mains.flatMap((c) => c.program_periods.map((p) => p.route_id)),
      ...(editing?.program_periods.map((p) => p.route_id) ?? [])]);
    return {
      mainRate: mainRateId ? await store.rateType(mainRateId) : undefined,
      rateTypeExists: form.rate_type_id ? (await store.rateType(form.rate_type_id)) !== undefined : false,
      offeredRoutes: offered, routeName: await routeNames(),
    };
  };
  const contractActivity = (request: Request, c: Contract, what: 'added' | 'edited' | 'void') =>
    store.addAgentActivity(c.agent_id, [{ at: nowIso(), by: by(request), kind: 'contract', text: promoActivityText(what, c) }]);
  /** Legacy `ctSaveAddPromo`, adding. */
  app.post('/v1/contracts', async (request, reply) => {
    const body = record(request.body);
    const { fields, flags } = parsePromoBody(body, true);
    if (typeof body.agent_id !== 'string' || !body.agent_id) bad('agent_id is required');
    const created = await store.transaction(async () => {
      const agent = (await store.agentRecord(body.agent_id as string)) ?? bad(`agent_id ${String(body.agent_id)} is not an agent (GET /v1/agents)`);
      assertAgentInScope(agent, scope(request));
      const form = { rate_type_id: null, seat_prices: [], discount: null, bonus: null, book_from: null, book_to: null, priority: 10, note: null, ...fields } as PromoForm;
      const checked = checkPromo(form, fields, await promoContext(agent, form), flags);
      const promo = promoFrom(checked, newPromoBase(newLegacyStyleId('ct'), agent.id, checked, todayInThailand(), by(request)));
      await store.saveContract(promo);
      await contractActivity(request, promo, 'added');
      return (await contractViews([(await store.contract(promo.id))!]))[0];
    });
    return reply.code(201).send(created);
  });
  /** Legacy `ctSaveAddPromo`, editing: the stored promo with what is sent, checked whole again. */
  app.patch('/v1/contracts/:id', async (request) => store.transaction(async () => {
    const stored = await ownContract(request);
    const [current] = await contractViews([stored]);
    const { fields, flags } = parsePromoBody(withoutServerOwned(record(request.body), current as unknown as Record<string, unknown>, PROMO_SERVER_OWNED), false);
    if (stored.kind !== 'promo' || stored.status === 'void') assertEditable(stored, 0, flags);
    const agent = (await store.agentRecord(stored.agent_id)) ?? notFound('Agent not found');
    const form = { ...promoFormOf(stored), ...fields };
    const checked = checkPromo(form, fields, await promoContext(agent, form, stored), flags);
    const next = promoFrom(checked, stored);
    if (samePromo(next, stored)) return current;
    assertEditable(stored, await store.promoSoldTrips(stored.id), flags);
    await store.saveContract(next);
    await contractActivity(request, next, 'edited');
    return (await contractViews([(await store.contract(next.id))!]))[0];
  }));
  /** Legacy `ctVoidContract`: pricing skips it from now on; trips already sold keep their price. */
  app.post('/v1/contracts/:id/void', async (request) => store.transaction(async () => {
    const voided = planVoid(await ownContract(request), nowIso(), by(request));
    await store.saveContract(voided);
    await contractActivity(request, voided, 'void');
    return (await contractViews([(await store.contract(voided.id))!]))[0];
  }));

  // ── Contract templates (contract-templates.ts) ──

  const templatesWithUse = async () => {
    const all = await store.listTemplates();
    const agents = await store.agentRecords();
    const use = (id: string) => agents.filter((a) => a.contract_template_id === id).length;
    return { all, use };
  };
  const templateView = (t: ContractTemplate, agents: number) => ({ ...t, agents });
  const templateOr404 = (all: readonly ContractTemplate[], id: string): ContractTemplate => all.find((t) => t.id === id) ?? notFound(`Contract template ${id} not found`);
  app.get('/v1/contract-templates', async (request) => {
    const active = parseActiveFilter(query(request).active);
    const { all, use } = await templatesWithUse();
    return { contract_templates: all.filter((t) => active === undefined || t.active === active).map((t) => templateSummary(t, use(t.id))) };
  });
  app.get('/v1/contract-templates/:id', async (request) => {
    const { all, use } = await templatesWithUse();
    const t = templateOr404(all, param(request));
    return templateView(t, use(t.id));
  });
  app.post('/v1/contract-templates', async (request, reply) => {
    const body = record(request.body);
    const created = await store.transaction(async () => {
      const t = planTemplateCreate(body, await store.listTemplates(), { id: newLegacyStyleId('ctt_'), now: nowIso(), today: todayInThailand() });
      await store.saveTemplate(t);
      return templateView(t, 0);
    });
    return reply.code(201).send(created);
  });
  app.patch('/v1/contract-templates/:id', async (request) => store.transaction(async () => {
    const { all, use } = await templatesWithUse();
    const stored = templateOr404(all, param(request));
    const next = planTemplatePatch(stored, record(request.body), templateView(stored, use(stored.id)), all, nowIso());
    await store.saveTemplate(next);
    return templateView(next, use(next.id));
  }));
  /** Legacy `cttSetDefault`: one default, and it is active. */
  app.post('/v1/contract-templates/:id/default', async (request) => store.transaction(async () => {
    const { all, use } = await templatesWithUse();
    const stored = templateOr404(all, param(request));
    await store.setDefaultTemplate(stored.id, nowIso());
    return templateView(templateOr404(await store.listTemplates(), stored.id), use(stored.id));
  }));
  /** Legacy `cttDelete`: its agents fall back to the default, each with a line in its activity. */
  app.delete('/v1/contract-templates/:id', async (request, reply) => {
    await store.transaction(async () => {
      const all = await store.listTemplates();
      const stored = templateOr404(all, param(request));
      assertTemplateDeletable(stored);
      const now = nowIso();
      for (const agent of (await store.agentRecords()).filter((a) => a.contract_template_id === stored.id)) {
        await store.saveAgent({ ...agent, contract_template_id: null, updated_at: now },
          [{ at: now, by: by(request), kind: 'contract', text: `Contract template: ${stored.name} → ค่าตั้งต้น` }]);
      }
      await store.deleteTemplate(stored.id);
    });
    return reply.code(204).send();
  });

  // ── Salespeople and markets (team.ts), area `config` ──

  app.get('/v1/sales', async () => ({ sales: await store.listSalesPeople() }));
  app.get('/v1/sales/:id', async (request) => (await store.salesPerson(param(request))) ?? notFound('Salesperson not found'));
  app.post('/v1/sales', async (request, reply) => {
    const body = record(request.body);
    const created = await store.transaction(async () => {
      const person = planSalesCreate(body, newLegacyStyleId('s'), await store.listSalesPeople());
      await store.saveSalesPerson(person);
      return person;
    });
    return reply.code(201).send(created);
  });
  app.patch('/v1/sales/:id', async (request) => store.transaction(async () => {
    const stored = (await store.salesPerson(param(request))) ?? notFound('Salesperson not found');
    const next = planSalesPatch(stored, record(request.body), await store.listSalesPeople());
    await store.saveSalesPerson(next);
    return next;
  }));
  /** Legacy `tmDeleteSales`: their agents are left with no salesperson, each with a line in its activity. */
  app.delete('/v1/sales/:id', async (request, reply) => {
    await store.transaction(async () => {
      const stored = (await store.salesPerson(param(request))) ?? notFound('Salesperson not found');
      assertSalesDeletable(stored.id, await store.salesUsage(stored.id));
      const now = nowIso();
      for (const agent of (await store.agentRecords()).filter((a) => a.sales_id === stored.id)) {
        await store.saveAgent({ ...agent, sales_id: null, updated_at: now }, [{ at: now, by: by(request), kind: 'sales', text: `Salesperson: ${stored.name} → —` }]);
      }
      await store.deleteSalesPerson(stored.id);
    });
    return reply.code(204).send();
  });

  app.get('/v1/markets', async () => ({ markets: await store.listMarkets() }));
  const marketOr404 = async (id: string) => (await store.listMarkets()).find((m) => m.id === id) ?? notFound(`Market ${id} not found`);
  app.post('/v1/markets', async (request, reply) => {
    const body = record(request.body);
    const created = await store.transaction(async () => {
      const market = planMarketCreate(body, await store.listMarkets());
      await store.saveMarket(market);
      return market;
    });
    return reply.code(201).send(created);
  });
  app.put('/v1/markets/order', async (request) => store.transaction(async () => {
    for (const market of planMarketOrder(record(request.body), await store.listMarkets())) await store.saveMarket(market);
    return { markets: await store.listMarkets() };
  }));
  app.patch('/v1/markets/:id', async (request) => store.transaction(async () => {
    const next = planMarketPatch(await marketOr404(param(request)), record(request.body));
    await store.saveMarket(next);
    return next;
  }));
  app.delete('/v1/markets/:id', async (request, reply) => {
    await store.transaction(async () => {
      const market = await marketOr404(param(request));
      assertMarketDeletable(market, (await store.agentRecords()).filter((a) => a.market_id === market.id).length);
      await store.deleteMarket(market.id);
    });
    return reply.code(204).send();
  });

  // ── The add-on service catalogue (addon-services.ts), area `sales` ──

  const newVariantId = () => newLegacyStyleId('v_');
  const serviceOr404 = async (id: string) => (await store.addonService(id)) ?? notFound(`Add-on service ${id} not found`);
  app.get('/v1/addon-services', async (request) => {
    const active = parseActiveFilter(query(request).active);
    return { addon_services: (await store.listAddonServices()).filter((s) => active === undefined || s.active === active) };
  });
  app.get('/v1/addon-services/:id', async (request) => serviceOr404(param(request)));
  app.post('/v1/addon-services', async (request, reply) => {
    const service = planAddonServiceCreate(record(request.body), { id: newLegacyStyleId('aos_'), now: nowIso(), newVariantId });
    await store.transaction(async () => store.saveAddonService(service));
    return reply.code(201).send(service);
  });
  app.patch('/v1/addon-services/:id', async (request) => store.transaction(async () => {
    const next = planAddonServicePatch(await serviceOr404(param(request)), record(request.body), { now: nowIso(), newVariantId });
    await store.saveAddonService(next);
    return next;
  }));
  app.delete('/v1/addon-services/:id', async (request, reply) => {
    await store.transaction(async () => { await serviceOr404(param(request)); await store.deleteAddonService(param(request)); });
    return reply.code(204).send();
  });

  // ── Nationalities (nationalities.ts): read by any login, added under `operations` ──

  app.get('/v1/nationalities', async () => ({ nationalities: nationalityList(await store.listNationalities()) }));
  app.post('/v1/nationalities', async (request, reply) => {
    const body = record(request.body);
    const result = await store.transaction(async () => {
      const plan = planNationality(body, await store.listNationalities(), { now: nowIso(), by: by(request) });
      if ('created' in plan) await store.addNationality(plan.created);
      return plan;
    });
    const n = 'created' in result ? result.created : result.existing;
    return reply.code('created' in result ? 201 : 200).send({ code: n.code, name: n.name, custom: !n.builtin, created: 'created' in result });
  });

  // ── Insurance (insurance.ts): a booking write, so `operations` and `If-Match` ──

  app.put('/v1/bookings/:id/insurance', async (request) => {
    const updates = parseInsurance(record(request.body));
    const actor = actorOf(request.user);
    return store.transaction(async () => {
      await deps.assertBookingFresh(request);
      const booking = (await store.booking(param(request))) ?? notFound('Booking not found');
      const plan = planInsurance(booking, updates, { now: nowIso(), by: actor ?? null });
      const parts = updates.map((u) => `${u.passenger === 'lead' ? 'lead' : `#${u.passenger}`}${u.age !== undefined ? ` age ${u.age ?? '—'}` : ''}${u.reviewed === undefined ? '' : u.reviewed ? ' reviewed' : ' not reviewed'}`);
      const line: HistoryLine = { by: actor ?? null, kind: 'edit', tag: 'Insurance', text: `Insurance · ${parts.join(' · ')}` };
      // An amendment with no changes: it bumps the version and writes the history line, as every booking write does.
      await store.amendBooking(booking.id, { header: stampActor({}, actor) }, actor, line);
      await store.setInsurance(booking.id, plan.lead, plan.passengers);
      return (await store.booking(booking.id))!;
    });
  });
}
