// Moves Locus's data between devices, because localStorage doesn't. The
// sending device stashes a snapshot under a short code; the receiving device
// redeems that code once and adopts the state.
//
// This is also the app's only backup path - a single browser's localStorage is
// otherwise the sole copy of everything.
//
// Security shape: the code IS the credential, so it's 8 characters from an
// unambiguous alphabet (~2.8 trillion combinations), single-use, and expires
// after 15 minutes. Redeeming deletes it. That's why there's no way to list
// codes and no endpoint that returns a snapshot without one.
import { getStore } from '@netlify/blobs'

const TTL_MS = 15 * 60 * 1000
const MAX_BYTES = 512 * 1024
// No 0/O/1/I/L - they get misread when typed off a phone screen.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

function transferStore() {
  const opts = { name: 'locus-transfer', consistency: 'strong' }
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID
  if (process.env.NETLIFY_API_TOKEN && siteID) {
    opts.siteID = siteID
    opts.token = process.env.NETLIFY_API_TOKEN
  }
  return getStore(opts)
}

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS })
  if (req.method !== 'POST') return new Response('POST only.', { status: 405, headers: CORS })

  const raw = await req.text()
  if (raw.length > MAX_BYTES) return json({ error: 'Too large' }, 413)

  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  const store = transferStore()

  // Sending device: stash the payload, hand back a code.
  if (body.action === 'create') {
    if (!body.state || typeof body.state !== 'object') return json({ error: 'Missing state' }, 400)
    const code = makeCode()
    await store.setJSON(code, { state: body.state, expiresAt: Date.now() + TTL_MS })
    return json({ code, expiresInMinutes: Math.round(TTL_MS / 60000) })
  }

  // Receiving device: redeem it once.
  if (body.action === 'claim') {
    const code = String(body.code || '').trim().toUpperCase()
    if (!code) return json({ error: 'Missing code' }, 400)

    const entry = await store.get(code, { type: 'json' })
    if (!entry) return json({ error: 'That code is not valid - check it, or generate a new one.' }, 404)

    // Single use: gone whether or not it had expired.
    await store.delete(code)

    if (Date.now() > entry.expiresAt) {
      return json({ error: 'That code expired. Generate a new one.' }, 410)
    }

    return json({ state: entry.state })
  }

  return json({ error: 'Unknown action' }, 400)
}
