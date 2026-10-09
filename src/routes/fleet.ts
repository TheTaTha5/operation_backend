/**
 * Fleet maintenance, part A (todo/fleet-maintenance-model.md, decided 2026-10-09): whether a boat can
 * sail, its engines, gearboxes and propellers, incidents and maintenance jobs. The rules are in
 * `src/domain/fleet-availability.ts`, `fleet-assets.ts` and `fleet-jobs.ts`; a handler reads what a
 * command may touch into a `FleetDraft`, runs it, and writes back what it changed, in one transaction.
 * Writes need the `fleet` area (`writeNeed` in `users.ts`), as legacy's `flSave`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from './operations.js';
import { actorOf, refuse } from '../domain/booking-actions.js';
import { eachDate, todayInThailand } from '../domain/calendar.js';
import { realDate, type BoatRecord } from '../domain/catalogue.js';
import { SEAT_RELEASING_STATUSES } from '../domain/booking-status.js';
import { availability, jobWork, type OpenWork } from '../domain/fleet-availability.js';
import {
  ASSET_LIST_KEY, ASSET_PATHS, assertGearboxFits, assertPropellerFits, engineService, formSpareLocation, gearboxLifetime, gearboxService,
  installedEngine, installedGearbox, installedPropeller, movedSpare, newAsset, newAssetId, parseAssetInput, parseHours, pickable, removedAsset, serviced,
  swappedPair, withStatus, type AnyAsset, type AssetKind, type Engine, type Gearbox, type Propeller,
} from '../domain/fleet-assets.js';
import {
  addedJobAsset, changedSteps, closedJob, editedIncident, FleetDraft, incidentLog, jobBoatStatusChange, jobCost, jobLane, jobLog, looksLikeService, newIncident, newJobs,
  nextNo, patchedJob, quickSwap, removedJobAsset, resetService, shownStatus, silentDays, splitJob, startedJob, swapInstall,
  type Incident, type Job, type LinkedMemo,
} from '../domain/fleet-jobs.js';
import type { FleetRepo } from '../domain/fleet-store.js';
import { linkedMemos, meterHours, projectCreatedLines, projectLinkLines, projectSplitLine, projectWork } from '../domain/fleet-seams.js';

type Request = FastifyRequest;
const bad = (message: string): never => refuse(message, 400);
const notFound = (message: string): never => refuse(message, 404);
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : bad('Request body must be an object'));
const body = (request: Request): Record<string, unknown> => (request.body === undefined || request.body === null ? {} : record(request.body));
const param = (request: Request, name = 'id'): string => (request.params as Record<string, string>)[name];
const query = (request: Request): Record<string, unknown> => (request.query ?? {}) as Record<string, unknown>;
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
/** At most about two months of days per availability read, as the all-routes calendar. */
const MAX_AVAILABILITY_DAYS = 62;

/**
 * The work holding boats now (`boatJobBlock`'s list): started jobs that hold their boat, and part B's
 * projects in progress or on hold (`fleet-seams.ts` `projectWork`).
 */
export async function openWork(store: Store, boatId?: string): Promise<OpenWork[]> {
  const jobs = await store.fleetJobs({ status: 'inprogress', ...(boatId ? { boatId } : {}) });
  const projects = (await (store.fleetRepo as FleetRepo).projects()).filter((p) => boatId === undefined || p.boat_id === boatId);
  return [...jobs.map(jobWork), ...projects.map(projectWork)].filter((w): w is OpenWork => w !== null);
}

/** Engine hours read the Daily Fleet Log's meters (`flEngHours`; part B's, `fleet-seams.ts` `meterHours`). */
export const hoursLoader = async (store: Store): Promise<(e: Engine) => number> => meterHours(await (store.fleetRepo as FleetRepo).engineMeters());
/** Memos linked to jobs, for their cost (`flMaintCalcCost`; part B's memos, `fleet-seams.ts` `linkedMemos`). */
export const memosLoader = async (store: Store): Promise<(jobId: string) => LinkedMemo[]> => linkedMemos(await (store.fleetRepo as FleetRepo).memos());

export function registerFleetRoutes(app: FastifyInstance, deps: { store: Store }): void {
  const { store } = deps;
  const by = (request: Request): string | null => actorOf(request.user) ?? null;
  const fleetRepo = (): FleetRepo => store.fleetRepo as FleetRepo;
  /** The project a job names (`parent_project_id`): it must exist (part B's projects). */
  const projectNamed = async (id: unknown) => {
    if (id === undefined || id === null || id === '') return undefined;
    if (typeof id !== 'string') return bad('parent_project_id must be a project id');
    return (await fleetRepo().project(id.trim())) ?? bad(`parent_project_id ${id} is not a project (GET /v1/fleet/projects)`);
  };

  // ── Reading into a draft, writing it back ──

  type Load = { boats?: boolean; incidents?: Incident[]; jobs?: Job[] };
  /** Every asset (a command may relabel, swap or cascade any), every boat, and the incidents and jobs named. */
  const draftOf = async (load: Load = {}): Promise<FleetDraft> => new FleetDraft(todayInThailand(), {
    engines: await store.fleetAssets('engine'), gearboxes: await store.fleetAssets('gearbox'), propellers: await store.fleetAssets('propeller'),
    boats: load.boats === false ? [] : await store.boatRecords(), incidents: load.incidents ?? [], jobs: load.jobs ?? [],
  }, await hoursLoader(store));
  /** Engines first, so a gearbox's engine exists before the gearbox names it. */
  const commit = async (d: FleetDraft): Promise<void> => {
    for (const id of d.touched.engines) await store.putFleetAsset('engine', d.engines.get(id)!);
    for (const id of d.touched.gearboxes) await store.putFleetAsset('gearbox', d.gearboxes.get(id)!);
    for (const id of d.touched.propellers) await store.putFleetAsset('propeller', d.propellers.get(id)!);
    const now = new Date().toISOString();
    for (const id of d.touched.boats) await store.writeBoat(d.boats.get(id)!, now);
    for (const id of d.touched.incidents) await store.putFleetIncident(d.incidents.get(id)!);
    for (const id of d.touched.jobs) await store.putFleetJob(d.jobs.get(id)!);
  };

  // ── Views: computed fields beside the stored ones ──

  const assetView = (kind: AssetKind, a: AnyAsset, engines: ReadonlyMap<string, Engine>, withLog: boolean, hoursOf: (e: Engine) => number) => {
    const { log, ...rest } = a;
    const out: Record<string, unknown> = { ...rest };
    if (kind === 'engine') {
      const h = hoursOf(a as Engine);
      out.hours = h;
      out.service = engineService(a as Engine, h);
    } else if (kind === 'gearbox') {
      const life = gearboxLifetime(a as Gearbox, (id) => { const e = engines.get(id); return e ? hoursOf(e) : undefined; });
      out.lifetime_hours = life;
      out.service = gearboxService(a as Gearbox, life);
    }
    if (withLog) out.log = log;
    return out;
  };
  const incidentView = (i: Incident, jobs: ReadonlyMap<string, Job>) => ({ ...i, shown_status: shownStatus(i, (id) => jobs.get(id)) });
  /** A job with its cost, the board's lane, how long it has been silent and whether its boat is held today. */
  const jobViews = async (jobs: readonly Job[]) => {
    const today = todayInThailand();
    const boats = new Map((await store.boatRecords()).map((b) => [b.id, b]));
    const work = await openWork(store);
    const memosOf = await memosLoader(store);
    const held = new Map<string, boolean>();
    const blocks = (boatId: string): boolean => {
      if (!held.has(boatId)) {
        const boat = boats.get(boatId);
        const status = boat ? availability(boat, today, work).status : 'available';
        held.set(boatId, status === 'fixing' || status === 'unavailable');
      }
      return held.get(boatId)!;
    };
    return jobs.map((j) => {
      const cost = jobCost(j.parts, memosOf(j.id));
      return { ...j, ...cost, lane: jobLane(j, blocks(j.boat_id), today), silent_days: silentDays(j, today), blocks_boat: blocks(j.boat_id) };
    });
  };
  const jobView = async (j: Job) => (await jobViews([j]))[0];

  // ── Availability ──

  app.get('/v1/fleet/availability', async (request) => {
    const q = query(request);
    const today = todayInThailand();
    const from = q.from === undefined ? today : realDate(q.from, 'from');
    const to = q.to === undefined ? from : realDate(q.to, 'to');
    if (to < from) bad('to must not precede from');
    const days = [...eachDate(from, to)];
    if (days.length > MAX_AVAILABILITY_DAYS) bad(`At most ${MAX_AVAILABILITY_DAYS} days at a time`);
    const boatId = optional(q.boat_id);
    let boats = await store.boatRecords();
    if (boatId) boats = boats.filter((b) => b.id === boatId).length ? boats.filter((b) => b.id === boatId) : notFound('Boat not found');
    const work = await openWork(store, boatId);
    return { days: days.flatMap((date) => boats.map((b) => availability(b, date, work))) };
  });

  // ── Engines, gearboxes, propellers ──

  for (const [path, kind] of Object.entries(ASSET_PATHS)) {
    const base = `/v1/fleet/${path}`;
    const one = async (id: string): Promise<AnyAsset> => (await store.fleetAsset(kind, id)) ?? notFound(`${kind[0].toUpperCase()}${kind.slice(1)} not found`);
    const enginesById = async () => new Map((await store.fleetAssets('engine')).map((e) => [e.id, e]));
    const detail = async (id: string) => assetView(kind, await one(id), await enginesById(), true, await hoursLoader(store));
    /** Runs a command on a draft and answers the asset as it stands after it. */
    const command = (url: string, run: (d: FleetDraft, a: AnyAsset, b: Record<string, unknown>, request: Request) => void | Promise<void>) => {
      app.post(`${base}/:id/${url}`, async (request) => {
        const b = body(request);
        const id = param(request);
        await store.transaction(async () => {
          await one(id);
          const d = await draftOf();
          await run(d, d.asset(kind, id)!, b, request);
          await commit(d);
        });
        return detail(id);
      });
    };

    app.get(base, async (request) => {
      const boatId = optional(query(request).boat_id);
      const engines = await enginesById();
      const hoursOf = await hoursLoader(store);
      return { [ASSET_LIST_KEY[kind]]: (await store.fleetAssets(kind, boatId ? { boatId } : {})).map((a) => assetView(kind, a, engines, false, hoursOf)) };
    });
    app.get(`${base}/:id`, async (request) => detail(param(request)));

    /** The form's add (`flSaveEngine`, `flSaveGearbox`, `flSavePropeller`). */
    app.post(base, async (request, reply) => {
      const input = parseAssetInput(kind, record(request.body), 'create');
      const id = await store.transaction(async () => {
        const d = await draftOf();
        const taken = new Set([...d.engines.keys(), ...d.gearboxes.keys(), ...d.propellers.keys()]);
        const asset = newAsset(kind, newAssetId(kind, taken, Date.now()), input) as AnyAsset & Record<string, unknown>;
        const status = asset.status as string;
        let linked = false;
        if (kind === 'engine' && input.links.boat_id) {
          const boat = d.boats.get(input.links.boat_id) ?? bad(`boat_id ${input.links.boat_id} is not a boat`);
          asset.boat_id = boat.id;
          asset.pos = input.links.pos ?? bad('pos is required with boat_id');
          linked = true;
        }
        if (kind === 'gearbox' && input.links.engine_id && status !== 'spare') {
          const engine = d.engines.get(input.links.engine_id) ?? bad(`engine_id ${input.links.engine_id} is not an engine`);
          assertGearboxFits(asset.id, engine, [...d.gearboxes.values()]);
          asset.engine_id = engine.id; asset.boat_id = engine.boat_id;
          linked = true;
        }
        if (kind === 'propeller' && input.links.gearbox_id && status !== 'spare') {
          const gearbox = d.gearboxes.get(input.links.gearbox_id) ?? bad(`gearbox_id ${input.links.gearbox_id} is not a gearbox`);
          assertPropellerFits(asset.id, gearbox, [...d.propellers.values()]);
          asset.gearbox_id = gearbox.id; asset.boat_id = gearbox.boat_id;
          linked = true;
        }
        asset.spare_location = formSpareLocation(kind, status, linked, (input.facts.spare_location as string | null | undefined) ?? null, null);
        d.put(kind, asset);
        await commit(d);
        return asset.id;
      });
      return reply.code(201).send(await detail(id));
    });

    /** The form's edit: client facts only. */
    app.patch(`${base}/:id`, async (request) => {
      const input = parseAssetInput(kind, record(request.body), 'patch');
      const id = param(request);
      await store.transaction(async () => {
        const current = await one(id);
        await store.putFleetAsset(kind, { ...current, ...input.facts } as never);
      });
      return detail(id);
    });

    /** `flChangeEngStatus`. */
    command('status', (d, a, b) => {
      const status = pickable(kind, b.status);
      const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null;
      d.put(kind, withStatus(kind, a, status, note, d));
    });

    /**
     * Onto a boat (engine), an engine (gearbox) or a gearbox (propeller). An engine with `job_id` fills
     * the place a job start's swap emptied (`flStartSwapInstall`).
     */
    command('install', async (d, a, b) => {
      if (kind === 'engine') {
        const jobId = optional(b.job_id);
        const job = jobId ? (await store.fleetJob(jobId)) ?? bad(`job_id ${jobId} is not a job`) : undefined;
        const boatId = optional(b.boat_id) ?? job?.boat_id ?? bad('boat_id is required');
        if (!d.boats.has(boatId)) bad(`boat_id ${boatId} is not a boat`);
        const pos = optional(typeof b.pos === 'string' ? b.pos.trim() : undefined) ?? bad('pos is required');
        if (job) {
          if (job.boat_id !== boatId) bad(`Job ${job.no} is on another boat`);
          d.jobs.set(job.id, job);
          swapInstall(d, job, a.id, boatId, pos);
        } else d.put('engine', installedEngine(a as Engine, boatId, pos, d));
      } else if (kind === 'gearbox') {
        const engineId = optional(b.engine_id) ?? bad('engine_id is required');
        const engine = d.engines.get(engineId) ?? bad(`engine_id ${engineId} is not an engine`);
        d.put('gearbox', installedGearbox(a as Gearbox, engine, [...d.gearboxes.values()], d));
      } else {
        const gearboxId = optional(b.gearbox_id) ?? bad('gearbox_id is required');
        const gearbox = d.gearboxes.get(gearboxId) ?? bad(`gearbox_id ${gearboxId} is not a gearbox`);
        const pos = b.prop_pos === undefined ? undefined : typeof b.prop_pos === 'string' ? b.prop_pos.trim() || null : b.prop_pos === null ? null : bad('prop_pos must be text');
        d.put('propeller', installedPropeller(a as Propeller, gearbox, [...d.propellers.values()], pos, d));
      }
    });

    /** `flEquipRemove`: kept as a spare, at `spare_location` when sent. */
    command('remove', (d, a, b) => {
      const loc = b.spare_location === undefined ? undefined : b.spare_location === null || b.spare_location === '' ? null : typeof b.spare_location === 'string' ? b.spare_location.trim() : bad('spare_location must be text');
      d.put(kind, removedAsset(kind, a, loc, d));
    });

    /** `flEquipSwapDo`: two of a kind trade places. */
    command('swap', (d, a, b) => {
      const withId = optional(b.with_id) ?? bad('with_id is required');
      const other = d.asset(kind, withId) ?? bad(`with_id ${withId} is not a ${kind}`);
      const [x, y] = swappedPair(kind, a, other, d);
      d.put(kind, x); d.put(kind, y);
    });

    if (kind !== 'engine') {
      /** `flConfirmMove`: a spare to another place. */
      command('move', (d, a, b) => {
        const to = optional(typeof b.spare_location === 'string' ? b.spare_location.trim() : undefined) ?? bad('spare_location is required');
        const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null;
        d.put(kind, movedSpare(a as Gearbox | Propeller, to, note, d));
      });
    }
    if (kind !== 'propeller') {
      /** `flEngMarkService`, `flGbMarkService`: the hour reading becomes the service baseline. */
      command('service', (d, a, b) => {
        d.put(kind, serviced(kind as 'engine' | 'gearbox', a as Engine | Gearbox, parseHours(b), d));
      });
    }
  }

  // ── Incidents ──

  const incidentOr404 = async (id: string): Promise<Incident> => (await store.fleetIncident(id)) ?? notFound('Incident not found');
  const jobsById = async () => new Map((await store.fleetJobs()).map((j) => [j.id, j]));
  const incidentDetail = async (id: string) => incidentView(await incidentOr404(id), await jobsById());

  app.get('/v1/fleet/incidents', async (request) => {
    const q = query(request);
    const status = optional(q.status);
    const jobs = await jobsById();
    let list = (await store.fleetIncidents(optional(q.boat_id) ? { boatId: optional(q.boat_id) } : {})).map((i) => incidentView(i, jobs));
    if (status) list = list.filter((i) => i.shown_status === status || i.status === status);
    return { incidents: list, next_no: nextNo('INC', (await store.fleetNumbers('incidents')).map((x) => x.no)) };
  });
  app.get('/v1/fleet/incidents/:id', async (request) => incidentDetail(param(request)));
  /** `flSaveIncident` (create; with `quick_fix` it is closed at once). */
  app.post('/v1/fleet/incidents', async (request, reply) => {
    const b = record(request.body);
    const id = await store.transaction(async () => {
      const d = await draftOf();
      const inc = newIncident(d, `inc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, b, await store.fleetNumbers('incidents'));
      await commit(d);
      return inc.id;
    });
    return reply.code(201).send(await incidentDetail(id));
  });
  /** The edit form. */
  app.patch('/v1/fleet/incidents/:id', async (request) => {
    const b = record(request.body);
    const id = param(request);
    await store.transaction(async () => {
      const current = await incidentOr404(id);
      const d = await draftOf({ incidents: [current] });
      editedIncident(d, current, b, await store.fleetNumbers('incidents'));
      await commit(d);
    });
    return incidentDetail(id);
  });
  /** `flDeleteIncident`: its job stays, as in legacy. */
  app.delete('/v1/fleet/incidents/:id', async (request, reply) => {
    await store.transaction(async () => {
      if (!(await store.deleteFleetIncident(param(request)))) notFound('Incident not found');
    });
    return reply.code(204).send();
  });
  app.post('/v1/fleet/incidents/:id/log', async (request) => {
    const b = record(request.body);
    const id = param(request);
    await store.transaction(async () => {
      const current = await incidentOr404(id);
      const d = new FleetDraft(todayInThailand(), { incidents: [current] }, await hoursLoader(store));
      incidentLog(d, current, b);
      await commit(d);
    });
    return incidentDetail(id);
  });
  /** The quick swap (`flConfirmSwap`) and what becomes of the old gearbox's propellers (`flConfirmPropCascade`). */
  app.post('/v1/fleet/incidents/:id/swap', async (request) => {
    const b = record(request.body);
    const id = param(request);
    await store.transaction(async () => {
      const current = await incidentOr404(id);
      const d = await draftOf({ incidents: [current] });
      quickSwap(d, current, b);
      await commit(d);
    });
    return incidentDetail(id);
  });

  // ── Jobs ──

  const jobOr404 = async (id: string): Promise<Job> => (await store.fleetJob(id)) ?? notFound('Job not found');
  /** A job's incidents: the one it was made from and any that names it, for `flPushLog`. */
  const incidentsOf = async (job: Job): Promise<Incident[]> => {
    const named = await store.fleetIncidents({ jobId: job.id });
    const from = job.incident_id ? await store.fleetIncident(job.incident_id) : undefined;
    return [...named, ...(from && !named.some((i) => i.id === from.id) ? [from] : [])];
  };
  const newJobId = (): string => `mj${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  /** Runs a command on one job (with its incidents) and answers the job as it stands after it. */
  const jobCommand = (url: string, run: (d: FleetDraft, job: Job, b: Record<string, unknown>, request: Request) => Promise<unknown> | unknown, method: 'post' | 'patch' | 'delete' = 'post') => {
    app[method](`/v1/fleet/jobs/:id${url}`, async (request) => {
      const b = method === 'delete' ? {} : body(request);
      const id = param(request);
      const extra = await store.transaction(async () => {
        const job = await jobOr404(id);
        const d = await draftOf({ incidents: await incidentsOf(job), jobs: [job] });
        const result = await run(d, job, b, request);
        await commit(d);
        return result;
      });
      return { ...(await jobView(await jobOr404(id))), ...(extra && typeof extra === 'object' && !Array.isArray(extra) && !('id' in extra) ? extra : {}) };
    });
  };

  app.get('/v1/fleet/jobs', async (request) => {
    const q = query(request);
    const status = q.status === undefined ? undefined : q.status === 'pending' || q.status === 'inprogress' || q.status === 'done' ? q.status : bad('status must be pending, inprogress or done');
    const jobs = await store.fleetJobs({ ...(optional(q.boat_id) ? { boatId: optional(q.boat_id) } : {}), ...(status ? { status } : {}), ...(optional(q.incident_id) ? { incidentId: optional(q.incident_id) } : {}) });
    return { jobs: await jobViews(jobs), next_no: nextNo('MJ', (await store.fleetNumbers('jobs')).map((x) => x.no)) };
  });
  app.get('/v1/fleet/jobs/:id', async (request) => jobView(await jobOr404(param(request))));

  /** `flSaveCreateJob`: one job, or one per damaged asset of its incident. */
  app.post('/v1/fleet/jobs', async (request, reply) => {
    const b = record(request.body);
    const ids = await store.transaction(async () => {
      const boatId = optional(b.boat_id);
      const incidentId = optional(b.incident_id);
      const incident = incidentId ? await store.fleetIncident(incidentId) : undefined;
      const linked = incident?.job_id ? await store.fleetJob(incident.job_id) : undefined;
      const d = await draftOf({ incidents: incident ? [incident] : [], jobs: linked ? [linked] : [] });
      const open = boatId ? (await store.fleetJobs({ boatId })).filter((j) => j.status !== 'done') : [];
      const project = await projectNamed(b.parent_project_id);
      if (project) d.projectNoOf = () => project.no;
      const made = newJobs(d, b, newJobId, await store.fleetNumbers('jobs'), open);
      await commit(d);
      if (project) await fleetRepo().addProjectLog(projectCreatedLines(project.id, made, d.today));
      return made.map((j) => j.id);
    });
    return reply.code(201).send({ jobs: await jobViews(await store.fleetJobs({ ids })) });
  });
  /** The detail's and the board's fields. */
  jobCommand('', async (d, job, b) => {
    const to = b.parent_project_id === undefined ? undefined : await projectNamed(b.parent_project_id);
    const next = patchedJob(d, job, b, await store.fleetNumbers('jobs'));
    if (next.parent_project_id === job.parent_project_id) return;
    // Linking or unlinking a project writes both logs (`flMaintLinkProjectPick`, `flMaintUnlinkProject`).
    const from = job.parent_project_id ? (await fleetRepo().project(job.parent_project_id)) ?? null : null;
    const lines = projectLinkLines(next, from, to ?? null, d.today);
    next.progress_log.push(...lines.job);
    d.putJob(next);
    await fleetRepo().addProjectLog(lines.project);
  }, 'patch');
  /** `flDeleteMaint`: only a job not closed; its incident keeps the link, as in legacy. */
  app.delete('/v1/fleet/jobs/:id', async (request, reply) => {
    await store.transaction(async () => {
      const job = await jobOr404(param(request));
      if (job.status === 'done') refuse(`${job.no} is closed: a closed job is kept`, 409, 'job_done');
      await store.deleteFleetJob(job.id);
    });
    return reply.code(204).send();
  });

  /** Start (`flMaintStart`). The boat already sailed today when it is deployed today or carries a booking today. */
  jobCommand('/start', async (d, job, b) => {
    const today = d.today;
    const deployed = (await store.listDeployments(today, today)).some((x) => x.boat_id === job.boat_id && x.route_id);
    const carried = deployed || (await store.bookingsOnDate(today)).some((bk) => !(SEAT_RELEASING_STATUSES as readonly string[]).includes(bk.status)
      && bk.trips.some((t) => t.service_date === today && (t.operations.boat_id === job.boat_id || t.operations.boat_splits.some((s) => s.boat_id === job.boat_id))));
    startedJob(d, job, b, carried);
  });
  /** Close (`flMaintClose`). Answers `boat_status_after` and how many service baselines were reset. */
  jobCommand('/close', async (d, job, b) => {
    const incidentJobs = job.incident_id ? await store.fleetJobs({ incidentId: job.incident_id }) : [];
    const hoursOf = await hoursLoader(store);
    const memosOf = await memosLoader(store);
    const lifetimeOf = (g: Gearbox) => gearboxLifetime(g, (id) => { const e = d.engines.get(id); return e ? hoursOf(e) : undefined; });
    const { boat_status_after, service_reset } = closedJob(d, job, b, {
      cost: jobCost(job.parts, memosOf(job.id)).cost, otherWork: await openWork(store, job.boat_id), incidentJobs, lifetimeOf,
    });
    return { boat_status_after, service_reset };
  });
  /** The manual "reset service hours" (`flMaintServiceResetManual`). */
  jobCommand('/reset-service', async (d, job) => {
    if (!looksLikeService(job)) refuse(`${job.no} is not a service job with engines or gearboxes: nothing reset`, 409, 'not_a_service');
    const hoursOf = await hoursLoader(store);
    const lifetimeOf = (g: Gearbox) => gearboxLifetime(g, (id) => { const e = d.engines.get(id); return e ? hoursOf(e) : undefined; });
    return { service_reset: resetService(d, job, lifetimeOf) };
  });
  jobCommand('/boat-status', (d, job, b) => { jobBoatStatusChange(d, job, b); });
  jobCommand('/assets', (d, job, b) => { addedJobAsset(d, job, b); });
  jobCommand('/assets/:idx', (d, job, _b, request) => { removedJobAsset(d, job, indexOf(request, 'idx')); }, 'delete');
  jobCommand('/log', (d, job, b) => { jobLog(d, job, b); });
  /** One job per engine; answers the job and `created`, the new jobs. */
  jobCommand('/split', async (d, job, b) => {
    const project = job.parent_project_id ? await fleetRepo().project(job.parent_project_id) : undefined;
    if (project) d.projectNoOf = () => project.no;
    const made = splitJob(d, job, b, newJobId, await store.fleetNumbers('jobs'));
    if (project && made.length > 1) await fleetRepo().addProjectLog([projectSplitLine(project.id, job.no, made.slice(1).map((j) => j.no), d.today)]);
    return { created: made.slice(1).map((j) => ({ id: j.id, no: j.no, title: j.title })) };
  });
  jobCommand('/steps', (d, job, b, request) => {
    const textValue = typeof b.text === 'string' && b.text.trim() ? b.text.trim() : bad('text is required');
    changedSteps(d, job, { add: textValue }, by(request));
  });
  jobCommand('/steps/template', (d, job, _b, request) => { changedSteps(d, job, { template: true }, by(request)); });
  jobCommand('/steps/:idx', (d, job, b, request) => {
    if (typeof b.done !== 'boolean') bad('done must be true or false');
    changedSteps(d, job, { index: indexOf(request, 'idx'), done: b.done as boolean }, by(request));
  }, 'patch');
  jobCommand('/steps/:idx', (d, job, _b, request) => { changedSteps(d, job, { index: indexOf(request, 'idx'), remove: true }, by(request)); }, 'delete');
}

const indexOf = (request: Request, name: string): number => {
  const raw = (request.params as Record<string, string>)[name];
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : refuse(`${name} must be a whole number, 0 or more`, 400);
};

/** A boat's availability today, for the boat views (`status_effective`, `blocked_by`). */
export async function boatsAvailableToday(store: Store, boats: readonly BoatRecord[]): Promise<Map<string, ReturnType<typeof availability>>> {
  const today = todayInThailand();
  const work = await openWork(store, boats.length === 1 ? boats[0].id : undefined);
  return new Map(boats.map((b) => [b.id, availability(b, today, work)]));
}
