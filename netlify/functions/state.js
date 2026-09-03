// Receives a read-only snapshot of Locus's state from the browser, so the MCP
// connector (netlify/functions/mcp.js) can answer questions about what's
// actually in the app. Locus's real data still lives in localStorage; this is
// a replica, not a source of truth.
//
// Deliberately write-only over HTTP: there is no GET. The MCP function reads
// the blob directly through the Blobs SDK, server side, so the snapshot is
// never exposed on a public URL. The POST is unauthenticated because any
// credential shipped in a browser bundle is public anyway - worst case someone
// who found the endpoint writes junk into the replica, which affects what
// Claude reads until the next time the app is opened, and touches no real data.
import { getStore } from '@netlify/blobs'

const MAX_BYTES = 512 * 1024

function stateStore() {
  const opts = { name: 'locus-state', consistency: 'strong' }
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID
  if (process.env.NETLIFY_API_TOKEN && siteID) {
    opts.siteID = siteID
    opts.token = process.env.NETLIFY_API_TOKEN
  }
  return getStore(opts)
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
  if (req.method !== 'POST') return new Response('Write-only endpoint.', { status: 405, headers: CORS })

  const raw = await req.text()
  if (raw.length > MAX_BYTES) return json({ error: 'Snapshot too large' }, 413)

  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  // Shape check - only store what the read tools actually serve.
  const snapshot = {
    goals: Array.isArray(body.goals) ? body.goals : [],
    tasks: Array.isArray(body.tasks) ? body.tasks : [],
    habits: Array.isArray(body.habits) ? body.habits : [],
    ideas: Array.isArray(body.ideas) ? body.ideas : [],
    todayPlan: Array.isArray(body.todayPlan) ? body.todayPlan : [],
    tomorrowPlan: Array.isArray(body.tomorrowPlan) ? body.tomorrowPlan : [],
    context: Array.isArray(body.context) ? body.context : [],
    updatedAt: Date.now(),
  }

  await stateStore().setJSON('current', snapshot)
  return json({ ok: true, updatedAt: snapshot.updatedAt })
}
