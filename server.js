// mood-cmd: ten-second mood and energy check-ins, reports written by a local LM Studio model,
// nudges and reports pushed through ntfy. Single user, PIN-gated.
import express from 'express'
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { pool, migrate, get, set, prefs, savePrefs, toEntry, toReport } from './lib/db.js'
import { generateReport, reportPushText, libraryConfigured, loadLm, saveLm, lmState, PERIODS } from './lib/report.js'
import { push, pushConfigured, links } from './lib/push.js'
import { startScheduler } from './lib/scheduler.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3048

const app = express()
app.set('x-powered-by', false)
app.use(express.json({ limit: '64kb' }))

/* ── auth: one PIN, hashed with scrypt; a bearer token on every data route ── */

const PIN_RE = /^\d{4,8}$/
const hashPin = (pin, salt) => scryptSync(String(pin), salt, 32).toString('hex')
const same = (a, b) => {
  if (!a || !b) return false
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

// A new token on every PIN set/change, so changing the PIN signs out every other device.
async function savePin(pin) {
  const salt = randomBytes(16).toString('hex'), token = randomBytes(32).toString('hex')
  await set('pin_salt', salt); await set('pin_hash', hashPin(pin, salt)); await set('token', token)
  return token
}
async function pinMatches(pin) {
  const [salt, hash] = await Promise.all([get('pin_salt'), get('pin_hash')])
  return !!hash && same(hashPin(String(pin ?? ''), salt), hash)
}

// A 4-digit PIN is 10,000 guesses and this can sit on a public URL, so five wrong guesses lock
// PIN entry for five minutes. Global rather than per-IP, which a guesser could sidestep.
let fails = 0, lockedUntil = 0
function lockedOut(res) {
  const s = Math.ceil((lockedUntil - Date.now()) / 1000)
  if (s <= 0) return false
  res.status(429).json({ error: `Too many wrong PINs. Try again in ${Math.ceil(s / 60)} min.`, retryAfter: s })
  return true
}
const wrongPin = () => { if (++fails >= 5) { lockedUntil = Date.now() + 5 * 60e3; fails = 0 } }

async function requireAuth(req, res, next) {
  const sent = (req.headers.authorization || '').replace(/^Bearer /, '')
  if (!same(sent, await get('token'))) return res.status(401).json({ error: 'locked' })
  next()
}

const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(req.method, req.path, e.message); res.status(500).json({ error: 'Server error.' }) })

app.get('/api/auth/status', wrap(async (_req, res) => res.json({ configured: !!(await get('pin_hash')) })))

app.post('/api/auth/setup', wrap(async (req, res) => {
  if (await get('pin_hash')) return res.status(409).json({ error: 'A PIN is already set.' })
  const pin = String(req.body?.pin ?? '')
  if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'The PIN must be 4 to 8 digits.' })
  res.json({ token: await savePin(pin) })
}))

app.post('/api/auth/login', wrap(async (req, res) => {
  if (lockedOut(res)) return
  if (!(await get('pin_hash'))) return res.status(409).json({ error: 'No PIN is set yet.' })
  if (!(await pinMatches(req.body?.pin))) { wrongPin(); return res.status(401).json({ error: 'Wrong PIN.' }) }
  fails = 0
  res.json({ token: await get('token') })
}))

app.post('/api/auth/change', requireAuth, wrap(async (req, res) => {
  if (lockedOut(res)) return
  if (!(await pinMatches(req.body?.current))) { wrongPin(); return res.status(401).json({ error: 'Current PIN is wrong.' }) }
  const pin = String(req.body?.pin ?? '')
  if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'The PIN must be 4 to 8 digits.' })
  res.json({ token: await savePin(pin) })
}))

/* ── Hostess's ai link: the dashboard card reads and changes the library connection with the
   SYNC_SECRET Hostess generated for this app. The PIN token works too. ── */

const SYNC_SECRET = process.env.SYNC_SECRET || ''
const authOrSync = (req, res, next) => (SYNC_SECRET && same(req.headers['x-sync-secret'], SYNC_SECRET) ? next() : requireAuth(req, res, next))

app.get('/api/lm', authOrSync, wrap(async (_req, res) => res.json(await lmState())))
app.put('/api/lm', authOrSync, wrap(async (req, res) => {
  const b = req.body || {}
  if (b.provider && b.provider !== 'local') return res.status(400).json({ error: 'mood-cmd only runs on a local model.' })
  if (typeof b.url === 'string' && b.url.trim() && !/^https?:\/\/\S+$/.test(b.url.trim())) return res.status(400).json({ error: 'The address must start with http:// or https://' })
  await saveLm(b)
  res.json(await lmState())
}))

/* ── data: everything below needs the token ── */

const api = express.Router()
api.use(requireAuth)

// Scheduled pushes have no request to read an origin from, so remember the public one the app
// is opened on. APP_URL wins when set.
const originOf = req => {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim()
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
  return `${proto}://${host}`
}
const appUrl = async () => process.env.APP_URL?.replace(/\/+$/, '') || (await get('app_url'))

api.get('/state', wrap(async (req, res) => {
  const origin = originOf(req)
  if (/^https:\/\//.test(origin) && origin !== (await get('app_url'))) await set('app_url', origin)
  const [entries, reports] = await Promise.all([
    pool.query('SELECT * FROM entries ORDER BY ts'),
    pool.query('SELECT * FROM reports ORDER BY ts DESC LIMIT 12'),
  ])
  res.json({ entries: entries.rows.map(toEntry), reports: reports.rows.map(toReport), settings: await prefs(),
    features: { push: pushConfigured(), library: libraryConfigured() } })
}))

const score = v => Number.isInteger(v) && v >= 1 && v <= 10
api.post('/entries', wrap(async (req, res) => {
  const { period, mood, energy, extra } = req.body || {}
  const pos = String(req.body?.pos ?? '').trim().slice(0, 160), neg = String(req.body?.neg ?? '').trim().slice(0, 160)
  if (!PERIODS[period] || !score(mood) || !score(energy) || !score(extra) || !pos || !neg) {
    return res.status(400).json({ error: 'A check-in needs a time of day, three scores from 1 to 10 and both thoughts.' })
  }
  const col = PERIODS[period].key // from a fixed map, never from the request
  const { rows } = await pool.query(`INSERT INTO entries (period, mood, energy, ${col}, pos, neg) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [period, mood, energy, extra, pos, neg])
  res.json(toEntry(rows[0]))
}))

const UUID_RE = /^[0-9a-f-]{36}$/i
api.delete('/entries/:id', wrap(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'No such entry.' })
  const { rowCount } = await pool.query('DELETE FROM entries WHERE id = $1', [req.params.id])
  res.status(rowCount ? 200 : 404).json(rowCount ? { ok: true } : { error: 'No such entry.' })
}))

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
api.put('/settings', wrap(async (req, res) => {
  const b = req.body || {}, next = await prefs()
  const bad = msg => res.status(400).json({ error: msg })
  if (b.topic !== undefined) { if (!/^[-_A-Za-z0-9]{1,64}$/.test(b.topic)) return bad('Topic: letters, numbers, - and _ only.'); next.topic = b.topic }
  if (b.nudgeTimes !== undefined) {
    if (!Array.isArray(b.nudgeTimes) || b.nudgeTimes.length > 4 || !b.nudgeTimes.every(t => TIME_RE.test(t))) return bad('Up to 4 nudge times, as HH:MM.')
    next.nudgeTimes = [...new Set(b.nudgeTimes)].sort()
  }
  if (b.reportDay !== undefined) {
    if (!(b.reportDay === null || (Number.isInteger(b.reportDay) && b.reportDay >= 0 && b.reportDay <= 6))) return bad('Report day must be 0-6 or off.')
    next.reportDay = b.reportDay
  }
  if (b.reportTime !== undefined) { if (!TIME_RE.test(b.reportTime)) return bad('Report time must be HH:MM.'); next.reportTime = b.reportTime }
  if (b.tz !== undefined) {
    try { new Intl.DateTimeFormat('en-AU', { timeZone: b.tz }) } catch { return bad('Unknown time zone.') }
    next.tz = b.tz
  }
  await savePrefs(next)
  res.json(next)
}))

api.post('/report', wrap(async (req, res) => {
  const days = [7, 30].includes(req.body?.days) ? req.body.days : 7
  try { res.json(await generateReport(days)) }
  catch (e) { res.status(e.status || 502).json({ error: e.message }) }
}))

api.post('/reports/:id/push', wrap(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'No such report.' })
  const { rows: [r] } = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id])
  if (!r) return res.status(404).json({ error: 'No such report.' })
  const { topic } = await prefs()
  try {
    await push({ topic, title: `MOOD CMD · ${r.days}-day report`, message: reportPushText(r.text), ...links(await appUrl(), '#report') })
    res.json({ ok: true })
  } catch (e) { res.status(502).json({ error: e.message }) }
}))

api.post('/push/test', wrap(async (_req, res) => {
  const { topic } = await prefs()
  try {
    await push({ topic, title: 'MOOD CMD', message: 'Check-in time. Two bars, two thoughts, ten seconds.', ...links(await appUrl(), '#play') })
    res.json({ ok: true })
  } catch (e) { res.status(502).json({ error: e.message }) }
}))

api.delete('/data', wrap(async (_req, res) => {
  await pool.query('DELETE FROM entries'); await pool.query('DELETE FROM reports')
  res.json({ ok: true })
}))

app.use('/api', api)

/* ── the page, its icons and manifest (public: a phone fetches the push icon with no login) ── */

app.use(express.static(join(ROOT, 'public'), {
  setHeaders: (res, path) => res.setHeader('Cache-Control', path.endsWith('.html') ? 'no-store' : 'public, max-age=86400'),
}))

// An operator can preseed or reset the PIN from the env panel instead of the first-launch screen.
async function seedPin() {
  const pin = String(process.env.APP_PIN || '')
  if (!pin) return
  if (!PIN_RE.test(pin)) return console.error('APP_PIN ignored: it must be 4 to 8 digits.')
  if (await pinMatches(pin)) return // unchanged, so keep the existing token and sessions
  await savePin(pin)
  console.log('PIN set from APP_PIN')
}

migrate().then(seedPin).then(loadLm).then(() => {
  const server = app.listen(PORT, '0.0.0.0', () => console.log(`mood-cmd on :${PORT} (push ${pushConfigured() ? 'on' : 'off'}, library ${libraryConfigured() ? 'on' : 'off'})`))
  const stopScheduler = startScheduler(appUrl)
  // Redeploys send SIGTERM then SIGKILL ten seconds later. Node as PID 1 has no default
  // handler, so without this the signal is dropped and the process is killed mid-write.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      console.log(`${sig}: closing`)
      stopScheduler()
      server.close(() => pool.end().then(() => process.exit(0), () => process.exit(0)))
      setTimeout(() => process.exit(0), 4000).unref()
    })
  }
}).catch(e => { console.error('startup failed:', e.message); process.exit(1) })
