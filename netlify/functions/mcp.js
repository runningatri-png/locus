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
import { effectiveDays, DAY_SHORT, runsOn } from '../../src/days.js'
import { dueKey, countdown, daysBetween, addDays } from '../../src/dayview.js'
import crypto from 'node:crypto'

export const config = { path: '/mcp' }

const PROTOCOL_VERSION = '2025-06-18'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

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
    return { id: hit.id, name: labelOf(hit, field), derived: !!hit.derived }
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
  return { id: hits[0].id, name: labelOf(hits[0], field), derived: !!hits[0].derived }
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
    name: 'get_plan',
    description:
      "Read the plan for any date in Locus - today, tomorrow, or a day weeks out. Merges the routines and fixed commitments that fall on that weekday, any tasks due that day, and any one-off blocks already scheduled for it.",
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
      },
    },
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
    name: 'add_block',
    description:
      "Add a block to a specific day's plan in Locus. Use this for anything scheduled on a particular date - today or a future one. Do NOT use it for recurring routines or standing commitments; those place themselves on every matching day (see add_habit).",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
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
      if (args.date && !ISO_DATE.test(args.date)) {
        return { error: `"${args.date}" isn't a date I can use - give it as YYYY-MM-DD. Nothing was changed.` }
      }
      // A snapshot mirrored before this version has no todayKey. With no date
      // asked for, today's plan is still exactly snap.todayPlan, so resolve
      // against that rather than coming up empty.
      const key = args.date || snap.todayKey || ''
      const onDay = key ? planFor(snap, key).blocks : snap.todayPlan || []
      const r = resolveOne(onDay, args, 'title', 'block')
      // applyActions' remove_block matches on title, not id, so send the exact
      // title back rather than the id the caller may have given.
      if (r.error) return r
      if (r.derived) {
        return { error: `"${r.name}" is a recurring routine, not a one-off block - it appears on every matching day. Remove it from the routine itself instead. Nothing was changed.` }
      }
      return {
        action: { type: 'remove_block', title: r.name, date: args.date || '' },
        label: `block "${r.name}" from ${args.date || 'today'}`,
      }
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
    case 'add_block':
    case 'add_today_block': // kept as an alias so older clients keep working
      return {
        type: 'add_block',
        date: name === 'add_block' && ISO_DATE.test(args.date || '') ? args.date : '',
        time: args.time || 'Anytime',
        title: args.title,
        desc: args.desc || '',
        duration: args.duration || '',
        imp: args.imp || 2,
      }
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
    case 'add_block': return a.date ? `block "${a.title}" on ${a.date}` : `today's block "${a.title}"`
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

// The same merge the calendar does, from the mirrored snapshot. Routines and
// commitments are derived per weekday rather than stored, so a future day
// reflects the current schedule instead of a stale copy of it.
function planFor(snap, key) {
  const todayK = snap.todayKey || ''
  const rel = todayK ? daysBetween(todayK, key) : 0
  const dow = new Date(key + 'T12:00:00').getDay()
  const archive = snap.planArchive || {}
  const tomorrowK = todayK ? addDays(todayK, 1) : ''

  const stored =
    key === todayK
      ? snap.todayPlan || []
      : key === tomorrowK
      ? [...(snap.tomorrowPlan || []), ...(archive[key] || [])]
      : archive[key] || []

  // Today and tomorrow already have their routines merged into the stored plan
  // by the app, so deriving again would double them up.
  const isFuture = rel > 1
  const skip = (snap.fixedDismissed || {})[key] || []
  const titled = new Set(stored.map((b) => norm(b.title)))

  const fixed = !isFuture
    ? []
    : (snap.commitments || [])
        .filter((c) => (c.days || []).includes(dow) && !skip.includes(c.id))
        .map((c) => ({ id: `${key}:${c.id}`, title: c.label, time: c.start || 'Anytime', derived: true, kind: c.kind }))

  const routines = !isFuture
    ? []
    : (snap.habits || [])
        .filter((h) => runsOn(h, dow) && !skip.includes(h.id) && !titled.has(norm(h.name)))
        .map((h) => ({ id: `${key}:${h.id}`, title: h.name, time: h.start || 'Anytime', derived: true, routine: true }))

  const deadlines = (snap.tasks || []).filter((t) => !t.done && dueKey(t.due, todayK) === key)

  return { rel, blocks: sortByClock([...stored, ...fixed, ...routines]), deadlines }
}

// Clock-timed blocks in order, phase-labelled ones ("Midday") after, in the
// order they were already in. Same rule the app's sortPlan() uses, applied to
// the raw "HH:MM" the snapshot carries.
function sortByClock(blocks) {
  const mins = (t) => {
    const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(String(t || '').trim())
    if (!m) return null
    let h = Number(m[1])
    const ap = (m[3] || '').toUpperCase()
    if (ap === 'PM' && h !== 12) h += 12
    if (ap === 'AM' && h === 12) h = 0
    return h * 60 + Number(m[2])
  }
  return blocks
    .map((b, i) => ({ b, i, m: mins(b.time) }))
    .sort((x, y) => (x.m === null) - (y.m === null) || (x.m ?? 0) - (y.m ?? 0) || x.i - y.i)
    .map((x) => x.b)
}

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

  if (toolName === 'get_plan') {
    const todayK = snap.todayKey || ''
    if (!todayK) {
      return `${head}\nThis snapshot was mirrored by an older version of Locus that doesn't record what day it is, so I can't work out any date's plan from it. Open Locus once on an up-to-date device and try again.`
    }
    const key = ISO_DATE.test(args.date || '') ? args.date : todayK
    const when = key === todayK ? 'today' : countdown(todayK, key)
    const { blocks, deadlines } = planFor(snap, key)
    const out = [`${head}\nPlan for ${key} (${when}):`]

    if (deadlines.length) {
      out.push(
        'Due this day:\n' +
          deadlines.map((t) => `- ${t.name}${(t.imp || 2) === 3 ? ' [HIGH IMPORTANCE]' : ''}`).join('\n')
      )
    }
    if (blocks.length) {
      out.push(
        blocks
          .map((b) => {
            const tag = b.derived ? (b.routine ? ' [recurring routine]' : ' [standing commitment]') : ''
            const state = b.done ? ' - done' : b.status === 'skipped' ? ' - skipped' : ''
            return `- ${b.time || 'Anytime'}: ${b.title}${tag}${state}`
          })
          .join('\n')
      )
    }
    if (!blocks.length && !deadlines.length) out.push('Nothing scheduled.')
    return out.join('\n\n')
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
