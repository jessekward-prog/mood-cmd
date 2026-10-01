// Push notifications through an ntfy server. Optional: with NTFY_URL unset the app works and
// the push buttons say it isn't set up. NTFY_TOKEN is only needed for a server with auth on.
export const pushConfigured = () => !!process.env.NTFY_URL

export async function push(payload) {
  if (!pushConfigured()) throw new Error('Push is not set up on this server (NTFY_URL is empty).')
  const token = process.env.NTFY_TOKEN
  let res
  try {
    res = await fetch(`${process.env.NTFY_URL.replace(/\/+$/, '')}/`, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      // JSON to the root URL, not headers: a non-ASCII Title header throws inside fetch
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(payload),
    })
  } catch (e) {
    throw new Error(`Couldn't reach ntfy (${e.cause?.code || e.message}).`)
  }
  if (!res.ok) throw new Error(`ntfy answered HTTP ${res.status}`)
}

// Click-through and icon links only work once the app has a public https address.
export function links(origin, hash) {
  return origin ? { click: `${origin}/${hash}`, icon: `${origin}/icons/icon-192.png` } : {}
}
