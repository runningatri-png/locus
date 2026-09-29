# Locus

A personal planning app that builds your day out of your goals, tasks, routines
and fixed commitments, and re-plans when things change. Built solo by Atri as a
daily driver (mobile-first, used on a phone) and as the main portfolio artifact
for Sales Engineering applications. Both of those matter: it has to actually
work every morning, and it has to read well to someone technical.

Live: https://locus12.netlify.app  ·  Demo: https://locus12.netlify.app/demo

## Working style

Atri is a beginner at coding and has asked for:

- **Explain each change as you make it** - what it does and why, in plain terms.
- **Ask before any judgment call he might disagree with.** Don't quietly pick a
  side on anything that changes behaviour he'd notice.
- **Analogies help.** When a concept is new, ground it in something concrete.
- **Expand on his ideas.** When he proposes something, engage with it and push
  it further rather than just implementing it as stated - he's explicitly asked
  for this, and it's usually where the best design decisions have come from.
- **Build one thing at a time and let him test between.** Don't stack three
  upgrades and hand them over at once.
- **Flag when a thread is getting long** so he can start a fresh one.

## Stack

- Vite + React (no TypeScript, no component library, no state manager)
- Netlify: static hosting + serverless functions (v2 API, standard Request/Response)
- Supabase Postgres with RLS for cross-device sync; localStorage is the local source of truth
- Anthropic API via a proxy function so no key ships to the browser
- A remote MCP connector so a plain Claude chat can read and write Locus

## File map

| File | What it is |
|---|---|
| `src/App.jsx` | The entire app - all state, all UI. ~4000 lines. Yes, really. |
| `src/db.js` | Supabase client, row mappers, push/pull |
| `src/days.js` | **Shared** weekday parsing (app + connector) |
| `src/dayview.js` | **Shared** date maths and due-date resolution (app + connector) |
| `src/demo.js` | Demo mode: seeded state, no persistence |
| `netlify/functions/mcp.js` | The MCP connector |
| `netlify/functions/inbox.js` | Action queue the connector writes to |
| `netlify/functions/state.js` | Write-only snapshot mirror the connector reads |
| `netlify/functions/claude.js` | Anthropic API proxy |

## Architecture rules, and the bugs that produced them

These are not style preferences. Each one is here because breaking it caused a
real bug in production.

**1. Date and weekday logic lives in `src/days.js` and `src/dayview.js`, imported
by both the app and the connector.** Never write a second parser. Habits once
showed up on the wrong days for a week because `App.jsx` and `mcp.js` each had
their own idea of what `days` meant - one expected `[0,3]`, the other accepted
`"Sunday"`. Two files, one format, one module.

**2. Future days are derived, never stored.** A day's contents are computed at
view time from the current routines, commitments and task due dates. Only
genuinely one-off blocks are written down (in `planArchive`, keyed by date).
This is why changing a habit's schedule instantly corrects every future day
instead of leaving hundreds of stale pre-generated rows to migrate.

**3. Today and tomorrow are already merged - don't derive them again.**
`placeFixed()` merges routines and commitments into the stored plan for today
and tomorrow. `dayView()` therefore only derives for `rel > 1`. Skip this and
everything shows twice.

**4. `placeFixed()` must converge, not just add.** It removes auto-placed blocks
that no longer belong, dedupes by title, then adds what's missing. It used to
only ever add, which meant a block placed by an earlier buggy schedule - a
Sunday chore sitting on a Monday - stayed there forever, because nothing was
responsible for taking it off. Fixing a placement filter does nothing for days
already populated wrongly.

**5. Never auto-delete what the user made.** `placeFixed()` only touches blocks
with a `src` field (meaning it placed them itself), and never removes anything
already `done` or `skipped` - those are a record of what happened, not a plan.

**6. The rollover merges, it never overwrites.** When tomorrow's plan becomes
today, it merges with anything already scheduled for that date. It used to
assign outright, which silently wiped pre-scheduled blocks every morning.

**7. Vague due dates never get placed on a date.** `dueKey()` resolves
"2026-10-02" and "Friday"; "next week" and "soon" resolve to `null` and appear on
no day. A guessed deadline is worse than a missing one.

**8. The connector never duplicates business logic.** MCP tools translate 1:1
into the same action objects the in-app chat produces, land in the inbox queue,
and are applied by the app's own `applyActions()`. If a tool needs new
behaviour, add the action type to `applyActions()` - don't reimplement it in
`mcp.js`.

**9. Deletes go through the queue, not straight to Supabase.** `pushItems()`
upserts the whole array and deletes any row not in it, so removing an item from
app state deletes the row on next sync automatically. Writing to Supabase
directly from the connector would let a stale browser tab resurrect deleted rows.

**10. Delete/edit tools resolve names to ids before queueing.** `mcp.js` matches
against the mirrored snapshot first: zero matches returns an error, two or more
returns an error listing the candidate ids. It never guesses which item was meant.

**11. Tool LISTS are cached by clients; tool OUTPUT is not.** `get_today` reports
`[connector build <BUILD>, N tools]`. When a deploy appears not to land, call an
existing tool and read the marker rather than trusting the tool list. This cost
an hour once.

**12. Anything the UI shows is not automatically in the model's prompt.** The
date was visible in the sidebar and invisible to the model, which then invented
deadlines. `buildContext()` now opens with today's date.

## Testing

- Pure logic (`days.js`, `dayview.js`, the connector's resolvers) gets plain
  Node test scripts in `tests/`, run with `node tests/<name>.test.mjs`. They're
  fast and they've caught real regressions.
- UI changes get a real browser check - build, serve, drive it, assert, and
  screenshot. Check mobile width (~390px) as well as desktop; this app is used
  on a phone first.
- `vite build` passing means very little on its own. Two runtime crashes have
  shipped past a green build, both from using a `const` arrow function before
  its declaration in the component body. Check declaration order when you move
  code around.

## Known open items

- Supabase Site URL is still `http://localhost:3000`
- No rate limit on `/.netlify/functions/claude`
- Demo data is slightly stale (references old coursework)
- `mcp.js` could write to Supabase directly and retire the inbox queue
- Not built yet: a study-plan tool - open question whether that's a bulk
  `add_blocks` call or a rule that derives its own days like routines do
