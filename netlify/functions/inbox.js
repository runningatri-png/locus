// Reads/clears the queue of actions the MCP connector (netlify/functions/mcp.js)
// writes when you ask Claude, from anywhere, to add something to Locus. The app
// drains this on load and applies the actions through the same applyActions()
// it already uses for in-app chat, so nothing about existing behavior changes.
//
// Netlify v2 function API (standard Request/Response) - v1 handlers on this
// site don't get Netlify Blobs credentials injected.
import { getStore } from '@netlify/blobs'

function inboxStore() {
  const opts = { name: 'locus-inbox', consistency: 'strong' }
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID
  if (process.env.NETLIFY_API_TOKEN && siteID) {
    opts.siteID = siteID
    opts.token = process.env.NETLIFY_API_TOKEN
  }
  return getStore(opts)
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

export default async (req) => {
  const url = new URL(req.url)

  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS })

  // ?debug=1 reports which credentials the runtime actually provides.
  // Names and booleans only - never values.
  if (url.searchParams.get('debug') === '1') {
    return json({
      node: process.version,
      apiVersion: 'v2',
      hasBlobsContext: !!process.env.NETLIFY_BLOBS_CONTEXT,
      hasSiteId: !!(process.env.SITE_ID || process.env.NETLIFY_SITE_ID),
      hasApiToken: !!process.env.NETLIFY_API_TOKEN,
      netlifyKeys: Object.keys(process.env).filter(
        (k) => k.startsWith('NETLIFY') || k === 'SITE_ID' || k === 'DEPLOY_ID' || k === 'CONTEXT'
      ),
    })
  }

  try {
    const store = inboxStore()

    if (req.method === 'GET') {
      const { blobs } = await store.list()
      const items = []
      for (const b of blobs) {
        const val = await store.get(b.key, { type: 'json' })
        if (val) items.push({ id: b.key, ...val })
      }
      items.sort((a, b) => (a.ts || 0) - (b.ts || 0))
      return json({ actions: items })
    }

    if (req.method === 'DELETE') {
      let ids = []
      try {
        const body = await req.json()
        if (Array.isArray(body.ids)) ids = body.ids
      } catch {
        // no body - nothing to clear
      }
      await Promise.all(ids.map((id) => store.delete(id)))
      return json({ deleted: ids.length })
    }

    return new Response('Method not allowed', { status: 405, headers: CORS })
  } catch (err) {
    return json({ error: err.message }, 500)
  }
}
