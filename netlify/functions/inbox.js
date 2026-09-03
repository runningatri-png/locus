// Reads/clears the queue of actions the MCP connector (netlify/functions/mcp.js)
// writes when you ask Claude, from anywhere, to add something to Locus. The app
// drains this on load and applies the actions through the same applyActions()
// it already uses for in-app chat, so nothing about existing behavior changes.
const { getStore } = require('@netlify/blobs')

function inboxStore() {
  const opts = { name: 'locus-inbox', consistency: 'strong' }
  // Netlify normally injects blob credentials into the function environment.
  // Some site runtimes don't, so fall back to explicit credentials when a
  // NETLIFY_API_TOKEN is configured.
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID
  if (process.env.NETLIFY_API_TOKEN && siteID) {
    opts.siteID = siteID
    opts.token = process.env.NETLIFY_API_TOKEN
  }
  return getStore(opts)
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' }
  }

  // ?debug=1 reports which credentials the runtime actually provides.
  // Names and booleans only - never values.
  if ((event.queryStringParameters || {}).debug === '1') {
    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        node: process.version,
        hasBlobsContext: !!process.env.NETLIFY_BLOBS_CONTEXT,
        hasSiteId: !!(process.env.SITE_ID || process.env.NETLIFY_SITE_ID),
        hasApiToken: !!process.env.NETLIFY_API_TOKEN,
        netlifyKeys: Object.keys(process.env).filter(
          (k) => k.startsWith('NETLIFY') || k === 'SITE_ID' || k === 'DEPLOY_ID' || k === 'CONTEXT'
        ),
      }),
    }
  }

  try {
    const s = inboxStore()

    if (event.httpMethod === 'GET') {
      const { blobs } = await s.list()
      const items = []
      for (const b of blobs) {
        const val = await s.get(b.key, { type: 'json' })
        if (val) items.push({ id: b.key, ...val })
      }
      items.sort((a, b) => (a.ts || 0) - (b.ts || 0))
      return {
        statusCode: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ actions: items }),
      }
    }

    if (event.httpMethod === 'DELETE') {
      const body = event.body ? JSON.parse(event.body) : {}
      const ids = Array.isArray(body.ids) ? body.ids : []
      await Promise.all(ids.map((id) => s.delete(id)))
      return { statusCode: 200, headers, body: JSON.stringify({ deleted: ids.length }) }
    }

    return { statusCode: 405, headers, body: 'Method not allowed' }
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) }
  }
}
