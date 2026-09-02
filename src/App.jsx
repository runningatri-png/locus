import { useState, useEffect, useRef } from "react";
import "./App.css";

const KEYS = {
  goals: "locus-goals",
  tasks: "locus-tasks",
  habits: "locus-habits",
  ideas: "locus-ideas",
  todayPlan: "locus-today-plan",
  tomorrowPlan: "locus-tomorrow-plan",
  tomorrowDate: "locus-tomorrow-date",
  history: "locus-history",
  skipPatterns: "locus-skip-patterns",
  timestamps: "locus-timestamps",
  context: "locus-context",
  planArchive: "locus-plan-archive",
  lastOpen: "locus-last-open",
};

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

function isoKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function prettyDate(d) {
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

function daysBetween(aKey, bKey) {
  const a = new Date(aKey + "T12:00:00");
  const b = new Date(bKey + "T12:00:00");
  return Math.round((b - a) / 86400000);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function norm(str) {
  return (str || "").trim().toLowerCase();
}

function extractJSONArray(text) {
  const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
  const start = clean.indexOf("[");
  const end = clean.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON array found");
  return JSON.parse(clean.slice(start, end + 1));
}

async function callClaude(system, messages, useWebSearch = false) {
  const res = await fetch("/.netlify/functions/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, messages, useWebSearch }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.content?.[0]?.text || "";
}

function buildContext({ goals, tasks, habits, ideas, skipPatterns, timestamps, context }) {
  const ord = ["front", "maint", "back"];
  const sorted = [...goals].sort((a, b) => ord.indexOf(a.p) - ord.indexOf(b.p));
  const group = (p) => {
    const arr = sorted.filter((g) => g.p === p);
    return arr.length
      ? arr
          .map(
            (g) =>
              `- [id:${g.id}] ${g.name} (${g.area})${g.deadline ? ", by " + g.deadline : ""}${
                g.desc ? ": " + g.desc : ""
              }`
          )
          .join("\n")
      : "None";
  };

  const pending = tasks.filter((t) => !t.done);
  const taskCtx = pending.length
    ? pending
        .map(
          (t) =>
            `- [id:${t.id}] ${t.name}${t.due ? ", due " + t.due : ""}${
              t.goal ? " [goal: " + t.goal + "]" : ""
            } [importance: ${t.imp || 2}/3]`
        )
        .join("\n")
    : "None";

  const habitCtx = habits.length
    ? habits
        .map(
          (h) =>
            `- [id:${h.id}] ${h.name} (${h.freq || "no set frequency"})${
              h.note ? " - " + h.note : ""
            }, streak: ${h.streak || 0}`
        )
        .join("\n")
    : "NONE. The user has zero habits right now.";

  const patterns =
    Object.entries(skipPatterns)
      .filter(([, c]) => c >= 2)
      .map(([k, c]) => `- "${k}" skipped or moved ${c}x`)
      .join("\n") || "None";

  const tsCtx =
    Object.entries(timestamps)
      .slice(0, 12)
      .map(([k, v]) => `- ${k}: usually takes about ${v.avg} min (${v.count} logged)`)
      .join("\n") || "None yet";

  const ctxNotes = context.slice(0, 5).map((c) => `- ${c.date}: ${c.text}`).join("\n") || "None";

  return `USER CONTEXT

GOALS - front burner:
${group("front")}

GOALS - maintenance:
${group("maint")}

GOALS - back burner:
${group("back")}

PENDING TASKS:
${taskCtx}

HABITS (complete and only list):
${habitCtx}

SKIP PATTERNS (historical stats only - never schedule something because it appears here):
${patterns}

HOW LONG THINGS ACTUALLY TAKE (historical stats only - never schedule something because it appears here):
${tsCtx}

LIFE CONTEXT NOTES:
${ctxNotes}

IDEAS PARKING LOT:
${ideas.map((i) => `- [id:${i.id}] ${i.t}`).join("\n") || "None"}`;
}

const PLAN_RULES = `PLAN RULES:
- Every block must come from the GOALS, PENDING TASKS, or HABITS lists above, or from something the user explicitly asked for. Never schedule anything that appears only in skip patterns, completion time data, or context notes - those are history, not a to-do list. If a name is not in the current lists, it does not exist anymore.
- No clock times unless the user explicitly gave one. Use a phase of day for "time": Morning, Late morning, Midday, Afternoon, Evening, Night.
- Every block needs an approximate duration string like "~45 min", "~1 hr", "~2 hr".
- Order blocks in the sequence they should happen.
- Front burner goals get the most time. Back burner only if there is room.
- Do NOT invent habits. Only reference habits from the HABITS list. If that list says NONE, include no habit-style recurring blocks at all.
- Do not create a separate block for a habit unless it genuinely needs dedicated time.
- Include exactly one flex or buffer block.
- Use the completion time data to size blocks realistically.
- If something appears in SKIP PATTERNS, place it at a different point in the day rather than the same slot.
- 5 to 8 blocks total. Descriptions must be specific and actionable, never generic.
- Respond with ONLY a JSON array. No prose, no markdown fences.
Format: [{"time":"Morning","title":"...","desc":"...","imp":3,"duration":"~90 min"}]
imp is 1, 2, or 3.`;

// Groups consecutive blocks that share a phase of day, without reordering them.
function groupByPhase(blocks) {
  const groups = [];
  for (const b of blocks) {
    const label = b.time || "Anytime";
    const last = groups[groups.length - 1];
    if (last && norm(last.label) === norm(label)) last.blocks.push(b);
    else groups.push({ label, blocks: [b] });
  }
  return groups;
}

const IMP_COLORS = ["", "#706d68", "#8eaefb", "#f28b82"];

function ImpDots({ imp }) {
  const level = Math.min(3, Math.max(1, imp || 2));
  return (
    <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: i <= level ? IMP_COLORS[level] : "#32323e",
          }}
        />
      ))}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("today");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [goals, setGoals] = useState(() => load(KEYS.goals, []));
  const [tasks, setTasks] = useState(() => load(KEYS.tasks, []));
  const [habits, setHabits] = useState(() => load(KEYS.habits, []));
  const [ideas, setIdeas] = useState(() => load(KEYS.ideas, []));
  const [todayPlan, setTodayPlan] = useState(() => load(KEYS.todayPlan, []));
  const [tomorrowPlan, setTomorrowPlan] = useState(() => load(KEYS.tomorrowPlan, []));
  const [planArchive, setPlanArchive] = useState(() => load(KEYS.planArchive, {}));
  const [history, setHistory] = useState(() => load(KEYS.history, []));
  const [skipPatterns, setSkipPatterns] = useState(() => load(KEYS.skipPatterns, {}));
  const [timestamps, setTimestamps] = useState(() => load(KEYS.timestamps, {}));
  const [context, setContext] = useState(() => load(KEYS.context, []));

  const [tomorrowSuggestions, setTomorrowSuggestions] = useState([]);
  const [selectedSuggestions, setSelectedSuggestions] = useState([]);

  const [chatHistory, setChatHistory] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  const [tmrChat, setTmrChat] = useState([]);
  const [tmrInput, setTmrInput] = useState("");
  const [tmrLoading, setTmrLoading] = useState(false);
  const [tmrView, setTmrView] = useState("ideas");

  const [planLoading, setPlanLoading] = useState(false);
  const [sugLoading, setSugLoading] = useState(false);

  const [goalModal, setGoalModal] = useState(null);
  const [taskModal, setTaskModal] = useState(null);
  const [habitModal, setHabitModal] = useState(null);
  const [rescheduleId, setRescheduleId] = useState(null);
  const [rescheduleReason, setRescheduleReason] = useState("");
  const [rescheduleTime, setRescheduleTime] = useState("");

  const [ideaInput, setIdeaInput] = useState("");
  const [toasts, setToasts] = useState([]);

  const now = new Date();
  const todayK = isoKey(now);
  const tomorrowDate = new Date(now.getTime() + 86400000);
  const tomorrowK = isoKey(tomorrowDate);

  const [calMonth, setCalMonth] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));
  const [calSelected, setCalSelected] = useState(todayK);

  const chatEndRef = useRef(null);
  const tmrEndRef = useRef(null);
  const rolledRef = useRef(false);

  useEffect(() => save(KEYS.goals, goals), [goals]);
  useEffect(() => save(KEYS.tasks, tasks), [tasks]);
  useEffect(() => save(KEYS.habits, habits), [habits]);
  useEffect(() => save(KEYS.ideas, ideas), [ideas]);
  useEffect(() => save(KEYS.todayPlan, todayPlan), [todayPlan]);
  useEffect(() => save(KEYS.tomorrowPlan, tomorrowPlan), [tomorrowPlan]);
  useEffect(() => save(KEYS.history, history), [history]);
  useEffect(() => save(KEYS.skipPatterns, skipPatterns), [skipPatterns]);
  useEffect(() => save(KEYS.timestamps, timestamps), [timestamps]);
  useEffect(() => save(KEYS.context, context), [context]);
  useEffect(() => save(KEYS.planArchive, planArchive), [planArchive]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory, chatLoading]);

  useEffect(() => {
    tmrEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [tmrChat, tmrLoading]);

  useEffect(() => {
    if (todayPlan.length) setPlanArchive((prev) => ({ ...prev, [todayK]: todayPlan }));
  }, [todayPlan, todayK]);

  useEffect(() => {
    if (rolledRef.current) return;
    rolledRef.current = true;

    const lastOpen = load(KEYS.lastOpen, null);
    save(KEYS.lastOpen, todayK);

    if (lastOpen && lastOpen !== todayK) {
      const gap = Math.max(1, daysBetween(lastOpen, todayK));
      setHabits((prev) =>
        prev.map((h) => {
          const stale = !h.lastTicked || daysBetween(h.lastTicked, todayK) > 1;
          let week = [...(h.week || [0, 0, 0, 0, 0, 0, 0])];
          for (let i = 0; i < Math.min(gap, 7); i++) {
            week.shift();
            week.push(0);
          }
          return { ...h, tickedToday: false, streak: stale ? 0 : h.streak || 0, week };
        })
      );
    }

    const targetDate = load(KEYS.tomorrowDate, null);
    const stored = load(KEYS.tomorrowPlan, []);
    if (targetDate && stored.length && daysBetween(targetDate, todayK) >= 0) {
      setTodayPlan(stored.map((b) => ({ ...b, id: uid(), done: false, status: "pending", startTime: null })));
      setTomorrowPlan([]);
      localStorage.removeItem(KEYS.tomorrowDate);
    }
  }, [todayK]);

  const toast = (msg) => {
    const id = uid();
    setToasts((p) => [...p, { id, msg }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 2800);
  };

  const logHistory = (type, text) => {
    const label = prettyDate(new Date());
    setHistory((prev) => {
      const next = [...prev];
      if (!next.length || next[0].date !== label) next.unshift({ date: label, key: todayK, entries: [] });
      next[0] = {
        ...next[0],
        entries: [
          {
            type,
            text,
            time: new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
          },
          ...next[0].entries,
        ],
      };
      return next.slice(0, 60);
    });
  };

  const noteContext = (text) => {
    setContext((prev) => {
      if (prev.some((c) => norm(c.text) === norm(text))) return prev;
      return [
        { date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }), text },
        ...prev,
      ].slice(0, 12);
    });
  };

  const bumpSkip = (title) => setSkipPatterns((sp) => ({ ...sp, [title]: (sp[title] || 0) + 1 }));

  const recordDuration = (title, startTime) => {
    if (!startTime) return;
    const mins = Math.round((Date.now() - startTime) / 60000);
    if (mins < 2 || mins > 600) return;
    setTimestamps((prev) => {
      const ex = prev[title] || { avg: 0, count: 0 };
      const avg = Math.round((ex.avg * ex.count + mins) / (ex.count + 1));
      return { ...prev, [title]: { avg, count: ex.count + 1 } };
    });
  };

  const matches = (item, action, field) => {
    if (action.id) return item.id === action.id;
    const q = norm(action.name || action.text);
    if (!q) return false;
    const v = norm(item[field]);
    return v.includes(q) || q.includes(v);
  };

  function applyActions(actions, snap) {
    let { gs, ts, hs, is } = snap;
    let wantPlan = false;
    let wantTomorrow = false;

    for (const a of actions) {
      if (!a || !a.type) continue;
      switch (a.type) {
        case "add_goal": {
          if (!a.name || gs.some((g) => norm(g.name) === norm(a.name))) break;
          gs = [
            ...gs,
            {
              id: uid(),
              name: a.name,
              area: a.area || "Other",
              desc: a.desc || "",
              deadline: a.deadline || "",
              p: a.priority || "maint",
            },
          ];
          toast("Added goal: " + a.name);
          break;
        }
        case "edit_goal": {
          gs = gs.map((g) => (matches(g, a, "name") ? { ...g, ...(a.updates || {}) } : g));
          toast("Updated goal");
          break;
        }
        case "delete_goal": {
          const before = gs.length;
          gs = gs.filter((g) => !matches(g, a, "name"));
          if (gs.length < before) toast("Deleted goal");
          break;
        }
        case "set_goal_priority": {
          if (!a.priority) break;
          gs = gs.map((g) => (matches(g, a, "name") ? { ...g, p: a.priority } : g));
          toast("Updated priority");
          break;
        }
        case "promote_idea": {
          const idea = is.find((i) => matches(i, a, "t"));
          if (!idea) break;
          if (!gs.some((g) => norm(g.name) === norm(idea.t))) {
            gs = [
              ...gs,
              {
                id: uid(),
                name: idea.t,
                area: a.area || "Other",
                desc: "",
                deadline: "",
                p: a.priority || "back",
              },
            ];
          }
          is = is.filter((i) => i.id !== idea.id);
          toast("Promoted to goal");
          break;
        }
        case "add_task": {
          if (!a.name || ts.some((t) => !t.done && norm(t.name) === norm(a.name))) break;
          ts = [
            ...ts,
            { id: uid(), name: a.name, due: a.due || "", goal: a.goal || "", imp: a.importance || 2, done: false },
          ];
          toast("Added task: " + a.name);
          break;
        }
        case "edit_task": {
          ts = ts.map((t) => (matches(t, a, "name") ? { ...t, ...(a.updates || {}) } : t));
          toast("Updated task");
          break;
        }
        case "complete_task": {
          let hit = false;
          ts = ts.map((t) => {
            if (matches(t, a, "name") && !t.done) {
              hit = true;
              logHistory("task", "Completed: " + t.name);
              return { ...t, done: true };
            }
            return t;
          });
          if (hit) toast("Task completed");
          break;
        }
        case "uncomplete_task": {
          ts = ts.map((t) => (matches(t, a, "name") ? { ...t, done: false } : t));
          toast("Task reopened");
          break;
        }
        case "delete_task": {
          const before = ts.length;
          ts = ts.filter((t) => !matches(t, a, "name"));
          if (ts.length < before) toast("Deleted task");
          break;
        }
        case "add_habit": {
          if (!a.name || hs.some((h) => norm(h.name) === norm(a.name))) break;
          hs = [
            ...hs,
            {
              id: uid(),
              name: a.name,
              freq: a.freq || "daily",
              note: a.note || "",
              streak: 0,
              week: [0, 0, 0, 0, 0, 0, 0],
              tickedToday: false,
              lastTicked: null,
            },
          ];
          toast("Added habit: " + a.name);
          break;
        }
        case "edit_habit": {
          hs = hs.map((h) => (matches(h, a, "name") ? { ...h, ...(a.updates || {}) } : h));
          toast("Updated habit");
          break;
        }
        case "tick_habit": {
          const val = a.value === undefined ? true : a.value;
          hs = hs.map((h) => {
            if (!matches(h, a, "name")) return h;
            if (val && h.tickedToday) return h;
            if (val) logHistory("habit", "Habit done: " + h.name);
            const cont = h.lastTicked && daysBetween(h.lastTicked, todayK) === 1;
            return {
              ...h,
              tickedToday: val,
              lastTicked: val ? todayK : null,
              streak: val ? (cont ? (h.streak || 0) + 1 : 1) : Math.max(0, (h.streak || 0) - 1),
              week: [...(h.week || [0, 0, 0, 0, 0, 0, 0]).slice(0, 6), val ? 1 : 0],
            };
          });
          toast("Habit updated");
          break;
        }
        case "delete_habit": {
          const before = hs.length;
          hs = hs.filter((h) => !matches(h, a, "name"));
          if (hs.length < before) toast("Deleted habit");
          break;
        }
        case "add_idea": {
          if (!a.text || is.some((i) => norm(i.t) === norm(a.text))) break;
          is = [...is, { id: uid(), t: a.text }];
          toast("Added idea");
          break;
        }
        case "delete_idea": {
          const before = is.length;
          is = is.filter((i) => !matches(i, a, "t"));
          if (is.length < before) toast("Deleted idea");
          break;
        }
        case "add_context": {
          if (a.text) noteContext(a.text);
          break;
        }
        case "add_block": {
          if (!a.title) break;
          setTodayPlan((prev) => {
            if (prev.some((b) => norm(b.title) === norm(a.title) && !b.done && b.status !== "skipped")) return prev;
            return [
              ...prev,
              {
                time: a.time || "Anytime",
                title: a.title,
                desc: a.desc || "",
                imp: Math.min(3, Math.max(1, Number(a.imp) || 2)),
                duration: a.duration || "",
                id: uid(),
                done: false,
                status: "pending",
                startTime: null,
              },
            ];
          });
          toast("Added to today: " + a.title);
          break;
        }
        case "remove_block": {
          if (!a.title) break;
          setTodayPlan((prev) => prev.filter((b) => b.done || !norm(b.title).includes(norm(a.title))));
          toast("Removed from today");
          break;
        }
        case "edit_block": {
          if (!a.title) break;
          setTodayPlan((prev) =>
            prev.map((b) => (norm(b.title).includes(norm(a.title)) ? { ...b, ...(a.updates || {}) } : b))
          );
          toast("Updated today's plan");
          break;
        }
        case "clear_completed_tasks": {
          ts = ts.filter((t) => !t.done);
          toast("Cleared completed tasks");
          break;
        }
        case "generate_plan":
          wantPlan = true;
          break;
        case "generate_tomorrow_plan":
          wantTomorrow = true;
          break;
        default:
          break;
      }
    }
    return { gs, ts, hs, is, wantPlan, wantTomorrow };
  }

  // Today's Generate lays out habits and nothing else. Real planning happens in the
  // Tomorrow tab or through Chat; this never invents goals, tasks, or filler.
  async function generateToday(snap) {
    const src = snap || { gs: goals, ts: tasks, hs: habits, is: ideas };
    const allHabits = src.hs || [];

    if (!allHabits.length) {
      toast("No habits yet - add some in Habits");
      return;
    }

    const onPlan = new Set(todayPlan.map((b) => norm(b.title)));
    const pool = allHabits.filter((h) => !h.tickedToday && !onPlan.has(norm(h.name)));

    if (!pool.length) {
      toast("Every habit is already done or on the plan");
      return;
    }

    const habitBlock = (h, time, desc, duration, imp) => ({
      time: time || "Anytime",
      title: h.name,
      desc: desc || h.note || "",
      imp: Math.min(3, Math.max(1, Number(imp) || 2)),
      duration: duration || (timestamps[h.name] ? "~" + timestamps[h.name].avg + " min" : ""),
      id: uid(),
      done: false,
      status: "pending",
      startTime: null,
      habitId: h.id,
    });

    setPlanLoading(true);

    const habitList = pool
      .map(
        (h) =>
          `- ${h.name}${h.freq ? ` (${h.freq})` : ""}${h.note ? ` - ${h.note}` : ""}${
            timestamps[h.name] ? `, usually takes about ${timestamps[h.name].avg} min` : ""
          }`
      )
      .join("\n");

    const system = `You lay out the user's habits for today in Locus. That is the whole job.

HABITS TO PLACE (complete and only list):
${habitList}

RULES:
- Output exactly one block per habit above - no more, no fewer.
- Each block's "title" must be the habit name copied EXACTLY as written above, character for character.
- Add NOTHING else. No goals, no tasks, no errands, no meals, no flex or buffer blocks, no filler of any kind. If it is not in the list above, it does not go in the plan.
- No clock times. "time" is a phase of day: Morning, Late morning, Midday, Afternoon, Evening, or Night. Pick the phase that suits each habit.
- Order the blocks in the sequence they should happen across the day.
- Give each block an approximate duration like "~20 min" or "~1 hr". Use the stated typical time when one is given.
- "desc" is one short, specific line about doing that habit today. Never generic filler.
- Respond with ONLY a JSON array. No prose, no markdown fences.
Format: [{"time":"Morning","title":"...","desc":"...","imp":2,"duration":"~20 min"}]
imp is 1, 2, or 3.`;

    let blocks = [];
    try {
      const raw = extractJSONArray(
        await callClaude(system, [{ role: "user", content: "Lay out my habits for today." }])
      );
      const used = new Set();
      // Hard filter: a block survives only if its title matches a real habit in the pool.
      for (const b of Array.isArray(raw) ? raw : []) {
        const h = pool.find((x) => !used.has(x.id) && norm(x.name) === norm(b && b.title));
        if (!h) continue;
        used.add(h.id);
        blocks.push(habitBlock(h, b.time, b.desc, b.duration, b.imp));
      }
      // Any habit it dropped still gets a plain block, so nothing goes missing.
      for (const h of pool) if (!used.has(h.id)) blocks.push(habitBlock(h));
      toast(`Added ${blocks.length} habit block${blocks.length === 1 ? "" : "s"}`);
    } catch {
      blocks = pool.map((h) => habitBlock(h));
      toast("Couldn't reach Claude - added habits plainly");
    }

    setTodayPlan((prev) => [...prev, ...blocks]);
    setPlanLoading(false);
  }

  async function generateTomorrow(extra, snap) {
    const src = snap || { gs: goals, ts: tasks, hs: habits, is: ideas };
    setPlanLoading(true);
    const ctx = buildContext({
      goals: src.gs,
      tasks: src.ts,
      habits: src.hs,
      ideas: src.is,
      skipPatterns,
      timestamps,
      context,
    });
    try {
      const text = await callClaude(
        `You build tomorrow's plan for Locus.\n\n${ctx}\n\nSUGGESTIONS THE USER PICKED FOR TOMORROW:\n${
          selectedSuggestions.join("\n") || "none"
        }\n\nEVERYTHING ELSE THE USER SAID:\n${extra || "nothing"}\n\n${PLAN_RULES}`,
        [{ role: "user", content: "Build my plan for tomorrow." }]
      );
      const blocks = extractJSONArray(text).map((b) => ({
        time: b.time || "Anytime",
        title: b.title || "Untitled",
        desc: b.desc || "",
        imp: Math.min(3, Math.max(1, Number(b.imp) || 2)),
        duration: b.duration || "",
        id: uid(),
        done: false,
        status: "pending",
        startTime: null,
      }));
      setTomorrowPlan(blocks);
      save(KEYS.tomorrowDate, tomorrowK);
      toast("Tomorrow's plan ready");
    } catch {
      toast("Couldn't generate tomorrow's plan");
    }
    setPlanLoading(false);
  }

  async function loadSuggestions() {
    setSugLoading(true);
    const ctx = buildContext({ goals, tasks, habits, ideas, skipPatterns, timestamps, context });
    try {
      const text = await callClaude(
        `You suggest what the user could do tomorrow.\n\n${ctx}\n\nGive 6 to 8 short suggestion cards. Mix front burner goal work, pending tasks that matter, anything time sensitive, and recovery or social if neglected. Never suggest a habit that is not in the HABITS list. Respond with ONLY a JSON array, no prose:\n[{"title":"...","desc":"...","type":"goal|task|social|recovery|other","imp":1}]`,
        [{ role: "user", content: "What should I do tomorrow?" }]
      );
      setTomorrowSuggestions(extractJSONArray(text));
    } catch {
      toast("Couldn't load suggestions");
    }
    setSugLoading(false);
  }

  function toggleBlock(id) {
    const b = todayPlan.find((x) => x.id === id);
    if (!b || b.status === "skipped") return;
    if (!b.done) {
      recordDuration(b.title, b.startTime);
      logHistory("task", "Completed: " + b.title);
      if (navigator.vibrate) navigator.vibrate([12, 8, 20]);
    }
    setTodayPlan((prev) => prev.map((x) => (x.id === id ? { ...x, done: !x.done } : x)));
  }

  function startBlock(id) {
    setTodayPlan((prev) => prev.map((x) => (x.id === id && !x.startTime ? { ...x, startTime: Date.now() } : x)));
  }

  function skipBlock(id, reason) {
    const b = todayPlan.find((x) => x.id === id);
    if (!b) return;
    bumpSkip(b.title);
    logHistory("skip", "Skipped: " + b.title + (reason ? " - " + reason : ""));
    if (reason) noteContext(`Skipped ${b.title}: ${reason}`);
    setTodayPlan((prev) => prev.map((x) => (x.id === id ? { ...x, status: "skipped", skipReason: reason } : x)));
  }

  function confirmReschedule() {
    const b = todayPlan.find((x) => x.id === rescheduleId);
    if (b) {
      bumpSkip(b.title);
      logHistory(
        "reschedule",
        "Moved: " +
          b.title +
          (rescheduleTime ? " to " + rescheduleTime : "") +
          (rescheduleReason ? " - " + rescheduleReason : "")
      );
      if (rescheduleReason) noteContext(`Moved ${b.title}: ${rescheduleReason}`);
      setTodayPlan((prev) =>
        prev.map((x) =>
          x.id === rescheduleId ? { ...x, status: "rescheduled", newTime: rescheduleTime, conflict: rescheduleReason } : x
        )
      );
    }
    setRescheduleId(null);
    setRescheduleReason("");
    setRescheduleTime("");
  }

  async function sendChat() {
    const msg = chatInput.trim();
    if (!msg || chatLoading) return;
    setChatInput("");
    const nextHistory = [...chatHistory, { role: "user", content: msg }];
    setChatHistory(nextHistory);
    setChatLoading(true);

    const ctx = buildContext({ goals, tasks, habits, ideas, skipPatterns, timestamps, context });
    const wantsSearch =
      /\b(search|look up|find me|google|near me|events?|festival|concert|news|latest|current|who is|what's happening)\b/i.test(
        msg
      );
    const planState = todayPlan.length
      ? todayPlan.map((b) => `${b.title} [${b.done ? "done" : b.status}]`).join("; ")
      : "no plan generated yet";

    const system = `You are Locus, the user's personal life planner. You can change their data directly.

${ctx}

TODAY'S PLAN RIGHT NOW: ${planState}

Reply in plain conversational text. If you need to change data, put a JSON array of actions on the FINAL line by itself with nothing after it.

ACTIONS:
{"type":"add_goal","name","area","desc","deadline","priority":"front|maint|back"}
{"type":"edit_goal","name","updates":{}}
{"type":"delete_goal","name"}
{"type":"set_goal_priority","name","priority"}
{"type":"promote_idea","text","area","priority"}
{"type":"add_task","name","due","goal","importance":1|2|3}
{"type":"edit_task","name","updates":{}}
{"type":"complete_task","name"}
{"type":"uncomplete_task","name"}
{"type":"delete_task","name"}
{"type":"add_habit","name","freq","note"}
{"type":"edit_habit","name","updates":{}}
{"type":"tick_habit","name","value":true|false}
{"type":"delete_habit","name"}
{"type":"add_idea","text"}
{"type":"delete_idea","text"}
{"type":"add_context","text"}
{"type":"add_block","time":"Morning|Late morning|Midday|Afternoon|Evening|Night","title","desc","duration":"~30 min","imp":1|2|3}
{"type":"remove_block","title"}
{"type":"edit_block","title","updates":{"time":"...","desc":"...","duration":"..."}}
{"type":"clear_completed_tasks"}
{"type":"generate_plan"}  <- lays out ONLY the user's existing habits on today, appended to the current plan. It never builds a full day and never adds goals or tasks.
{"type":"generate_tomorrow_plan"}

HARD RULES:
1. The plan must always reflect reality, but change it with the smallest action that works:
   - User wants to add one thing to today: use add_block. Do NOT regenerate.
   - User wants to drop or tweak one thing: use remove_block or edit_block. Do NOT regenerate.
   - generate_plan does NOT build a day. It only lays out the user's existing habits. Use it when they ask for their habits, and never as a way to restructure the day.
   - When the day is blown up, fix it with one remove_block or edit_block per change. There is no action that rebuilds today for you.
   - Acknowledging a change without emitting any action is a failure.
2. Never add a goal, task, habit, idea, or plan block that already exists in the lists above. Check first.
3. Only reference habits that exist in the HABITS list. Never invent one. Never schedule anything whose name only appears in skip patterns or completion time stats - those are history, not current commitments.
4. Never emit an action with an empty name or text field.
5. When the user shares stress, mood, or life circumstances, capture it with add_context so future plans account for it.
6. Be direct and specific. Reference their real goals by name. Confirm exactly what you changed.

Example (small addition - no regenerate):
Added a call with Alex to this evening.
[{"type":"add_block","time":"Evening","title":"Call with Alex","desc":"Prep your two main questions beforehand.","duration":"~30 min","imp":2}]

Example (day blown up - fix it piece by piece, never regenerate):
Rough one. Dropped the deep work block and moved the call to tonight.
[{"type":"add_context","text":"Lost the afternoon to an emergency, day restructured"},{"type":"remove_block","title":"Deep work"},{"type":"edit_block","title":"Call with Alex","updates":{"time":"Evening"}}]`;

    try {
      const reply = await callClaude(system, nextHistory, wantsSearch);
      let message = reply.trim();
      let actions = [];
      const lines = message.split("\n");
      const last = lines[lines.length - 1].trim();
      if (last.startsWith("[")) {
        try {
          const parsed = JSON.parse(last);
          if (Array.isArray(parsed)) {
            actions = parsed;
            message = lines.slice(0, -1).join("\n").trim();
          }
        } catch {}
      }

      setChatHistory((prev) => [...prev, { role: "assistant", content: message || "Done." }]);

      if (actions.length) {
        const res = applyActions(actions, { gs: goals, ts: tasks, hs: habits, is: ideas });
        setGoals(res.gs);
        setTasks(res.ts);
        setHabits(res.hs);
        setIdeas(res.is);
        if (res.wantPlan) await generateToday(res);
        if (res.wantTomorrow) await generateTomorrow("", res);
      }
    } catch {
      setChatHistory((prev) => [...prev, { role: "assistant", content: "Couldn't reach the server. Try again." }]);
    }
    setChatLoading(false);
  }

  // One build path for both the Build button and typing "generate" in the box.
  // Only the user's own messages are sent through - not Locus's replies.
  async function buildTomorrow(chat) {
    const notes = (chat || tmrChat)
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(". ");
    await generateTomorrow(notes, null);
    setTmrView("plan");
  }

  async function sendTomorrowChat() {
    const msg = tmrInput.trim();
    if (!msg || tmrLoading) return;
    setTmrInput("");
    const next = [...tmrChat, { role: "user", content: msg }];
    setTmrChat(next);
    setTmrLoading(true);
    const wantsGenerate = /\b(generate|build|make|create|do it|go ahead|ready|that's it)\b/i.test(msg);
    if (wantsGenerate) {
      await buildTomorrow(next);
      setTmrChat([
        ...next,
        { role: "assistant", content: "Built it. It becomes your Today plan automatically in the morning." },
      ]);
    } else {
      setTmrChat([...next, { role: "assistant", content: "Got it. Anything else? Hit Build when you're ready." }]);
    }
    setTmrLoading(false);
  }

  function tickHabit(id) {
    if (navigator.vibrate) navigator.vibrate([15, 10, 25]);
    const h0 = habits.find((h) => h.id === id);
    if (h0 && !h0.tickedToday) logHistory("habit", "Habit done: " + h0.name);
    setHabits((prev) =>
      prev.map((h) => {
        if (h.id !== id) return h;
        const val = !h.tickedToday;
        const cont = h.lastTicked && daysBetween(h.lastTicked, todayK) === 1;
        return {
          ...h,
          tickedToday: val,
          lastTicked: val ? todayK : null,
          streak: val ? (cont ? (h.streak || 0) + 1 : 1) : Math.max(0, (h.streak || 0) - 1),
          week: [...(h.week || [0, 0, 0, 0, 0, 0, 0]).slice(0, 6), val ? 1 : 0],
        };
      })
    );
  }

  const doneBlocks = todayPlan.filter((b) => b.done || b.status === "skipped");
  const openBlocks = todayPlan.filter((b) => !b.done && b.status !== "skipped");
  const completedCount = todayPlan.filter((b) => b.done).length;
  const progress = todayPlan.length ? Math.round((completedCount / todayPlan.length) * 100) : 0;

  const SUG_COLORS = { goal: "#8eaefb", task: "#f28b82", social: "#b8a0fc", recovery: "#81c995", other: "#706d68" };

  const navSections = [
    {
      title: "Plan",
      items: [
        { id: "today", label: "Today" },
        { id: "tomorrow", label: "Tomorrow" },
        { id: "calendar", label: "Calendar" },
      ],
    },
    { title: "Chat", items: [{ id: "chat", label: "Chat" }] },
    {
      title: "Organize",
      items: [
        { id: "goals", label: "Goals", badge: goals.length },
        { id: "tasks", label: "Tasks", badge: tasks.filter((t) => !t.done).length },
        { id: "habits", label: "Habits", badge: habits.length },
        { id: "ideas", label: "Ideas", badge: ideas.length },
      ],
    },
    { title: "Review", items: [{ id: "history", label: "History" }] },
  ];
  const allNav = navSections.flatMap((s) => s.items);

  const calY = calMonth.getFullYear();
  const calM = calMonth.getMonth();
  const firstDow = new Date(calY, calM, 1).getDay();
  const daysInMonth = new Date(calY, calM + 1, 0).getDate();

  const selectedDateObj = new Date(calSelected + "T12:00:00");
  const selectedPlan =
    calSelected === todayK
      ? todayPlan
      : calSelected === tomorrowK && tomorrowPlan.length
      ? tomorrowPlan
      : planArchive[calSelected] || [];
  const selectedHistory = history.find((h) => h.key === calSelected || h.date === prettyDate(selectedDateObj));

  const dayHasData = (k) => {
    if (k === todayK && todayPlan.length) return true;
    if (k === tomorrowK && tomorrowPlan.length) return true;
    if (planArchive[k] && planArchive[k].length) return true;
    return history.some((h) => h.key === k);
  };

  const card = { background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 12 };
  const mono = { fontFamily: "monospace" };
  const primaryBtn = {
    background: "#8eaefb",
    color: "#0e0f1a",
    border: "none",
    borderRadius: 7,
    padding: "8px 14px",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
  };
  const ghostBtn = {
    background: "none",
    border: "1px solid rgba(255,255,255,0.09)",
    borderRadius: 6,
    padding: "4px 11px",
    fontSize: 11,
    color: "#706d68",
    cursor: "pointer",
    ...mono,
  };
  const inputStyle = {
    flex: 1,
    background: "#22222a",
    border: "1px solid rgba(255,255,255,0.09)",
    borderRadius: 7,
    padding: "10px 14px",
    fontSize: 16,
    color: "#f2efe9",
    outline: "none",
  };
  const sectionLabel = {
    fontSize: 10,
    ...mono,
    color: "#706d68",
    textTransform: "uppercase",
    letterSpacing: "0.1em",
  };

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        background: "#1a1a20",
        color: "#f2efe9",
        fontFamily: "'Geist','Inter',sans-serif",
        fontSize: 14,
      }}
    >
      <div
        style={{
          position: "fixed",
          bottom: 24,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 400,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          alignItems: "center",
          pointerEvents: "none",
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              background: "#2a2a34",
              border: "1px solid rgba(142,174,251,0.3)",
              borderRadius: 8,
              padding: "8px 16px",
              fontSize: 12,
              color: "#8eaefb",
              ...mono,
              whiteSpace: "nowrap",
            }}
          >
            {t.msg}
          </div>
        ))}
      </div>

      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 50 }}
        />
      )}

      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          height: "100%",
          width: 220,
          background: "#22222a",
          borderRight: "1px solid rgba(255,255,255,0.09)",
          display: "flex",
          flexDirection: "column",
          zIndex: 60,
          transform: sidebarOpen ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 0.22s ease",
        }}
      >
        <div style={{ padding: "24px 20px 14px", display: "flex", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontFamily: "Georgia,serif", fontSize: 21, fontStyle: "italic" }}>Locus</div>
            <div style={{ fontSize: 11, color: "#706d68", marginTop: 3 }}>where focus lives</div>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "#706d68", fontSize: 18 }}
          >
            &times;
          </button>
        </div>
        <nav style={{ padding: "0 10px", flex: 1, overflowY: "auto" }}>
          {navSections.map((sec) => (
            <div key={sec.title}>
              <div
                style={{
                  fontSize: 9,
                  ...mono,
                  color: "#4a4a55",
                  textTransform: "uppercase",
                  letterSpacing: "0.14em",
                  padding: "12px 10px 4px",
                }}
              >
                {sec.title}
              </div>
              {sec.items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    setTab(item.id);
                    setSidebarOpen(false);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: 7,
                    cursor: "pointer",
                    color: tab === item.id ? "#8eaefb" : "#b0aca6",
                    background: tab === item.id ? "rgba(142,174,251,0.16)" : "none",
                    border: "none",
                    width: "100%",
                    textAlign: "left",
                    fontSize: 13,
                    marginBottom: 1,
                    fontWeight: tab === item.id ? 500 : 400,
                  }}
                >
                  {item.label}
                  {item.badge !== undefined && (
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: 10,
                        background: tab === item.id ? "rgba(142,174,251,0.28)" : "#32323e",
                        color: tab === item.id ? "#8eaefb" : "#706d68",
                        padding: "1px 6px",
                        borderRadius: 99,
                      }}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div
          style={{
            padding: "14px 20px",
            borderTop: "1px solid rgba(255,255,255,0.09)",
            fontSize: 11,
            color: "#706d68",
            ...mono,
          }}
        >
          <div>{now.toLocaleDateString("en-US", { weekday: "long" })}</div>
          <div style={{ marginTop: 2, color: "#b0aca6" }}>
            {now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
            <button
              onClick={() => {
                if (
                  window.confirm(
                    "Clear learned stats, context notes, history, and archived plans? Your goals, tasks, habits, and ideas stay."
                  )
                ) {
                  setSkipPatterns({});
                  setTimestamps({});
                  setContext([]);
                  setHistory([]);
                  setPlanArchive({});
                  toast("Stats & history cleared");
                }
              }}
              style={{
                flex: 1,
                background: "none",
                border: "1px solid rgba(255,255,255,0.09)",
                borderRadius: 6,
                padding: "5px 6px",
                fontSize: 9,
                color: "#706d68",
                cursor: "pointer",
                ...mono,
              }}
            >
              clear stats
            </button>
            <button
              onClick={() => {
                if (window.confirm("Erase ALL data and start completely fresh? This cannot be undone.")) {
                  Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
                  window.location.reload();
                }
              }}
              style={{
                flex: 1,
                background: "none",
                border: "1px solid rgba(242,139,130,0.25)",
                borderRadius: 6,
                padding: "5px 6px",
                fontSize: 9,
                color: "#f28b82",
                cursor: "pointer",
                ...mono,
              }}
            >
              reset all
            </button>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 16px",
            borderBottom: "1px solid rgba(255,255,255,0.09)",
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => setSidebarOpen(true)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "#b0aca6", fontSize: 20 }}
          >
            &#9776;
          </button>
          <div style={{ fontFamily: "Georgia,serif", fontSize: 16, fontStyle: "italic" }}>
            {allNav.find((n) => n.id === tab)?.label}
          </div>
        </div>

        {tab === "today" && (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
            <div style={{ padding: "16px 20px 14px", borderBottom: "1px solid rgba(255,255,255,0.09)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontStyle: "italic" }}>
                    {now.toLocaleDateString("en-US", { weekday: "long" })}
                  </div>
                  <div style={{ fontSize: 11, color: "#706d68", marginTop: 3, ...mono }}>
                    {now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                  </div>
                </div>
                <button
                  onClick={() => generateToday(null)}
                  disabled={planLoading}
                  style={{ ...primaryBtn, opacity: planLoading ? 0.6 : 1 }}
                >
                  {planLoading ? "..." : "Add habits"}
                </button>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
                <div style={{ flex: 1, height: 3, background: "#32323e", borderRadius: 99, overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: progress + "%",
                      background: "#8eaefb",
                      borderRadius: 99,
                      transition: "width 0.4s",
                    }}
                  />
                </div>
                <div style={{ fontSize: 11, ...mono, color: "#706d68" }}>
                  {completedCount} / {todayPlan.length}
                </div>
              </div>
            </div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {!todayPlan.length && (
                <div
                  style={{
                    padding: "48px 24px",
                    color: "#706d68",
                    ...mono,
                    fontSize: 12,
                    textAlign: "center",
                    lineHeight: 1.9,
                  }}
                >
                  {habits.length
                    ? "Nothing on today yet. Add habits lays out your habits - everything else comes from the Tomorrow tab or Chat."
                    : "Nothing on today yet. You have no habits, so there is nothing to lay out - plan the day in the Tomorrow tab, or add blocks through Chat."}
                </div>
              )}
              {doneBlocks.map((b) => (
                <PlanBlock
                  key={b.id}
                  block={b}
                  onToggle={toggleBlock}
                  onSkip={skipBlock}
                  onReschedule={setRescheduleId}
                  onStart={startBlock}
                  skipCount={skipPatterns[b.title] || 0}
                />
              ))}
              {doneBlocks.length > 0 && openBlocks.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 16px 7px 48px" }}>
                  <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.09)" }} />
                  <div style={sectionLabel}>Now</div>
                  <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.09)" }} />
                </div>
              )}
              {openBlocks.map((b) => (
                <PlanBlock
                  key={b.id}
                  block={b}
                  onToggle={toggleBlock}
                  onSkip={skipBlock}
                  onReschedule={setRescheduleId}
                  onStart={startBlock}
                  skipCount={skipPatterns[b.title] || 0}
                />
              ))}
            </div>
          </div>
        )}

        {tab === "tomorrow" && (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
            {/* --- header: date, planned-state, segment switch --- */}
            <div style={{ padding: "14px 20px 0", flexShrink: 0 }}>
              <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontStyle: "italic", lineHeight: 1.15 }}>
                {tomorrowDate.toLocaleDateString("en-US", { weekday: "long" })}
              </div>
              <div style={{ ...sectionLabel, marginTop: 5 }}>
                {tomorrowDate.toLocaleDateString("en-US", { month: "long", day: "numeric" })}
                {" · "}
                <span style={{ color: tomorrowPlan.length ? "#8eaefb" : "#706d68" }}>
                  {tomorrowPlan.length
                    ? tomorrowPlan.length + " block" + (tomorrowPlan.length === 1 ? "" : "s") + " planned"
                    : "not planned yet"}
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 4,
                  background: "#22222a",
                  border: "1px solid rgba(255,255,255,0.09)",
                  borderRadius: 9,
                  padding: 3,
                  marginTop: 13,
                }}
              >
                {[
                  { id: "ideas", label: "Ideas", n: selectedSuggestions.length },
                  { id: "plan", label: "Plan", n: tomorrowPlan.length },
                ].map((v) => (
                  <button
                    key={v.id}
                    onClick={() => setTmrView(v.id)}
                    style={{
                      flex: 1,
                      background: tmrView === v.id ? "rgba(142,174,251,0.16)" : "none",
                      border: "none",
                      borderRadius: 6,
                      padding: "7px 0",
                      cursor: "pointer",
                      ...mono,
                      fontSize: 11,
                      letterSpacing: "0.06em",
                      color: tmrView === v.id ? "#8eaefb" : "#706d68",
                    }}
                  >
                    {v.label}
                    <span
                      style={{
                        marginLeft: 5,
                        color: tmrView === v.id ? "#8eaefb" : "#4a4a55",
                        opacity: tmrView === v.id ? 0.75 : 1,
                      }}
                    >
                      {v.n}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* --- segment body --- */}
            <div style={{ flex: 1, overflowY: "auto", padding: "14px 20px 6px" }}>
              {tmrView === "ideas" ? (
                <>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 11,
                    }}
                  >
                    <div style={sectionLabel}>Suggestions</div>
                    <button onClick={loadSuggestions} disabled={sugLoading} style={ghostBtn}>
                      {sugLoading ? "..." : "refresh"}
                    </button>
                  </div>

                  {!tomorrowSuggestions.length && (
                    <div
                      style={{
                        color: "#706d68",
                        fontSize: 12,
                        ...mono,
                        textAlign: "center",
                        padding: "44px 12px",
                        lineHeight: 1.9,
                      }}
                    >
                      {sugLoading
                        ? "thinking..."
                        : "Hit refresh to see what Claude suggests, or just say what tomorrow needs below."}
                    </div>
                  )}

                  {tomorrowSuggestions.map((sug, i) => {
                    const sel = selectedSuggestions.includes(sug.title);
                    return (
                      <div
                        key={i}
                        onClick={() =>
                          setSelectedSuggestions((prev) =>
                            sel ? prev.filter((x) => x !== sug.title) : [...prev, sug.title]
                          )
                        }
                        style={{
                          background: sel ? "rgba(142,174,251,0.1)" : "#22222a",
                          border: `1px solid ${sel ? "rgba(142,174,251,0.4)" : "rgba(255,255,255,0.09)"}`,
                          borderRadius: 10,
                          padding: "11px 13px",
                          marginBottom: 7,
                          cursor: "pointer",
                          display: "flex",
                          gap: 10,
                          alignItems: "flex-start",
                        }}
                      >
                        <div
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: SUG_COLORS[sug.type] || "#706d68",
                            flexShrink: 0,
                            marginTop: 5,
                          }}
                        />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>{sug.title}</div>
                          <div style={{ fontSize: 12, color: "#b0aca6", lineHeight: 1.5 }}>{sug.desc}</div>
                        </div>
                        {sel && <div style={{ color: "#8eaefb", fontSize: 14 }}>&#10003;</div>}
                      </div>
                    );
                  })}
                </>
              ) : (
                <>
                  {!tomorrowPlan.length && (
                    <div
                      style={{
                        color: "#706d68",
                        fontSize: 12,
                        ...mono,
                        textAlign: "center",
                        padding: "44px 12px",
                        lineHeight: 1.9,
                      }}
                    >
                      Nothing built yet. Pick a few ideas or say what you need, then hit Build tomorrow's plan.
                    </div>
                  )}

                  {groupByPhase(tomorrowPlan).map((g, gi) => (
                    <div key={g.label + gi}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          margin: gi ? "16px 0 9px" : "2px 0 9px",
                        }}
                      >
                        <div style={sectionLabel}>{g.label}</div>
                        <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.09)" }} />
                      </div>
                      {g.blocks.map((b) => (
                        <div key={b.id} style={{ ...card, padding: "11px 13px", marginBottom: 7 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            {b.duration && <div style={{ fontSize: 10, ...mono, color: "#706d68" }}>{b.duration}</div>}
                            <div style={{ marginLeft: "auto" }}>
                              <ImpDots imp={b.imp} />
                            </div>
                          </div>
                          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>{b.title}</div>
                          <div style={{ fontSize: 12, color: "#b0aca6", lineHeight: 1.5 }}>{b.desc}</div>
                        </div>
                      ))}
                    </div>
                  ))}
                </>
              )}
            </div>

            {/* --- dock: picks, chat, composer, build. Pinned across both segments. --- */}
            <div
              style={{
                flexShrink: 0,
                borderTop: "1px solid rgba(255,255,255,0.09)",
                padding: "10px 20px 16px",
              }}
            >
              {selectedSuggestions.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 9 }}>
                  {selectedSuggestions.map((sTitle) => (
                    <div
                      key={sTitle}
                      style={{
                        background: "rgba(142,174,251,0.13)",
                        border: "1px solid rgba(142,174,251,0.3)",
                        color: "#8eaefb",
                        borderRadius: 99,
                        padding: "4px 8px 4px 10px",
                        fontSize: 11,
                        display: "flex",
                        gap: 6,
                        alignItems: "center",
                        ...mono,
                      }}
                    >
                      {sTitle}
                      <span
                        onClick={() => setSelectedSuggestions((prev) => prev.filter((x) => x !== sTitle))}
                        style={{ color: "rgba(142,174,251,0.6)", cursor: "pointer" }}
                      >
                        &times;
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {(tmrChat.length > 0 || tmrLoading) && (
                <div
                  style={{
                    maxHeight: 104,
                    overflowY: "auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: 7,
                    marginBottom: 9,
                  }}
                >
                  {tmrChat.map((m, i) => (
                    <div
                      key={i}
                      style={{
                        maxWidth: "88%",
                        padding: "7px 11px",
                        borderRadius: 10,
                        fontSize: 13,
                        lineHeight: 1.55,
                        alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                        background: m.role === "user" ? "rgba(142,174,251,0.16)" : "#2a2a34",
                        border:
                          m.role === "user"
                            ? "1px solid rgba(142,174,251,0.28)"
                            : "1px solid rgba(255,255,255,0.09)",
                      }}
                    >
                      {m.content}
                    </div>
                  ))}
                  {tmrLoading && <div style={{ fontSize: 12, color: "#706d68", ...mono }}>thinking...</div>}
                  <div ref={tmrEndRef} />
                </div>
              )}

              <div style={{ display: "flex", gap: 7 }}>
                <input
                  value={tmrInput}
                  onChange={(e) => setTmrInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendTomorrowChat()}
                  placeholder={
                    selectedSuggestions.length ? "Anything else tomorrow needs..." : "Tell me what tomorrow needs..."
                  }
                  style={inputStyle}
                />
                <button
                  onClick={sendTomorrowChat}
                  disabled={tmrLoading}
                  style={{
                    background: "rgba(142,174,251,0.16)",
                    border: "1px solid rgba(142,174,251,0.28)",
                    borderRadius: 8,
                    padding: "0 13px",
                    color: "#8eaefb",
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: "pointer",
                  }}
                >
                  Send
                </button>
              </div>

              <button
                onClick={() => buildTomorrow(null)}
                disabled={planLoading}
                style={
                  tomorrowPlan.length
                    ? {
                        width: "100%",
                        marginTop: 8,
                        background: "none",
                        border: "1px solid rgba(255,255,255,0.09)",
                        borderRadius: 8,
                        padding: "10px 0",
                        color: "#706d68",
                        ...mono,
                        fontSize: 11.5,
                        cursor: "pointer",
                        opacity: planLoading ? 0.6 : 1,
                      }
                    : {
                        ...primaryBtn,
                        width: "100%",
                        marginTop: 8,
                        padding: "11px 0",
                        fontSize: 13,
                        opacity: planLoading ? 0.6 : 1,
                      }
                }
              >
                {planLoading ? "..." : tomorrowPlan.length ? "rebuild from scratch" : "Build tomorrow's plan"}
              </button>
            </div>
          </div>
        )}

        {tab === "calendar" && (
          <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <button
                onClick={() => setCalMonth(new Date(calY, calM - 1, 1))}
                style={{
                  background: "none",
                  border: "1px solid rgba(255,255,255,0.09)",
                  borderRadius: 6,
                  padding: "5px 12px",
                  color: "#b0aca6",
                  cursor: "pointer",
                }}
              >
                &lsaquo;
              </button>
              <div style={{ fontFamily: "Georgia,serif", fontSize: 17, fontStyle: "italic" }}>
                {calMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
              </div>
              <button
                onClick={() => setCalMonth(new Date(calY, calM + 1, 1))}
                style={{
                  background: "none",
                  border: "1px solid rgba(255,255,255,0.09)",
                  borderRadius: 6,
                  padding: "5px 12px",
                  color: "#b0aca6",
                  cursor: "pointer",
                }}
              >
                &rsaquo;
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4, marginBottom: 6 }}>
              {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                <div key={i} style={{ textAlign: "center", fontSize: 10, ...mono, color: "#4a4a55" }}>
                  {d}
                </div>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4, marginBottom: 18 }}>
              {Array.from({ length: firstDow }).map((_, i) => (
                <div key={"pad" + i} />
              ))}
              {Array.from({ length: daysInMonth }).map((_, i) => {
                const day = i + 1;
                const k = `${calY}-${String(calM + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                const isToday = k === todayK;
                const isSel = k === calSelected;
                const has = dayHasData(k);
                return (
                  <div
                    key={k}
                    onClick={() => setCalSelected(k)}
                    style={{
                      aspectRatio: "1",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 2,
                      borderRadius: 8,
                      cursor: "pointer",
                      background: isSel ? "rgba(142,174,251,0.16)" : isToday ? "#2a2a34" : "none",
                      border: isSel
                        ? "1px solid rgba(142,174,251,0.4)"
                        : isToday
                        ? "1px solid rgba(255,255,255,0.14)"
                        : "1px solid transparent",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12,
                        color: isSel ? "#8eaefb" : isToday ? "#f2efe9" : "#706d68",
                        fontWeight: isToday || isSel ? 500 : 400,
                      }}
                    >
                      {day}
                    </div>
                    {has && (
                      <div style={{ width: 4, height: 4, borderRadius: "50%", background: isSel ? "#8eaefb" : "#4a4a55" }} />
                    )}
                  </div>
                );
              })}
            </div>

            <div style={{ ...sectionLabel, marginBottom: 10 }}>
              {selectedDateObj.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
              {calSelected === todayK ? " - today" : calSelected === tomorrowK ? " - tomorrow" : ""}
            </div>

            {!selectedPlan.length && !selectedHistory && (
              <div style={{ color: "#706d68", fontSize: 12, ...mono, padding: "12px 0" }}>
                nothing recorded for this day
              </div>
            )}

            {selectedPlan.map((b) => (
              <div
                key={b.id}
                style={{
                  ...card,
                  padding: "11px 14px",
                  marginBottom: 7,
                  opacity: b.done || b.status === "skipped" ? 0.45 : 1,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                  <div style={{ fontSize: 11, ...mono, color: "#8eaefb" }}>{b.time}</div>
                  {b.duration && <div style={{ fontSize: 10, ...mono, color: "#706d68" }}>{b.duration}</div>}
                  <ImpDots imp={b.imp} />
                  {b.done && <span style={{ marginLeft: "auto", fontSize: 10, ...mono, color: "#81c995" }}>done</span>}
                  {b.status === "skipped" && (
                    <span style={{ marginLeft: "auto", fontSize: 10, ...mono, color: "#706d68" }}>skipped</span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    textDecoration: b.done || b.status === "skipped" ? "line-through" : "none",
                  }}
                >
                  {b.title}
                </div>
                <div style={{ fontSize: 12, color: "#b0aca6", lineHeight: 1.5, marginTop: 2 }}>{b.desc}</div>
              </div>
            ))}

            {selectedHistory && (
              <div style={{ marginTop: 14 }}>
                <div style={{ ...sectionLabel, marginBottom: 6 }}>Activity</div>
                {selectedHistory.entries.map((e, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, padding: "5px 0", fontSize: 12, color: "#b0aca6" }}>
                    <span style={{ color: e.type === "task" ? "#81c995" : e.type === "habit" ? "#edbe80" : "#706d68" }}>
                      &bull;
                    </span>
                    <span style={{ flex: 1 }}>{e.text}</span>
                    {e.time && <span style={{ fontSize: 10, ...mono, color: "#4a4a55" }}>{e.time}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "chat" && (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 10,
                padding: "16px 20px",
              }}
            >
              <div
                style={{
                  maxWidth: "85%",
                  padding: "10px 14px",
                  borderRadius: 12,
                  fontSize: 13,
                  lineHeight: 1.65,
                  background: "#22222a",
                  border: "1px solid rgba(255,255,255,0.09)",
                  alignSelf: "flex-start",
                }}
              >
                Tell me anything - add a goal, check something off, dump what's on your mind, or say your day went
                sideways and I'll rebuild the plan.
              </div>
              {chatHistory.map((m, i) => (
                <div
                  key={i}
                  style={{
                    maxWidth: "85%",
                    padding: "10px 14px",
                    borderRadius: 12,
                    fontSize: 13,
                    lineHeight: 1.65,
                    whiteSpace: "pre-wrap",
                    alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                    background: m.role === "user" ? "rgba(142,174,251,0.16)" : "#22222a",
                    border: m.role === "user" ? "1px solid rgba(142,174,251,0.28)" : "1px solid rgba(255,255,255,0.09)",
                  }}
                >
                  {m.content}
                </div>
              ))}
              {chatLoading && <div style={{ fontSize: 12, color: "#706d68", ...mono }}>thinking...</div>}
              <div ref={chatEndRef} />
            </div>
            <div
              style={{ display: "flex", gap: 8, padding: "12px 20px 20px", borderTop: "1px solid rgba(255,255,255,0.09)" }}
            >
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendChat()}
                placeholder="What's going on..."
                style={inputStyle}
              />
              <button
                onClick={sendChat}
                disabled={chatLoading}
                style={{
                  background: "rgba(142,174,251,0.16)",
                  border: "1px solid rgba(142,174,251,0.28)",
                  borderRadius: 7,
                  padding: "10px 16px",
                  color: "#8eaefb",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Send
              </button>
            </div>
          </div>
        )}

        {tab === "goals" && (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
            <div
              style={{
                padding: "14px 20px",
                borderBottom: "1px solid rgba(255,255,255,0.09)",
                display: "flex",
                justifyContent: "flex-end",
              }}
            >
              <button
                onClick={() => setGoalModal({ name: "", area: "Fitness", desc: "", deadline: "", p: "front" })}
                style={primaryBtn}
              >
                + Add
              </button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
              {!goals.length && (
                <div style={{ color: "#706d68", fontSize: 12, ...mono, textAlign: "center", padding: "28px 0" }}>
                  no goals yet
                </div>
              )}
              {[...goals]
                .sort((a, b) => ["front", "maint", "back"].indexOf(a.p) - ["front", "maint", "back"].indexOf(b.p))
                .map((g) => (
                  <div
                    key={g.id}
                    onClick={() => setGoalModal(g)}
                    style={{
                      ...card,
                      borderLeft: `3px solid ${g.p === "front" ? "#8eaefb" : g.p === "maint" ? "#b8a0fc" : "#706d68"}`,
                      padding: "14px 16px",
                      marginBottom: 10,
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>{g.name}</div>
                      <div
                        style={{
                          fontSize: 10,
                          ...mono,
                          color: "#706d68",
                          background: "#32323e",
                          padding: "3px 8px",
                          borderRadius: 99,
                          marginLeft: 8,
                          flexShrink: 0,
                        }}
                      >
                        {g.area}
                      </div>
                    </div>
                    {g.desc && <div style={{ fontSize: 12.5, color: "#b0aca6", marginTop: 6, lineHeight: 1.6 }}>{g.desc}</div>}
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                      <div
                        style={{
                          fontSize: 11,
                          ...mono,
                          color: g.p === "front" ? "#8eaefb" : g.p === "maint" ? "#b8a0fc" : "#706d68",
                        }}
                      >
                        {g.p === "front" ? "front burner" : g.p === "maint" ? "maintenance" : "back burner"}
                      </div>
                      {g.deadline && (
                        <div style={{ fontSize: 11, ...mono, color: "#706d68", marginLeft: "auto" }}>{g.deadline}</div>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setGoals((prev) => prev.filter((x) => x.id !== g.id));
                          toast("Deleted goal");
                        }}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "#706d68",
                          marginLeft: g.deadline ? 0 : "auto",
                          fontSize: 12,
                        }}
                      >
                        &times;
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {tab === "tasks" && (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
            <div
              style={{
                padding: "14px 20px",
                borderBottom: "1px solid rgba(255,255,255,0.09)",
                display: "flex",
                justifyContent: "flex-end",
              }}
            >
              <button onClick={() => setTaskModal({ name: "", due: "", goal: "", imp: 2, done: false })} style={primaryBtn}>
                + Add
              </button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
              <div style={{ ...sectionLabel, marginBottom: 8 }}>Pending</div>
              {tasks
                .filter((t) => !t.done)
                .sort((a, b) => (b.imp || 1) - (a.imp || 1))
                .map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    onToggle={(id) => setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, done: !x.done } : x)))}
                    onEdit={setTaskModal}
                    onDelete={(id) => setTasks((prev) => prev.filter((x) => x.id !== id))}
                  />
                ))}
              {!tasks.filter((t) => !t.done).length && (
                <div style={{ color: "#706d68", fontSize: 12, ...mono, padding: "12px 0" }}>no pending tasks</div>
              )}
              {tasks.some((t) => t.done) && (
                <>
                  <div style={{ ...sectionLabel, margin: "20px 0 8px" }}>Completed</div>
                  {tasks
                    .filter((t) => t.done)
                    .map((t) => (
                      <TaskCard
                        key={t.id}
                        task={t}
                        onToggle={(id) => setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, done: !x.done } : x)))}
                        onEdit={setTaskModal}
                        onDelete={(id) => setTasks((prev) => prev.filter((x) => x.id !== id))}
                      />
                    ))}
                </>
              )}
            </div>
          </div>
        )}

        {tab === "habits" && (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
            <div
              style={{
                padding: "14px 20px",
                borderBottom: "1px solid rgba(255,255,255,0.09)",
                display: "flex",
                justifyContent: "flex-end",
              }}
            >
              <button onClick={() => setHabitModal({ name: "", freq: "", note: "" })} style={primaryBtn}>
                + Add
              </button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
              <div
                style={{
                  background: "#2a2a34",
                  borderRadius: 7,
                  padding: "10px 14px",
                  fontSize: 11,
                  color: "#706d68",
                  lineHeight: 1.6,
                  marginBottom: 14,
                  borderLeft: "3px solid rgba(237,190,128,0.3)",
                }}
              >
                These shape how Claude builds your plan. Any frequency works - daily, 3x a week, every other week.
              </div>
              {!habits.length && (
                <div style={{ color: "#706d68", fontSize: 12, ...mono, textAlign: "center", padding: "28px 0" }}>
                  no habits yet
                </div>
              )}
              {habits.map((h) => (
                <div
                  key={h.id}
                  style={{ ...card, padding: "13px 15px", marginBottom: 9, display: "flex", alignItems: "center", gap: 12 }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>{h.name}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span
                        style={{
                          fontSize: 10,
                          ...mono,
                          color: "#706d68",
                          background: "#32323e",
                          padding: "2px 7px",
                          borderRadius: 99,
                        }}
                      >
                        {h.freq || "custom"}
                      </span>
                      {h.note && <span style={{ fontSize: 11, color: "#706d68", ...mono }}>{h.note}</span>}
                    </div>
                    <div style={{ display: "flex", gap: 3, marginTop: 7 }}>
                      {(h.week || [0, 0, 0, 0, 0, 0, 0]).map((d, i) => (
                        <div
                          key={i}
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: "50%",
                            background: i === 6 && h.tickedToday ? "#81c995" : d ? "#edbe80" : "#32323e",
                          }}
                        />
                      ))}
                    </div>
                  </div>
                  {h.streak > 0 && <div style={{ fontSize: 11, ...mono, color: "#edbe80" }}>{h.streak}d</div>}
                  <div
                    onClick={() => tickHabit(h.id)}
                    style={{
                      width: 28,
                      height: 28,
                      border: `1.5px solid ${h.tickedToday ? "#81c995" : "rgba(255,255,255,0.22)"}`,
                      borderRadius: 8,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: h.tickedToday ? "rgba(129,201,149,0.12)" : "none",
                      color: "#81c995",
                      fontSize: 13,
                      flexShrink: 0,
                    }}
                  >
                    {h.tickedToday ? "\u2713" : ""}
                  </div>
                  <button
                    onClick={() => {
                      setHabits((prev) => prev.filter((x) => x.id !== h.id));
                      toast("Deleted habit");
                    }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#706d68", fontSize: 12 }}
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "ideas" && (
          <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              <input
                value={ideaInput}
                onChange={(e) => setIdeaInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && ideaInput.trim()) {
                    if (!ideas.some((i) => norm(i.t) === norm(ideaInput))) {
                      setIdeas((prev) => [...prev, { id: uid(), t: ideaInput.trim() }]);
                    }
                    setIdeaInput("");
                  }
                }}
                placeholder="Drop an idea, no commitment..."
                style={inputStyle}
              />
              <button
                onClick={() => {
                  if (ideaInput.trim() && !ideas.some((i) => norm(i.t) === norm(ideaInput))) {
                    setIdeas((prev) => [...prev, { id: uid(), t: ideaInput.trim() }]);
                  }
                  setIdeaInput("");
                }}
                style={primaryBtn}
              >
                Add
              </button>
            </div>
            {!ideas.length && (
              <div style={{ color: "#706d68", fontSize: 12, ...mono, textAlign: "center", padding: "28px 0" }}>
                nothing parked here yet
              </div>
            )}
            {ideas.map((i) => (
              <div
                key={i.id}
                style={{ ...card, padding: "11px 15px", marginBottom: 7, display: "flex", alignItems: "center", gap: 10 }}
              >
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#b8a0fc", opacity: 0.8, flexShrink: 0 }} />
                <div style={{ flex: 1, fontSize: 13, color: "#b0aca6" }}>{i.t}</div>
                <button
                  onClick={() => {
                    setChatInput("Promote this idea to a goal: " + i.t);
                    setTab("chat");
                  }}
                  style={{
                    fontSize: 10,
                    ...mono,
                    padding: "3px 8px",
                    borderRadius: 5,
                    border: "1px solid rgba(184,160,252,0.3)",
                    background: "none",
                    color: "#b8a0fc",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  &rarr; goal
                </button>
                <button
                  onClick={() => setIdeas((prev) => prev.filter((x) => x.id !== i.id))}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#706d68", fontSize: 12 }}
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}

        {tab === "history" && (
          <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
            {!history.length && (
              <div style={{ color: "#706d68", fontSize: 12, ...mono, textAlign: "center", padding: "28px 0" }}>
                no history yet
              </div>
            )}
            {history.map((day, di) => (
              <div key={di} style={{ marginBottom: 22 }}>
                <div style={{ ...sectionLabel, marginBottom: 9 }}>{day.date}</div>
                {day.entries.map((e, ei) => {
                  const color =
                    e.type === "task"
                      ? "#8eaefb"
                      : e.type === "habit"
                      ? "#edbe80"
                      : e.type === "reschedule"
                      ? "#f0c060"
                      : "#706d68";
                  return (
                    <div
                      key={ei}
                      style={{
                        ...card,
                        borderRadius: 7,
                        padding: "9px 13px",
                        marginBottom: 5,
                        display: "flex",
                        alignItems: "center",
                        gap: 9,
                      }}
                    >
                      <div style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
                      <div style={{ flex: 1, fontSize: 12.5, color: "#b0aca6" }}>{e.text}</div>
                      {e.time && <div style={{ fontSize: 10, ...mono, color: "#706d68" }}>{e.time}</div>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      {goalModal && (
        <Modal onClose={() => setGoalModal(null)} title={goalModal.id ? "Edit goal" : "Add goal"}>
          <Field label="Goal name">
            <input
              value={goalModal.name}
              onChange={(e) => setGoalModal((m) => ({ ...m, name: e.target.value }))}
              placeholder="e.g. Run a half marathon"
            />
          </Field>
          <Field label="Life area">
            <select value={goalModal.area} onChange={(e) => setGoalModal((m) => ({ ...m, area: e.target.value }))}>
              {["Fitness", "Career", "Learning", "Social", "Finance", "Health", "Creative", "Other"].map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </Field>
          <Field label="Description">
            <textarea
              value={goalModal.desc}
              onChange={(e) => setGoalModal((m) => ({ ...m, desc: e.target.value }))}
              placeholder="Why this matters..."
            />
          </Field>
          <Field label="Target timeframe">
            <input
              value={goalModal.deadline}
              onChange={(e) => setGoalModal((m) => ({ ...m, deadline: e.target.value }))}
              placeholder="e.g. by December"
            />
          </Field>
          <Field label="Priority">
            <div style={{ display: "flex", gap: 6 }}>
              {[
                ["front", "Front"],
                ["maint", "Maint"],
                ["back", "Back"],
              ].map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => setGoalModal((m) => ({ ...m, p: val }))}
                  style={{
                    flex: 1,
                    padding: "8px 4px",
                    fontSize: 11,
                    ...mono,
                    border: `1px solid ${goalModal.p === val ? "#8eaefb" : "rgba(255,255,255,0.09)"}`,
                    borderRadius: 7,
                    background: goalModal.p === val ? "rgba(142,174,251,0.16)" : "none",
                    color: goalModal.p === val ? "#8eaefb" : "#706d68",
                    cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
          <ModalActions
            onCancel={() => setGoalModal(null)}
            onSave={() => {
              const name = goalModal.name.trim();
              if (!name) return;
              if (!goalModal.id && goals.some((g) => norm(g.name) === norm(name))) {
                toast("That goal already exists");
                setGoalModal(null);
                return;
              }
              const g = { ...goalModal, name, id: goalModal.id || uid() };
              setGoals((prev) => (goalModal.id ? prev.map((x) => (x.id === g.id ? g : x)) : [...prev, g]));
              setGoalModal(null);
            }}
          />
        </Modal>
      )}

      {taskModal && (
        <Modal onClose={() => setTaskModal(null)} title={taskModal.id ? "Edit task" : "Add task"}>
          <Field label="Task name">
            <input
              value={taskModal.name}
              onChange={(e) => setTaskModal((m) => ({ ...m, name: e.target.value }))}
              placeholder="e.g. Register for fall classes"
            />
          </Field>
          <Field label="Due date">
            <input
              value={taskModal.due}
              onChange={(e) => setTaskModal((m) => ({ ...m, due: e.target.value }))}
              placeholder="e.g. June 15"
            />
          </Field>
          <Field label="Linked goal">
            <select value={taskModal.goal} onChange={(e) => setTaskModal((m) => ({ ...m, goal: e.target.value }))}>
              <option value="">none</option>
              {goals.map((g) => (
                <option key={g.id} value={g.name}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Importance">
            <div style={{ display: "flex", gap: 6 }}>
              {[
                [1, "Low"],
                [2, "Medium"],
                [3, "Critical"],
              ].map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => setTaskModal((m) => ({ ...m, imp: val }))}
                  style={{
                    flex: 1,
                    padding: "8px 6px",
                    fontSize: 11,
                    ...mono,
                    border: `1px solid ${taskModal.imp === val ? "#8eaefb" : "rgba(255,255,255,0.09)"}`,
                    borderRadius: 7,
                    background: taskModal.imp === val ? "rgba(142,174,251,0.16)" : "none",
                    color: taskModal.imp === val ? "#8eaefb" : "#706d68",
                    cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
          <ModalActions
            onCancel={() => setTaskModal(null)}
            onSave={() => {
              const name = taskModal.name.trim();
              if (!name) return;
              if (!taskModal.id && tasks.some((t) => !t.done && norm(t.name) === norm(name))) {
                toast("That task already exists");
                setTaskModal(null);
                return;
              }
              const t = { ...taskModal, name, id: taskModal.id || uid() };
              setTasks((prev) => (taskModal.id ? prev.map((x) => (x.id === t.id ? t : x)) : [...prev, t]));
              setTaskModal(null);
            }}
          />
        </Modal>
      )}

      {habitModal && (
        <Modal onClose={() => setHabitModal(null)} title={habitModal.id ? "Edit habit" : "Add habit"}>
          <Field label="Habit name">
            <input
              value={habitModal.name}
              onChange={(e) => setHabitModal((m) => ({ ...m, name: e.target.value }))}
              placeholder="e.g. Read 20 minutes"
            />
          </Field>
          <Field label="Frequency">
            <input
              value={habitModal.freq}
              onChange={(e) => setHabitModal((m) => ({ ...m, freq: e.target.value }))}
              placeholder="daily / 3x per week / every other week"
            />
          </Field>
          <Field label="Note (optional)">
            <input
              value={habitModal.note}
              onChange={(e) => setHabitModal((m) => ({ ...m, note: e.target.value }))}
              placeholder="e.g. mornings work best"
            />
          </Field>
          <ModalActions
            onCancel={() => setHabitModal(null)}
            onSave={() => {
              const name = habitModal.name.trim();
              if (!name) return;
              if (!habitModal.id && habits.some((h) => norm(h.name) === norm(name))) {
                toast("That habit already exists");
                setHabitModal(null);
                return;
              }
              const h = {
                ...habitModal,
                name,
                id: habitModal.id || uid(),
                streak: habitModal.streak || 0,
                week: habitModal.week || [0, 0, 0, 0, 0, 0, 0],
                tickedToday: habitModal.tickedToday || false,
                lastTicked: habitModal.lastTicked || null,
              };
              setHabits((prev) => (habitModal.id ? prev.map((x) => (x.id === h.id ? h : x)) : [...prev, h]));
              setHabitModal(null);
            }}
          />
        </Modal>
      )}

      {rescheduleId && (
        <Modal onClose={() => setRescheduleId(null)} title="What happened?">
          <Field label="Why couldn't you do it?">
            <textarea
              value={rescheduleReason}
              onChange={(e) => setRescheduleReason(e.target.value)}
              placeholder="Ran long, low energy, something came up..."
            />
          </Field>
          <Field label="Move it to when? (optional)">
            <input
              value={rescheduleTime}
              onChange={(e) => setRescheduleTime(e.target.value)}
              placeholder="tonight / tomorrow morning"
            />
          </Field>
          <div style={{ fontSize: 11, color: "#706d68", ...mono, marginTop: 4 }}>
            Claude remembers this and adjusts future plans.
          </div>
          <ModalActions onCancel={() => setRescheduleId(null)} onSave={confirmReschedule} saveLabel="Got it" />
        </Modal>
      )}
    </div>
  );
}

function PlanBlock({ block, onToggle, onSkip, onReschedule, onStart, skipCount }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [skipInput, setSkipInput] = useState("");
  const [showSkip, setShowSkip] = useState(false);
  const skipped = block.status === "skipped";
  const moved = block.status === "rescheduled";
  const mono = { fontFamily: "monospace" };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        borderBottom: "1px solid rgba(255,255,255,0.09)",
        opacity: block.done || skipped ? 0.32 : 1,
      }}
    >
      <div style={{ width: 48, flexShrink: 0, display: "flex", justifyContent: "center", paddingTop: 18 }}>
        <div
          onClick={() => {
            if (skipped) return;
            onStart(block.id);
            onToggle(block.id);
          }}
          style={{
            width: 18,
            height: 18,
            border: `1.5px solid ${block.done ? "#81c995" : "rgba(255,255,255,0.22)"}`,
            borderRadius: "50%",
            cursor: skipped ? "default" : "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: block.done ? "#81c995" : "none",
          }}
        >
          {block.done && (
            <div
              style={{
                width: 8,
                height: 5,
                borderLeft: "2px solid #0e1a11",
                borderBottom: "2px solid #0e1a11",
                transform: "rotate(-45deg) translateY(-1px)",
              }}
            />
          )}
        </div>
      </div>
      <div style={{ flex: 1, padding: "14px 8px 14px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
          <div style={{ fontSize: 11, ...mono, color: "#8eaefb" }}>
            {block.time}
            {block.duration ? " \u00b7 " + block.duration : ""}
            {moved && block.newTime ? " \u2192 " + block.newTime : ""}
          </div>
          <ImpDots imp={block.imp} />
        </div>
        <div
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: block.done || skipped ? "#706d68" : "#f2efe9",
            textDecoration: block.done || skipped ? "line-through" : "none",
            marginBottom: 3,
          }}
        >
          {block.title}
        </div>
        <div style={{ fontSize: 12.5, color: "#b0aca6", lineHeight: 1.6 }}>{block.desc}</div>

        {showSkip && (
          <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
            <input
              value={skipInput}
              onChange={(e) => setSkipInput(e.target.value)}
              placeholder="What came up? (optional)"
              style={{
                flex: 1,
                background: "#2a2a34",
                border: "1px solid rgba(255,255,255,0.09)",
                borderRadius: 6,
                padding: "6px 10px",
                fontSize: 16,
                color: "#f2efe9",
                outline: "none",
              }}
            />
            <button
              onClick={() => {
                onSkip(block.id, skipInput.trim());
                setShowSkip(false);
              }}
              style={{
                background: "#32323e",
                border: "none",
                borderRadius: 6,
                padding: "6px 12px",
                fontSize: 11,
                color: "#b0aca6",
                cursor: "pointer",
              }}
            >
              Skip
            </button>
          </div>
        )}

        <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap" }}>
          {block.done && (
            <span
              style={{
                fontSize: 10,
                ...mono,
                color: "#81c995",
                background: "rgba(129,201,149,0.12)",
                padding: "2px 8px",
                borderRadius: 99,
              }}
            >
              completed
            </span>
          )}
          {skipped && (
            <span
              style={{
                fontSize: 10,
                ...mono,
                color: "#706d68",
                background: "#32323e",
                padding: "2px 8px",
                borderRadius: 99,
              }}
            >
              skipped{block.skipReason ? " - " + block.skipReason : ""}
            </span>
          )}
          {moved && !block.done && (
            <span
              style={{
                fontSize: 10,
                ...mono,
                color: "#f0c060",
                background: "rgba(240,192,96,0.12)",
                padding: "2px 8px",
                borderRadius: 99,
              }}
            >
              moved
            </span>
          )}
          {skipCount >= 2 && !block.done && !skipped && (
            <span
              style={{
                fontSize: 10,
                ...mono,
                color: "#f28b82",
                background: "rgba(242,139,130,0.12)",
                padding: "2px 8px",
                borderRadius: 99,
              }}
            >
              skipped {skipCount}x recently
            </span>
          )}
        </div>
      </div>

      {!block.done && !skipped && (
        <div style={{ width: 34, flexShrink: 0, display: "flex", justifyContent: "center", paddingTop: 12, position: "relative" }}>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "#706d68", fontSize: 15, padding: 4 }}
          >
            &hellip;
          </button>
          {menuOpen && (
            <div
              style={{
                position: "absolute",
                right: 6,
                top: 32,
                background: "#2a2a34",
                border: "1px solid rgba(255,255,255,0.16)",
                borderRadius: 7,
                zIndex: 50,
                minWidth: 140,
                overflow: "hidden",
              }}
            >
              <button
                onClick={() => {
                  setShowSkip(true);
                  setMenuOpen(false);
                }}
                style={{
                  padding: "9px 13px",
                  fontSize: 12,
                  cursor: "pointer",
                  color: "#b0aca6",
                  background: "none",
                  border: "none",
                  width: "100%",
                  textAlign: "left",
                }}
              >
                Skip
              </button>
              <button
                onClick={() => {
                  onReschedule(block.id);
                  setMenuOpen(false);
                }}
                style={{
                  padding: "9px 13px",
                  fontSize: 12,
                  cursor: "pointer",
                  color: "#b0aca6",
                  background: "none",
                  border: "none",
                  width: "100%",
                  textAlign: "left",
                }}
              >
                Move
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskCard({ task, onToggle, onEdit, onDelete }) {
  const mono = { fontFamily: "monospace" };
  return (
    <div
      onClick={() => onEdit(task)}
      style={{
        background: "#22222a",
        border: "1px solid rgba(255,255,255,0.09)",
        borderRadius: 12,
        padding: "13px 15px",
        marginBottom: 8,
        display: "flex",
        alignItems: "flex-start",
        gap: 11,
        opacity: task.done ? 0.38 : 1,
        cursor: "pointer",
      }}
    >
      <div
        onClick={(e) => {
          e.stopPropagation();
          onToggle(task.id);
        }}
        style={{
          width: 17,
          height: 17,
          border: `1.5px solid ${task.done ? "#8eaefb" : "rgba(255,255,255,0.22)"}`,
          borderRadius: 5,
          flexShrink: 0,
          marginTop: 1,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: task.done ? "#8eaefb" : "none",
        }}
      >
        {task.done && (
          <div
            style={{
              width: 8,
              height: 5,
              borderLeft: "2px solid #0e0f1a",
              borderBottom: "2px solid #0e0f1a",
              transform: "rotate(-45deg) translateY(-1px)",
            }}
          />
        )}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, textDecoration: task.done ? "line-through" : "none" }}>{task.name}</div>
        {(task.due || task.goal) && (
          <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
            {task.due && <span style={{ fontSize: 11, ...mono, color: "#706d68" }}>Due: {task.due}</span>}
            {task.goal && <span style={{ fontSize: 11, ...mono, color: "#706d68" }}>&rarr; {task.goal}</span>}
          </div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <ImpDots imp={task.imp || 1} />
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(task.id);
          }}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#706d68", fontSize: 12 }}
        >
          &times;
        </button>
      </div>
    </div>
  );
}

function Modal({ children, onClose, title }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
        padding: "0 16px",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#22222a",
          border: "1px solid rgba(255,255,255,0.16)",
          borderRadius: 12,
          padding: 24,
          width: "100%",
          maxWidth: 420,
          maxHeight: "85vh",
          overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontFamily: "Georgia,serif", fontSize: 18, fontStyle: "italic", marginBottom: 18 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 13 }}>
      <div
        style={{
          fontSize: 10,
          fontFamily: "monospace",
          color: "#706d68",
          marginBottom: 5,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function ModalActions({ onCancel, onSave, saveLabel = "Save" }) {
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
      <button
        onClick={onCancel}
        style={{
          padding: "10px 16px",
          fontSize: 13,
          background: "none",
          border: "1px solid rgba(255,255,255,0.09)",
          borderRadius: 7,
          color: "#b0aca6",
          cursor: "pointer",
        }}
      >
        Cancel
      </button>
      <button
        onClick={onSave}
        style={{
          flex: 1,
          padding: 10,
          fontSize: 13,
          fontWeight: 500,
          background: "#8eaefb",
          color: "#0e0f1a",
          border: "none",
          borderRadius: 7,
          cursor: "pointer",
        }}
      >
        {saveLabel}
      </button>
    </div>
  );
}
