import pg from 'pg'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const here = dirname(fileURLToPath(import.meta.url))

// Coolify hands us DATABASE_URL; Hostess injects DB_* individually as well. Support both
// so the same image deploys either way without a per-host config step.
function connectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const { DB_HOST, DB_PORT = 5432, DB_NAME, DB_USER, DB_PASSWORD } = process.env
  if (!DB_HOST || !DB_NAME || !DB_USER) return null
  return `postgres://${DB_USER}:${encodeURIComponent(DB_PASSWORD || '')}@${DB_HOST}:${DB_PORT}/${DB_NAME}`
}

const cs = connectionString()
if (!cs) {
  console.error('No DATABASE_URL (or DB_HOST/DB_NAME/DB_USER) in the environment. The database is the one thing this app cannot run without.')
  process.exit(1)
}

// Hostess's bundled Postgres speaks no TLS and appends sslmode=disable; Coolify's internal
// one wants it disabled too. Let the connection string decide, not NODE_ENV.
const ssl = /sslmode=disable/i.test(cs)
  ? false
  : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false

export const pool = new pg.Pool({ connectionString: cs, ssl })

export async function migrate() {
  await pool.query(readFileSync(join(here, '..', 'schema.sql'), 'utf8'))
}

export const get = async k => (await pool.query('SELECT value FROM settings WHERE key=$1', [k])).rows[0]?.value ?? null
export const set = (k, v) => pool.query(
  'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [k, v])

const DEFAULT_PREFS = { topic: process.env.NTFY_TOPIC || 'mood-cmd', nudgeTimes: ['09:00', '20:00'], reportDay: 0, reportTime: '19:00', tz: 'UTC' }
export const prefs = async () => ({ ...DEFAULT_PREFS, ...JSON.parse((await get('prefs')) || '{}') })
export const savePrefs = p => set('prefs', JSON.stringify(p))

export const toEntry = r => ({ id: r.id, ts: r.ts.getTime(), period: r.period, mood: r.mood, energy: r.energy,
  sleep: r.sleep, calm: r.calm, connection: r.connection, pos: r.pos, neg: r.neg })
export const toReport = r => ({ id: r.id, ts: r.ts.getTime(), days: r.days, n: r.n, model: r.model, text: r.text, support: r.support, scheduled: r.scheduled })
