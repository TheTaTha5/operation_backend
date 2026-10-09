/**
 * Which of legacy's B2C bookings the import copies (todo/b2c-sync-model.md, decisions 2 and 7). Pure,
 * so `test/legacy-b2c.test.ts` checks it; `import-legacy.ts` asks it about every legacy booking.
 *
 * Legacy's pull stores each line of a Love Kingdom order as `b2c_<order>_<line>`. Love Kingdom now
 * pushes its orders here itself (`POST /v1/bookings`, `external_id` = `<order>`), so a copy of the
 * same order from legacy would hold the same seats twice. `--b2c=<mode>` says how far the switch-over
 * has gone; the default is today's behaviour, so nothing changes until someone chooses:
 *
 * - `all` (default): every B2C booking is imported, as before Love Kingdom pushed;
 * - `pushed`: skip the orders Love Kingdom has pushed here; import the rest;
 * - `none`: skip them all, Love Kingdom's push being the only source.
 *
 * In every mode the test orders `b2c_BK-…` are skipped (decision 7): 9 rows, 3 still confirmed.
 */
export const B2C_MODES = ['all', 'pushed', 'none'] as const;
export type B2CMode = typeof B2C_MODES[number];

/** `--b2c=<mode>` from the command line; `all` when absent. An unknown mode stops the run. */
export function parseB2CMode(argv: readonly string[]): B2CMode {
  const arg = argv.find((a) => a === '--b2c' || a.startsWith('--b2c='));
  if (arg === undefined) return 'all';
  const mode = arg.slice('--b2c='.length);
  if (!(B2C_MODES as readonly string[]).includes(mode)) throw new Error(`--b2c must be one of ${B2C_MODES.join(', ')} (got "${arg}")`);
  return mode as B2CMode;
}

/** Love Kingdom's order in a legacy B2C booking id: `b2c_LOV-8161340_1` → `LOV-8161340`. Undefined for any other booking. */
export function b2cOrderOf(legacyId: string): string | undefined {
  const match = /^b2c_(.+)_\d+$/.exec(legacyId);
  return match ? match[1] : undefined;
}

/**
 * Why a legacy booking is not imported, as a report note, or undefined to import it. `pushed` holds the
 * `external_id`s of the bookings Love Kingdom has pushed here.
 */
export function b2cSkipReason(legacyId: string, mode: B2CMode, pushed: ReadonlySet<string>): string | undefined {
  if (!legacyId.startsWith('b2c_')) return undefined;
  if (legacyId.startsWith('b2c_BK-')) return 'B2C test bookings not imported (b2c_BK-…)';
  if (mode === 'none') return 'B2C bookings not imported (--b2c=none: Love Kingdom pushes them)';
  const order = b2cOrderOf(legacyId);
  if (mode === 'pushed' && order !== undefined && pushed.has(order)) return 'B2C bookings not imported (--b2c=pushed: Love Kingdom pushed the order)';
  return undefined;
}
