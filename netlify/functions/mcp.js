// A remote MCP (Model Context Protocol) server, so a plain Claude chat -
// on your phone, on the web, anywhere - can say "add this to Locus" and
// have it land here. Hand-rolled (no MCP SDK) to avoid bundler surprises;
// it speaks the minimal JSON-RPC subset a tool-calling client needs:
// initialize, tools/list, tools/call. No streaming/session state - every
// request is self-contained, which is what a serverless function wants.
//
// Tool calls don't touch Locus's data directly. They translate 1:1 into the
// same action objects the in-app chat already produces (see the ACTIONS list
// in sendChat()'s system prompt in src/App.jsx) and land in a queue
// (netlify/functions/inbox.js). The app drains that queue through its own
// existing applyActions() next time it's opened - so this file never has to
// duplicate Locus's business logic, only speak its action language.
//
// Written against Netlify's v2 function API (standard Request/Response).
// v1 handlers on this site don't get Netlify Blobs credentials injected.
import { getStore } from '@netlify/blobs'
import crypto from 'node:crypto'

export const config = { path: '/mcp' }

const PROTOCOL_VERSION = '2025-06-18'

function inboxStore() {
  const opts = { name: 'locus-inbox', consistency: 'strong' }
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID
  if (process.env.NETLIFY_API_TOKEN && siteID) {
    opts.siteID = siteID
    opts.token = process.env.NETLIFY_API_TOKEN
  }
  return getStore(opts)
}

const TOOLS = [
  {
    name: 'add_task',
    description: 'Add a to-do to Locus. Not scheduled to a time slot - shows up in the task list for planning.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'e.g. "CS218 exam"' },
        due: { type: 'string', description: 'Due date/day as free text, e.g. "Monday" or "2026-09-08".' },
        goal: { type: 'string', description: 'Name of an existing Locus goal this belongs to, if any.' },
        importance: { type: 'integer', enum: [1, 2, 3], description: '1=low, 2=normal, 3=high. Default 2.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark an existing Locus task done, matched by name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'add_goal',
    description: 'Add a goal to Locus.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        area: { type: 'string', description: 'Life area, e.g. "School", "Fitness". Default "Other".' },
        desc: { type: 'string' },
        deadline: { type: 'string', description: 'Free text, optional.' },
        priority: { type: 'string', enum: ['front', 'maint', 'back'], description: 'front burner / maintenance / back burner. Default maint.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_habit',
    description: 'Add a recurring habit to Locus.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        freq: { type: 'string', description: 'e.g. "daily", "3x/week". Default "daily".' },
        note: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'tick_habit',
    description: 'Mark a Locus habit done (or undone) for today, matched by name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        value: { type: 'boolean', description: 'true = mark done (default), false = un-mark.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_idea',
    description: "Drop a loose idea into Locus's ideas inbox - not a goal or task yet.",
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'add_today_block',
    description: "Add a specific block to TODAY's plan in Locus. Use only when the user clearly means today, not a future day.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        time: { type: 'string', enum: ['Morning', 'Late morning', 'Midday', 'Afternoon', 'Evening', 'Night'], description: 'Default Anytime if omitted.' },
        desc: { type: 'string' },
        duration: { type: 'string', description: 'e.g. "~30 min"' },
        imp: { type: 'integer', enum: [1, 2, 3] },
      },
      required: ['title'],
    },
  },
]

function toAction(name, args) {
  switch (name) {
    case 'add_task':
      return { type: 'add_task', name: args.name, due: args.due || '', goal: args.goal || '', importance: args.importance || 2 }
    case 'complete_task':
      return { type: 'complete_task', name: args.name }
    case 'add_goal':
      return { type: 'add_goal', name: args.name, area: args.area || 'Other', desc: args.desc || '', deadline: args.deadline || '', priority: args.priority || 'maint' }
    case 'add_habit':
      return { type: 'add_habit', name: args.name, freq: args.freq || 'daily', note: args.note || '' }
    case 'tick_habit':
      return { type: 'tick_habit', name: args.name, value: args.value === undefined ? true : args.value }
    case 'add_idea':
      return { type: 'add_idea', text: args.text }
    case 'add_today_block':
      return { type: 'add_block', time: args.time || 'Anytime', title: args.title, desc: args.desc || '', duration: args.duration || '', imp: args.imp || 2 }
    default:
      return null
  }
}

function describeAction(a) {
  switch (a.type) {
    case 'add_task': return `task "${a.name}"${a.due ? ` (due ${a.due})` : ''}`
    case 'complete_task': return `"${a.name}" as complete`
    case 'add_goal': return `goal "${a.name}"`
    case 'add_habit': return `habit "${a.name}"`
    case 'tick_habit': return `habit "${a.name}" ${a.value ? 'done' : 'undone'}`
    case 'add_idea': return `idea "${a.text}"`
    case 'add_block': return `today's block "${a.title}"`
    default: return a.type
  }
}

function checkAuth(req, url) {
  const secret = process.env.MCP_SHARED_SECRET
  if (!secret) return false

  // Claude's connector dialog only offers standard header names out of the box
  // (custom ones need Anthropic's approval first), so accept the usual
  // suspects rather than insisting on one. Query param stays as a fallback for
  // accounts without the request-headers beta.
  if (req.headers.get('x-api-key') === secret) return true
  if (req.headers.get('x-auth-token') === secret) return true
  if (req.headers.get('x-mcp-secret') === secret) return true

  const auth = req.headers.get('authorization')
  if (auth === secret || auth === `Bearer ${secret}`) return true

  if (url.searchParams.get('key') === secret) return true
  return false
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, x-auth-token, x-mcp-secret, authorization, mcp-protocol-version',
}

const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

export default async (req) => {
  const url = new URL(req.url)

  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS })
  if (req.method !== 'POST') {
    return new Response('This endpoint speaks MCP over POST.', { status: 405, headers: CORS })
  }
  if (!checkAuth(req, url)) return json({ error: 'Unauthorized' }, 401)

  let rpc
  try {
    rpc = await req.json()
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
  }

  const { id, method, params } = rpc
  const respond = (result) => json({ jsonrpc: '2.0', id, result })
  const respondErr = (code, message) => json({ jsonrpc: '2.0', id, error: { code, message } })

  try {
    if (method === 'initialize') {
      return respond({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'locus', version: '1.0.0' },
      })
    }

    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return new Response('', { status: 202, headers: CORS })
    }

    if (method === 'ping') return respond({})

    if (method === 'tools/list') return respond({ tools: TOOLS })

    if (method === 'tools/call') {
      const toolName = params && params.name
      const args = (params && params.arguments) || {}
      const action = toAction(toolName, args)
      if (!action) return respondErr(-32602, `Unknown tool: ${toolName}`)
      if (!action.name && !action.text) return respondErr(-32602, 'Missing required field')

      const key = crypto.randomUUID()
      await inboxStore().setJSON(key, { ...action, ts: Date.now() })

      return respond({
        content: [{ type: 'text', text: `Queued for Locus: ${describeAction(action)}. It'll show up next time the app is open.` }],
        isError: false,
      })
    }

    return respondErr(-32601, `Method not found: ${method}`)
  } catch (err) {
    return respondErr(-32603, err.message)
  }
}
