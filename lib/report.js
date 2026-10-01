import { pool, prefs, toEntry, toReport } from './db.js'

// The extra score each time of day carries. Mirrors PERIODS in public/index.html.
export const PERIODS = {
  morn: { name: 'morning', key: 'sleep' },
  arvo: { name: 'afternoon', key: 'calm' },
  night: { name: 'night', key: 'connection' },
}

// Wall-clock parts of a timestamp in the user's own zone. The server runs in UTC;
// "mornings", weekdays and nudge times only mean something in local time.
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export function local(ts, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(new Date(ts)).map(x => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, hour: +p.hour, dow: DOW.indexOf(p.weekday) }
}
const stamp = (ts, tz) => new Date(ts).toLocaleString('en-AU', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

const SYSTEM = `You review one person's mood log and write them a short, warm, practical report. Talk to them directly as "you".
You are not a therapist: never diagnose or name conditions. Use only the numbers in STATS and never invent statistics. When you mention something from the log, quote their own words in double quotes.

Write exactly these five sections. Each heading is in capitals, on its own line, followed by a colon:
HEADLINE: one sentence in normal sentence case, on the same line as the heading.
PATTERNS: 2-3 bullets on how mood and energy moved. Each bullet cites a number from STATS. If STATS compares high and low sleep, calm or connection, one bullet must cover that comparison.
LIFTS YOU: 2-3 bullets drawn from BEST CHECK-INS.
DRAGS YOU: 2-3 bullets drawn from WORST CHECK-INS and LOW-ENERGY CHECK-INS.
NEXT MOVES: 2-3 small, specific things to try this coming week, each tied to something in the log.

Bullets start with "- ". Under 230 words in total. Plain text only: no markdown, no bold, no other headings.`

function buildPrompt(entries, days, tz) {
  const avg = (xs, k) => xs.reduce((a, x) => a + x[k], 0) / xs.length
  const f1 = n => n.toFixed(1)
  const pair = xs => xs.length ? `mood ${f1(avg(xs, 'mood'))}, energy ${f1(avg(xs, 'energy'))} (${xs.length} check-ins)` : 'no check-ins'
  const line = e => { const P = PERIODS[e.period], xv = e[P.key]
    return `${stamp(e.ts, tz)} (${P.name}) | mood ${e.mood} | energy ${e.energy}${xv != null ? ` | ${P.key} ${xv}` : ''} | good: ${e.pos} | bad: ${e.neg}` }
  // a 12B model still fumbles comparisons, so they're stated in words
  const diff = (a, b, k) => { const d = avg(a, k) - avg(b, k); return Math.abs(d) < 0.3 ? `${k} about the same` : `${k} ${f1(Math.abs(d))} ${d < 0 ? 'lower' : 'higher'}` }
  const groups = Object.entries(PERIODS).map(([k, P]) => [P, entries.filter(e => e.period === k)])
  const periodLines = groups.filter(([, xs]) => xs.length).map(([P, xs]) => { const ex = xs.filter(e => e[P.key] != null)
    return `${P.name}s: ${pair(xs)}${ex.length ? `, average ${P.key} ${f1(avg(ex, P.key))}` : ''}` })
  const morn = groups[0][1], night = groups[2][1]
  const amPm = morn.length && night.length ? `nights compared with mornings: ${diff(night, morn, 'mood')}, ${diff(night, morn, 'energy')}` : ''
  // how each time-of-day score lines up with mood and energy: high (7 or more) against low (4 or less)
  const links = groups.map(([P, xs]) => { const k = P.key, lo = xs.filter(e => e[k] != null && e[k] <= 4), hi = xs.filter(e => e[k] >= 7)
    return lo.length >= 2 && hi.length >= 2 ? `${P.name} check-ins with ${k} 7 or more (${hi.length}) compared with ${k} 4 or less (${lo.length}): ${diff(hi, lo, 'mood')}, ${diff(hi, lo, 'energy')}` : '' }).filter(Boolean)
  const byDow = DOW.map((n, d) => [n, entries.filter(e => local(e.ts, tz).dow === d)])
  const dayAvgs = byDow.filter(([, xs]) => xs.length >= 2).map(([n, xs]) => [n, avg(xs, 'mood'), avg(xs, 'energy')])
  const ext = (i, k) => { const o = dayAvgs.slice().sort((a, b) => b[i] - a[i]); return o.length >= 2 ? `best ${k} day: ${o[0][0]} (${f1(o[0][i])}), worst ${k} day: ${o.at(-1)[0]} (${f1(o.at(-1)[i])})` : '' }
  const byMood = entries.slice().sort((a, b) => b.mood - a.mood || b.energy - a.energy)
  const lowEnergy = entries.filter(e => e.energy <= 4)
  return [`Report for the last ${days} days.`, '',
    'STATS (every score is 1-10 and higher is better; sleep is rated in the morning, calm in the afternoon, connection at night)',
    `all: ${pair(entries)}`, ...periodLines, ...[amPm, ...links, ext(1, 'mood'), ext(2, 'energy')].filter(Boolean),
    ...byDow.filter(([, xs]) => xs.length).map(([n, xs]) => `${n}: ${pair(xs)}`), '',
    'BEST CHECK-INS', ...byMood.slice(0, 5).map(line), '',
    'WORST CHECK-INS', ...byMood.slice(-5).reverse().map(line), '',
    'LOW-ENERGY CHECK-INS (energy 4 or less)', ...(lowEnergy.length ? lowEnergy.slice(-12).map(line) : ['none']), '',
    'FULL LOG', ...entries.map(line)].join('\n')
}

// Safety is decided here, not by the model: small models apply "only if" instructions unreliably.
const CRISIS = /suicid|kill myself|end it all|self[- ]?harm|hurt myself|no point|hopeless|can'?t go on|want to be here/i
const needsSupport = es => (es.length >= 3 && es.slice(-3).every(e => e.mood <= 3)) || es.some(e => CRISIS.test(e.pos + ' ' + e.neg))

export const libraryConfigured = () => !!process.env.LM_STUDIO_URL

async function callLibrary(user) {
  const base = process.env.LM_STUDIO_URL.replace(/\/+$/, '').replace(/\/v1$/, '')
  const key = process.env.LM_STUDIO_API_KEY
  const body = { temperature: 0.5, max_tokens: 1200, reasoning_effort: 'none', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] }
  // No model set means "whatever the operator has loaded" -- never pin a literal id here.
  if (process.env.LM_STUDIO_MODEL) body.model = process.env.LM_STUDIO_MODEL
  let res
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(180_000),
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
    })
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'The library took longer than 3 minutes to answer.' : `Couldn't reach the library (${e.cause?.code || e.message}).`)
  }
  const raw = await res.text()
  let j
  try { j = JSON.parse(raw) } catch {
    // a proxy in front of the model (Cloudflare, say) answers with an HTML page while a cold model loads
    throw new Error(res.status >= 500 ? `The library didn't answer in time (HTTP ${res.status}). It's probably still loading the model, so try again in a minute.` : `Unexpected reply from the library (HTTP ${res.status}).`)
  }
  if (!res.ok || j.error) throw new Error(`The library said: ${j.error?.message || j.error || `HTTP ${res.status}`}`)
  const text = j.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error(`The library sent back an empty report (finish reason: ${j.choices?.[0]?.finish_reason || 'unknown'}).`)
  return { text, model: j.model || null }
}

// One library call at a time: the library is a single GPU, and parallel calls make every one of them crawl.
let queue = Promise.resolve()
export function generateReport(days, { scheduled = false } = {}) {
  const run = queue.then(async () => {
    const { tz } = await prefs()
    const { rows } = await pool.query('SELECT * FROM entries WHERE ts > now() - make_interval(days => $1) ORDER BY ts', [days])
    const entries = rows.map(toEntry)
    if (entries.length < 3) throw Object.assign(new Error(`Need at least 3 check-ins in the last ${days} days for a report (there are ${entries.length}).`), { status: 400 })
    const { text, model } = await callLibrary(buildPrompt(entries, days, tz))
    const { rows: [r] } = await pool.query(
      'INSERT INTO reports (days, n, model, text, support, scheduled) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [days, entries.length, model, text, needsSupport(entries), scheduled])
    return toReport(r)
  })
  queue = run.catch(() => {})
  return run
}

// The report as plain text for a push notification: headline, then each section's bullets.
const SECTIONS = ['PATTERNS', 'LIFTS YOU', 'DRAGS YOU', 'NEXT MOVES']
export function reportPushText(text) {
  const out = {}; let cur = null
  for (const raw of text.split('\n')) {
    const m = raw.match(/^\s*(HEADLINE|PATTERNS|LIFTS YOU|DRAGS YOU|NEXT MOVES)\s*:\s*(.*)$/i)
    if (m) { cur = m[1].toUpperCase(); out[cur] = m[2].trim() ? [m[2].trim()] : []; continue }
    if (cur && raw.trim()) out[cur].push(raw.trim().replace(/^[-*•]\s*/, ''))
  }
  if (Object.keys(out).length < 3) return text.slice(0, 3800)
  return [out.HEADLINE?.join(' '), ...SECTIONS.filter(k => out[k]?.length).map(k => `${k}\n${out[k].map(x => '- ' + x).join('\n')}`)]
    .filter(Boolean).join('\n\n').slice(0, 3800)
}
