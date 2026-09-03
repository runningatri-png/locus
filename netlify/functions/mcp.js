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

function stateStore() {
  const opts = { name: 'locus-state', consistency: 'strong' }
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID
  if (process.env.NETLIFY_API_TOKEN && siteID) {
    opts.siteID = siteID
    opts.token = process.env.NETLIFY_API_TOKEN
  }
  return getStore(opts)
}

// How old the snapshot is, in words. Every read says this, so a stale replica
// is never mistaken for live data.
function freshness(updatedAt) {
  if (!updatedAt) return 'unknown age'
  const mins = Math.round((Date.now() - updatedAt) / 60000)
  if (mins < 2) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

const READ_TOOLS = [
  {
    name: 'get_today',
    description: "Read today's plan in Locus - the blocks laid out for today and whether each is done, pending or skipped.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_tasks',
    description: 'Read the task list in Locus, with due dates and importance.',
    inputSchema: {
      type: 'object',
      properties: {
        include_done: { type: 'boolean', description: 'Include completed tasks. Default false.' },
      },
    },
  },
  {
    name: 'get_goals',
    description: 'Read goals in Locus, grouped by front burner / maintenance / back burner.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_habits',
    description: 'Read habits in Locus with current streaks and whether each is ticked today.',
    inputSchema: { type: 'object', properties: {} },
  },
]

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

async function handleRead(toolName, args) {
  const snap = await stateStore().get('current', { type: 'json' })
  if (!snap) {
    return "No snapshot of Locus yet - the app mirrors one whenever it's open, so open Locus once and this will start working."
  }

  const age = freshness(snap.updatedAt)
  const head = `Locus as of ${age}:`

  if (toolName === 'get_today') {
    const plan = snap.todayPlan || []
    if (!plan.length) return `${head}\nNo plan laid out for today yet.`
    const lines = plan.map((b) => {
      const state = b.done ? 'done' : b.status === 'skipped' ? 'skipped' : 'pending'
      return `- [${state}] ${b.time || 'Anytime'}: ${b.title}${b.duration ? ` (${b.duration})` : ''}${b.desc ? ` - ${b.desc}` : ''}`
    })
    return `${head}\nToday's plan (${plan.length} blocks):\n${lines.join('\n')}`
  }

  if (toolName === 'get_tasks') {
    const all = snap.tasks || []
    const list = args.include_done ? all : all.filter((t) => !t.done)
    if (!list.length) return `${head}\nNo open tasks.`
    const lines = list.map(
      (t) => `- ${t.name}${t.due ? ` (due ${t.due})` : ''}${t.goal ? ` [goal: ${t.goal}]` : ''}${t.imp === 3 ? ' [high]' : ''}${t.done ? ' [done]' : ''}`
    )
    return `${head}\n${list.length} task(s):\n${lines.join('\n')}`
  }

  if (toolName === 'get_goals') {
    const goals = snap.goals || []
    if (!goals.length) return `${head}\nNo goals set.`
    const label = { front: 'Front burner', maint: 'Maintenance', back: 'Back burner' }
    const groups = ['front', 'maint', 'back']
      .map((p) => {
        const inGroup = goals.filter((g) => (g.p || 'maint') === p)
        if (!inGroup.length) return null
        const lines = inGroup.map(
          (g) => `- ${g.name}${g.area ? ` (${g.area})` : ''}${g.deadline ? ` - deadline ${g.deadline}` : ''}${g.desc ? `: ${g.desc}` : ''}`
        )
        return `${label[p]}:\n${lines.join('\n')}`
      })
      .filter(Boolean)
    return `${head}\n${groups.join('\n\n')}`
  }

  if (toolName === 'get_habits') {
    const habits = snap.habits || []
    if (!habits.length) return `${head}\nNo habits set.`
    const lines = habits.map(
      (h) => `- ${h.name}${h.freq ? ` (${h.freq})` : ''} - ${h.tickedToday ? 'done today' : 'not yet today'}, streak ${h.streak || 0}${h.note ? ` - ${h.note}` : ''}`
    )
    return `${head}\n${habits.length} habit(s):\n${lines.join('\n')}`
  }

  return 'Unknown read tool.'
}

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

    if (method === 'tools/list') return respond({ tools: [...TOOLS, ...READ_TOOLS] })

    if (method === 'tools/call') {
      const toolName = params && params.name
      const args = (params && params.arguments) || {}

      if (READ_TOOLS.some((t) => t.name === toolName)) {
        const text = await handleRead(toolName, args)
        return respond({ content: [{ type: 'text', text }], isError: false })
      }

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
