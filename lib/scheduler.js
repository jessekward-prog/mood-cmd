import { pool, get, set, prefs } from './db.js'
import { generateReport, reportPushText, libraryConfigured, local, blockOf } from './report.js'
import { push, pushConfigured, links } from './push.js'

const NUDGE = 'Check-in time. Two bars, two thoughts, ten seconds.'
const GRACE_MIN = 15 // a nudge still goes out if the server was down for its exact minute
const toMin = hm => +hm.slice(0, 2) * 60 + +hm.slice(3)

async function nudges(appUrl) {
  const p = await prefs()
  if (!pushConfigured() || !p.nudgeTimes.length) return
  const now = local(Date.now(), p.tz)
  const fired = JSON.parse((await get('fired_nudges')) || '{}')
  const today = fired[now.date] || []
  for (const t of p.nudgeTimes) {
    const late = toMin(now.hm) - toMin(t)
    if (late < 0 || late > GRACE_MIN || today.includes(t)) continue
    today.push(t)
    await set('fired_nudges', JSON.stringify({ [now.date]: today })) // marked before sending, so a failure can't repeat-fire
    // skip if they've already checked in this morning, afternoon or night (whichever this nudge falls in)
    const block = blockOf(Date.now(), p.tz)
    const { rows } = await pool.query("SELECT ts FROM entries WHERE ts > now() - interval '24 hours'")
    if (rows.some(r => blockOf(r.ts.getTime(), p.tz) === block)) {
      console.log(`nudge ${t}: skipped, already checked in (${block})`)
      continue
    }
    try { await push({ topic: p.topic, title: 'MOOD CMD', message: NUDGE, ...links(await appUrl(), '#play') }); console.log(`nudge ${t}: sent`) }
    catch (e) { console.error(`nudge ${t}:`, e.message) }
  }
}

async function weekly(appUrl) {
  const p = await prefs()
  if (p.reportDay === null || !libraryConfigured()) return
  const now = local(Date.now(), p.tz)
  if (now.dow !== p.reportDay || now.hm < p.reportTime) return
  const st = JSON.parse((await get('weekly')) || '{}')
  if (st.done === now.date) return
  // a cold model can take minutes to load and the first call may time out: retry every 10 minutes until midnight
  if (st.tried && Date.now() - st.tried < 10 * 60e3) return
  await set('weekly', JSON.stringify({ tried: Date.now() }))
  try {
    const r = await generateReport(7, { scheduled: true })
    await set('weekly', JSON.stringify({ done: now.date }))
    console.log('weekly report: written')
    if (pushConfigured()) await push({ topic: p.topic, title: 'MOOD CMD · weekly report', message: reportPushText(r.text), ...links(await appUrl(), '#report') })
  } catch (e) {
    if (e.status === 400) await set('weekly', JSON.stringify({ done: now.date })) // too few check-ins: nothing to retry
    console.error('weekly report:', e.message)
  }
}

export function startScheduler(appUrl) {
  const tick = () => nudges(appUrl).then(() => weekly(appUrl)).catch(e => console.error('scheduler:', e.message))
  const timer = setInterval(tick, 30_000)
  tick()
  return () => clearInterval(timer)
}
