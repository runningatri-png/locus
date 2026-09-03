// Reads/clears the queue of actions the MCP connector (netlify/functions/mcp.js)
// writes when you ask Claude, from anywhere, to add something to Locus. The app
// drains this on load and applies the actions through the same applyActions()
// it already uses for in-app chat, so nothing about existing behavior changes.
const { getStore } = require('@netlify/blobs')

function inboxStore() {
  return getStore({ name: 'locus-inbox', consistency: 'strong' })
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
