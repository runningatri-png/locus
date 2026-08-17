# Copilot instructions for Locus

## Project shape
- This is a Vite + React SPA. The app entry is `src/main.jsx`; the domain logic and UI live mostly in `src/App.jsx`.
- There is no separate API layer or component library. Most feature work should be added in `src/App.jsx`, and styling stays mostly inline via JSX objects plus base resets in `src/App.css`.
- Persistence is browser-local via `localStorage` keys defined in `KEYS` (`goals`, `tasks`, `habits`, `ideas`, `todayPlan`, `tomorrowPlan`, `planArchive`, `history`, etc.). Treat that state as the app's source of truth.

## Core domain model
- The product is a personal planning assistant: goals, tasks, habits, ideas, today/tomorrow plans, calendar history, and skip/timing stats.
- Planning is driven by `buildContext()` + `PLAN_RULES` inside `src/App.jsx`: Claude gets a structured prompt with goals/tasks/habits/history/context, then returns JSON blocks.
- `sendChat()` is the main AI interaction path. It expects a final JSON action array on the last line, then applies those actions via `applyActions()`.
- `generateToday()` and `generateTomorrow()` call the Netlify function `/.netlify/functions/claude`, which is the only backend integration point.

## Important integration points
- Do not call Anthropic directly from the app. The browser talks to the local Netlify function, and that function forwards requests to `https://api.anthropic.com/v1/messages` using `ANTHROPIC_API_KEY`.
- File to inspect when changing AI behavior: `netlify/functions/claude.js` and the prompt strings in `src/App.jsx`.
- When changing action schemas, keep them consistent with the assistant instructions in `sendChat()`; Claude is explicitly instructed to emit JSON action objects like `add_block`, `remove_block`, `generate_plan`, `add_context`, etc.

## Workflow and conventions
- Default workflow: “Today” tab → Generate plan; “Tomorrow” tab → suggestions + final generate; “Chat” tab → natural-language edits.
- Prefer minimal changes over regeneration: the app explicitly tells Claude not to fully regenerate plans unless the day is “blown up.” Rebuilds are destructive to in-progress ordering.
- A block is treated as a plan item with fields like `time`, `title`, `desc`, `duration`, `imp`, `done`, `status`, `startTime`.
- Skip/move tracking is not cosmetic: `skipBlock()` increments `skipPatterns`, and `recordDuration()` updates `timestamps` to improve future plan quality.
- Habit and task deduplication is by normalized name (`norm()`), not by object identity.

## Validation
- There are no automated tests in this repo. The practical checks are:
  - `npm install`
  - `npm run dev`
  - `npm run build`
  - `npm run lint`
- If you change the Netlify function, verify the environment variable and request/response contract still match the browser fetch in `callClaude()`.

## Examples to follow
- The app patterns are “single-file but structured”: helper functions like `load()/save()`, `uid()`, `buildContext()`, `extractJSONArray()` are defined near the top of `src/App.jsx` and used throughout.
- When adding a new persisted data field, update both the `KEYS` object and all matching `save()` / `load()` effects.
- When adding a new command or Claude action, mirror the same schema in `applyActions()` and the assistant/system prompt examples in `sendChat()`.
