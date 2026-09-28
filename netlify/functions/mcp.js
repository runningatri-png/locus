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
import { effectiveDays, DAY_SHORT } from '../../src/days.js'
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

// --- Matching items the caller named ---------------------------------------
// Every delete/edit tool resolves what the caller meant against the snapshot
// BEFORE queueing anything, and queues the resolved id rather than the name.
// Two reasons: a name that matched nothing can be reported as an error instead
// of silently succeeding, and a name that matched two things can be refused
// instead of deleting the wrong one.
const norm = (v) => String(v == null ? '' : v).trim().toLowerCase()

function labelOf(item, field) {
  return item[field] || '(untitled)'
}

// Returns { id, name } on a clean single match, or { error } otherwise.
function resolveOne(list, args, field, noun) {
  const items = Array.isArray(list) ? list : []
  if (args.id) {
    const hit = items.find((i) => i.id === args.id)
    if (!hit) return { error: `No ${noun} in Locus has id "${args.id}". Call the matching get_ tool to see current ids.` }
    return { id: hit.id, name: labelOf(hit, field) }
  }
  const q = norm(args.name || args.text || args.title)
  if (!q) return { error: `Give either an id or a name to say which ${noun} you mean.` }

  let hits = items.filter((i) => norm(i[field]) === q)
  if (!hits.length) hits = items.filter((i) => norm(i[field]).includes(q))
  if (!hits.length) {
    return { error: `No ${noun} in Locus matches "${args.name || args.text || args.title}". Nothing was changed.` }
  }
  if (hits.length > 1) {
    const opts = hits.map((h) => `- ${labelOf(h, field)} (id: ${h.id})`).join('\n')
    return {
      error: `"${args.name || args.text || args.title}" matches ${hits.length} ${noun}s in Locus. Nothing was changed - call again with one of these ids:\n${opts}`,
    }
  }
  return { id: hits[0].id, name: labelOf(hits[0], field) }
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
  {
    name: 'get_ideas',
    description: "Read the ideas inbox in Locus - loose thoughts not yet turned into goals or tasks.",
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
        days: {
          type: 'array',
          items: { type: 'string' },
          description: 'Weekdays it runs on, e.g. ["Sunday"] or ["Mon","Wed","Fri"]. Omit for something with no fixed days.',
        },
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
  {
    name: 'delete_task',
    description: 'Permanently delete a task from Locus. Prefer complete_task if the task was actually finished - this is for things that should never have been there. Matched by id (exact) or name.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id from get_tasks. Use this when several tasks have similar names.' },
        name: { type: 'string', description: 'Task name, if you do not have the id.' },
      },
    },
  },
  {
    name: 'delete_habit',
    description: 'Permanently delete a habit/routine from Locus, along with its streak. Matched by id (exact) or name.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The habit id from get_habits.' },
        name: { type: 'string' },
      },
    },
  },
  {
    name: 'delete_goal',
    description: 'Permanently delete a goal from Locus. Tasks pointing at it are unlinked, not deleted. Matched by id (exact) or name.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The goal id from get_goals.' },
        name: { type: 'string' },
      },
    },
  },
  {
    name: 'delete_idea',
    description: "Delete an idea from Locus's ideas inbox. Matched by id (exact) or the idea's text.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The idea id from get_ideas.' },
        text: { type: 'string', description: 'The idea text, or enough of it to identify it.' },
      },
    },
  },
  {
    name: 'remove_block',
    description: "Remove a block from a day's plan in Locus. Only today's plan is supported right now.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: "The block's title, as get_today shows it." },
        id: { type: 'string', description: 'The block id from get_today.' },
        date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today; other dates are not supported yet.' },
      },
    },
  },
  {
    name: 'update_task',
    description: 'Change an existing task in Locus - rename it, move its due date, or change its importance. Only the fields you pass are changed. Matched by id (exact) or name.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id from get_tasks.' },
        name: { type: 'string', description: 'Current task name, if you do not have the id.' },
        new_name: { type: 'string', description: 'Rename the task to this.' },
        due: { type: 'string', description: 'New due date, e.g. "2026-10-02" or "Friday". Pass "" to clear it.' },
        importance: { type: 'integer', enum: [1, 2, 3], description: '1=low, 2=normal, 3=high.' },
        goal: { type: 'string', description: 'Name of a Locus goal to attach it to. Pass "" to unlink.' },
      },
    },
  },
]

// Tools that must look at the current snapshot before they can queue anything.
const RESOLVED_TOOLS = new Set(['delete_task', 'delete_habit', 'delete_goal', 'delete_idea', 'remove_block', 'update_task'])

// Builds the action for a tool that names an existing item. Returns
// { error } instead of an action when nothing (or too much) matched.
function toResolvedAction(name, args, snap) {
  if (!snap) {
    return { error: "Locus hasn't mirrored a snapshot yet, so there's nothing to match against. Open the app once, then try again." }
  }
  switch (name) {
    case 'delete_task': {
      const r = resolveOne(snap.tasks, args, 'name', 'task')
      return r.error ? r : { action: { type: 'delete_task', id: r.id }, label: `task "${r.name}"` }
    }
    case 'delete_habit': {
      const r = resolveOne(snap.habits, args, 'name', 'habit')
      return r.error ? r : { action: { type: 'delete_habit', id: r.id }, label: `habit "${r.name}"` }
    }
    case 'delete_goal': {
      const r = resolveOne(snap.goals, args, 'name', 'goal')
      return r.error ? r : { action: { type: 'delete_goal', id: r.id }, label: `goal "${r.name}"` }
    }
    case 'delete_idea': {
      const r = resolveOne(snap.ideas, args, 't', 'idea')
      return r.error ? r : { action: { type: 'delete_idea', id: r.id }, label: `idea "${r.name}"` }
    }
    case 'remove_block': {
      if (args.date && !isToday(args.date)) {
        return { error: `remove_block can only touch today's plan right now - ${args.date} isn't today. Nothing was changed.` }
      }
      const r = resolveOne(snap.todayPlan, args, 'title', 'block')
      // applyActions' remove_block matches on title, not id, so send the exact
      // title back rather than the id the caller may have given.
      return r.error ? r : { action: { type: 'remove_block', title: r.name }, label: `block "${r.name}" from today` }
    }
    case 'update_task': {
      const r = resolveOne(snap.tasks, args, 'name', 'task')
      if (r.error) return r
      const updates = {}
      if (args.new_name !== undefined) updates.name = args.new_name
      if (args.due !== undefined) updates.due = args.due
      if (args.goal !== undefined) updates.goal = args.goal
      if (args.importance !== undefined) updates.imp = args.importance
      if (!Object.keys(updates).length) {
        return { error: `Nothing to change on "${r.name}" - pass at least one of new_name, due, importance or goal.` }
      }
      const what = Object.keys(updates).join(', ')
      return { action: { type: 'edit_task', id: r.id, updates }, label: `task "${r.name}" (${what})` }
    }
    default:
      return { error: `Unknown tool: ${name}` }
  }
}

// Serverless runs in UTC and the user may not, so a date is "today" if it is
// today anywhere in the range of plausible offsets. Better to accept a legal
// date than to reject the user's actual today on a timezone technicality.
function isToday(date) {
  const now = Date.now()
  for (const shift of [-1, 0, 1]) {
    if (new Date(now + shift * 86400000).toISOString().slice(0, 10) === date) return true
  }
  return false
}

function toAction(name, args) {
  switch (name) {
    case 'add_task':
      return { type: 'add_task', name: args.name, due: args.due || '', goal: args.goal || '', importance: args.importance || 2 }
    case 'complete_task':
      return { type: 'complete_task', name: args.name }
    case 'add_goal':
      return { type: 'add_goal', name: args.name, area: args.area || 'Other', desc: args.desc || '', deadline: args.deadline || '', priority: args.priority || 'maint' }
    case 'add_habit':
      return { type: 'add_habit', name: args.name, freq: args.freq || 'daily', days: args.days || '', note: args.note || '' }
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
    case 'delete_task': return 'that task for deletion'
    case 'delete_habit': return 'that habit for deletion'
    case 'delete_goal': return 'that goal for deletion'
    case 'delete_idea': return 'that idea for deletion'
    case 'remove_block': return `removal of "${a.title}" from today`
    case 'edit_task': return 'that task edit'
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
      return `- [${state}] ${b.time || 'Anytime'}: ${b.title}${b.duration ? ` (${b.duration})` : ''}${b.desc ? ` - ${b.desc}` : ''} (id: ${b.id})`
    })
    return `${head}\nToday's plan (${plan.length} blocks):\n${lines.join('\n')}`
  }

  if (toolName === 'get_tasks') {
    const all = snap.tasks || []
    const list = args.include_done ? all : all.filter((t) => !t.done)
    if (!list.length) return `${head}\nNo open tasks.`
    const lines = list.map(
      (t) =>
        `- ${t.name}${t.due ? ` (due ${t.due})` : ''}${t.goal ? ` [goal: ${t.goal}]` : ''}${t.imp === 3 ? ' [high]' : ''}${t.done ? ' [done]' : ''} (id: ${t.id})`
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
          (g) =>
            `- ${g.name}${g.area ? ` (${g.area})` : ''}${g.deadline ? ` - deadline ${g.deadline}` : ''}${g.desc ? `: ${g.desc}` : ''} (id: ${g.id})`
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
      (h) => {
        const days = effectiveDays(h)
        const dueToday = !days.length || days.includes(new Date().getDay())
        const when = days.length ? days.map((d) => DAY_SHORT[d]).join('/') : 'every day'
        const state = h.tickedToday ? 'done today' : dueToday ? 'not yet today' : 'not scheduled today'
        return `- ${h.name} (${when}) - ${state}, streak ${h.streak || 0}${h.note ? ` - ${h.note}` : ''} (id: ${h.id})`
      }
    )
    return `${head}\n${habits.length} habit(s):\n${lines.join('\n')}`
  }

  if (toolName === 'get_ideas') {
    const ideas = snap.ideas || []
    if (!ideas.length) return `${head}\nNo ideas in the inbox.`
    const lines = ideas.map((i) => `- ${i.t} (id: ${i.id})`)
    return `${head}\n${ideas.length} idea(s):\n${lines.join('\n')}`
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

      // Delete/edit tools have to see what's actually in Locus before they can
      // queue anything, so that "delete the CS218 one" either resolves to
      // exactly one item or comes back as an error the caller can act on.
      if (RESOLVED_TOOLS.has(toolName)) {
        const snap = await stateStore().get('current', { type: 'json' })
        const r = toResolvedAction(toolName, args, snap)
        if (r.error) {
          return respond({ content: [{ type: 'text', text: r.error }], isError: true })
        }
        const dkey = crypto.randomUUID()
        await inboxStore().setJSON(dkey, { ...r.action, ts: Date.now() })
        return respond({
          content: [
            {
              type: 'text',
              text: `Queued for Locus: ${r.label}. It'll apply next time the app is open, and sync from there.`,
            },
          ],
          isError: false,
        })
      }

      const action = toAction(toolName, args)
      if (!action) return respondErr(-32602, `Unknown tool: ${toolName}`)
      // Each action type identifies itself by a different field - add_block
      // uses `title`, ideas use `text`, the rest use `name`. The old check knew
      // only about name/text, so add_today_block always failed with -32602.
      const REQUIRED_FIELD = {
        add_task: 'name',
        complete_task: 'name',
        add_goal: 'name',
        add_habit: 'name',
        tick_habit: 'name',
        add_idea: 'text',
        add_block: 'title',
      }
      const required = REQUIRED_FIELD[action.type]
      if (required && !action[required]) {
        return respondErr(-32602, `Missing required field: ${required}`)
      }

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
