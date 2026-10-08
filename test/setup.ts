/**
 * Loaded before every test file (`npm test`'s `--import`). Only PostgreSQL needs it.
 *
 * Migration 006 seeds production's route calendars, and every one of them ends by 2027. Bookings
 * on a closed day are refused (`route_closed`), so a suite that books in 2028 and later would test
 * the calendar everywhere instead of what each test is about. This opens 2028–2099 on every seeded
 * route; a test about the calendar closes its own days with a day override, which beats a season.
 *
 * It also adds `test-land`, a land route, because the seed has none and the land-route rules need
 * one to run against.
 *
 * Fixed ids and `ON CONFLICT DO NOTHING`, because every test file runs it in its own process.
 */
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (url) {
  const pool = new pg.Pool({ connectionString: url });
  try {
    await pool.query(`INSERT INTO routes (id, name, kind) VALUES ('test-land', 'Test land transfer', 'land') ON CONFLICT (id) DO NOTHING`);
    await pool.query(`INSERT INTO route_seasons (id, route_id, kind, from_date, to_date)
      SELECT 'test-open-' || id, id, 'open', '2028-01-01', '2099-12-31' FROM routes WHERE kind = 'marine'
      ON CONFLICT (id) DO NOTHING`);
  } finally {
    await pool.end();
  }
}
