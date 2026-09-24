import { useState, useEffect, useRef } from "react";
import { supabase, pullAll, pushItems, pushPlanDay, pushDoc, isEmptyState } from "./db";
import { IS_DEMO, DEMO_STATE } from "./demo";
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
  if (IS_DEMO) return DEMO_STATE[key] ?? fallback;
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, val) {
  if (IS_DEMO) return;
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

/**
 * Pulls the action array out of a chat reply.
 *
 * The model is told to put it raw on the final line, but it sometimes wraps it
 * in a ```json fence or pretty-prints it across several lines. The old code
 * only accepted the final-line case, so anything else showed the user raw JSON
 * AND silently applied nothing - the worst pair of outcomes. Try each shape,
 * and if none parse, at least keep the payload out of the chat bubble and admit
 * the change didn't land.
 */
function splitReply(raw) {
  let message = (raw || "").trim();

  const looksLikeActions = (v) =>
    Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object" && typeof x.type === "string");

  const candidates = [];
  const fence = message.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push({ json: fence[1], cut: fence[0] });

  const lines = message.split("\n");
  const last = lines[lines.length - 1].trim();
  if (last.startsWith("[")) candidates.push({ json: last, cut: last });

  const open = message.lastIndexOf("[");
  const close = message.lastIndexOf("]");
  if (open !== -1 && close > open) {
    const slice = message.slice(open, close + 1);
    candidates.push({ json: slice, cut: slice });
  }

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.json.trim());
      if (looksLikeActions(parsed)) {
        return {
          message: message.replace(c.cut, "").replace(/```(?:json)?/gi, "").trim(),
          actions: parsed,
        };
      }
    } catch {
      // try the next shape
    }
  }

  if (/\{\s*"type"\s*:/.test(message)) {
    return {
      message: message
        .replace(/```(?:json)?[\s\S]*?```/gi, "")
        .replace(/\[\s*\{[\s\S]*\}\s*\]/g, "")
        .trim(),
      actions: [],
      unparsed: true,
    };
  }

  return { message, actions: [] };
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

  const today = new Date();
  const tmr = new Date(today.getTime() + 86400000);
  const longDate = (d) => d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  return `TODAY IS ${longDate(today)} (${isoKey(today)}). Tomorrow is ${longDate(tmr)} (${isoKey(tmr)}).
Never guess or assume the date - it is stated above. Any deadline you set must fall on or after today.
Write exact days as YYYY-MM-DD and keep vague ones vague ("Friday", "next week") rather than inventing a precise date.

USER CONTEXT

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

const IMP_COLORS = ["", "var(--muted)", "var(--accent)", "var(--red)"];

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
            background: i <= level ? IMP_COLORS[level] : "var(--chip)",
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
  const [transferCode, setTransferCode] = useState(null);

  // Supabase is the source of truth; localStorage is an offline cache.
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [syncReady, setSyncReady] = useState(false);
  const [syncNote, setSyncNote] = useState("");
  const pushTimers = useRef({});
  const hydratingRef = useRef(false);

  const now = new Date();
  const todayK = isoKey(now);
  const tomorrowDate = new Date(now.getTime() + 86400000);
  const tomorrowK = isoKey(tomorrowDate);

  const [calMonth, setCalMonth] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));
  const [calSelected, setCalSelected] = useState(todayK);

  const chatEndRef = useRef(null);
  const tmrEndRef = useRef(null);
  const rolledRef = useRef(false);
  const inboxDrainedRef = useRef(false);
  const mirrorTimerRef = useRef(null);

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
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session || null);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s || null);
      if (!s) setSyncReady(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const applyRemote = (remote) => {
    hydratingRef.current = true;
    setGoals(remote.goals);
    setTasks(remote.tasks);
    setHabits(remote.habits);
    setIdeas(remote.ideas);
    setPlanArchive(remote.planArchive);
    setTodayPlan(remote.planArchive[todayK] || []);
    setTomorrowPlan(remote.planArchive[tomorrowK] || []);
    setHistory(remote.history);
    setSkipPatterns(remote.skipPatterns);
    setTimestamps(remote.timestamps);
    setContext(remote.context);
    // Cleared after this render's effects have run, so hydrating never bounces
    // straight back to the server as a write.
    setTimeout(() => {
      hydratingRef.current = false;
    }, 0);
  };

  // First load after sign-in. If the account has no data yet but this browser
  // does, this is the device holding the only copy - seed the server from it
  // instead of wiping it. Otherwise the server wins.
  useEffect(() => {
    if (!session || syncReady) return;
    let cancelled = false;

    (async () => {
      try {
        const remote = await pullAll();
        if (cancelled) return;
        const uid = session.user.id;
        const localHasData =
          goals.length || tasks.length || habits.length || ideas.length || todayPlan.length || tomorrowPlan.length;

        if (isEmptyState(remote) && localHasData) {
          await Promise.all([
            pushItems("goals", goals, uid),
            pushItems("tasks", tasks, uid),
            pushItems("habits", habits, uid),
            pushItems("ideas", ideas, uid),
            pushPlanDay(todayK, todayPlan, uid),
            pushPlanDay(tomorrowK, tomorrowPlan, uid),
            pushDoc("history", history, uid),
            pushDoc("skipPatterns", skipPatterns, uid),
            pushDoc("timestamps", timestamps, uid),
            pushDoc("context", context, uid),
            ...Object.entries(planArchive).map(([d, blocks]) => pushPlanDay(d, blocks, uid)),
          ]);
          setSyncNote("uploaded this device's data");
        } else if (!isEmptyState(remote)) {
          applyRemote(remote);
        }

        setSyncReady(true);
      } catch {
        setSyncNote("offline - local copy");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  const queuePush = (key, run) => {
    if (!session || !syncReady || hydratingRef.current) return;
    clearTimeout(pushTimers.current[key]);
    pushTimers.current[key] = setTimeout(() => {
      pushTimers.current[key] = null;
      run(session.user.id).catch(() => setSyncNote("not saved - will retry"));
    }, 700);
  };

  useEffect(() => queuePush("goals", (uid) => pushItems("goals", goals, uid)), [goals]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => queuePush("tasks", (uid) => pushItems("tasks", tasks, uid)), [tasks]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => queuePush("habits", (uid) => pushItems("habits", habits, uid)), [habits]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => queuePush("ideas", (uid) => pushItems("ideas", ideas, uid)), [ideas]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => queuePush("today", (uid) => pushPlanDay(todayK, todayPlan, uid)), [todayPlan]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => queuePush("tomorrow", (uid) => pushPlanDay(tomorrowK, tomorrowPlan, uid)), [tomorrowPlan]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => queuePush("history", (uid) => pushDoc("history", history, uid)), [history]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => queuePush("skips", (uid) => pushDoc("skipPatterns", skipPatterns, uid)), [skipPatterns]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => queuePush("times", (uid) => pushDoc("timestamps", timestamps, uid)), [timestamps]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => queuePush("context", (uid) => pushDoc("context", context, uid)), [context]); // eslint-disable-line react-hooks/exhaustive-deps

  // Coming back to the tab pulls whatever the other device did while away.
  // Skipped if a local edit is still waiting to be written, so returning focus
  // can never overwrite something typed a moment ago.
  useEffect(() => {
    if (!session || !syncReady) return;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      if (Object.values(pushTimers.current).some(Boolean)) return;
      try {
        const remote = await pullAll();
        if (!isEmptyState(remote)) applyRemote(remote);
      } catch {
        // stay on the local copy
      }
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [session, syncReady, todayK, tomorrowK]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Drains actions queued by the Locus MCP connector (netlify/functions/mcp.js) -
  // e.g. saying "add this to Locus" in a plain Claude chat away from this app.
  // Runs once per page load, applies them through the SAME applyActions() the
  // in-app chat uses, then clears the queue server-side. If the backend isn't
  // deployed yet, or you're offline, this just silently no-ops.
  useEffect(() => {
    if (IS_DEMO) return;
    if (inboxDrainedRef.current) return;
    inboxDrainedRef.current = true;

    (async () => {
      try {
        const res = await fetch("/.netlify/functions/inbox");
        if (!res.ok) return;
        const { actions } = await res.json();
        if (!actions || !actions.length) return;

        // applyActions() only reads the fields each action type cares about
        // (type, name, due, ...), so the queue's own id/ts fields are harmless noise.
        const result = applyActions(actions, { gs: goals, ts: tasks, hs: habits, is: ideas });
        setGoals(result.gs);
        setTasks(result.ts);
        setHabits(result.hs);
        setIdeas(result.is);
        if (result.wantPlan) await generateToday(result);
        if (result.wantTomorrow) await generateTomorrow("", result);

        await fetch("/.netlify/functions/inbox", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: actions.map((a) => a.id) }),
        });
      } catch {
        // offline or backend not deployed - Locus still works standalone off localStorage
      }
    })();
  }, []);

  // Mirrors a read-only snapshot to the server so the Locus MCP connector can
  // answer questions about what's actually in here ("what's on my plate
  // Monday?"). localStorage stays the source of truth - this is a replica, and
  // every connector read reports its own age. Debounced so a burst of edits
  // sends one write.
  useEffect(() => {
    // A browser with nothing in it has nothing worth publishing - without this,
    // opening Locus in a fresh browser wipes the snapshot of the device that
    // actually holds the data. The server refuses these too; this just stops
    // the pointless request.
    const empty =
      !goals.length && !tasks.length && !habits.length && !ideas.length && !todayPlan.length && !tomorrowPlan.length;
    if (IS_DEMO || empty) return;

    if (mirrorTimerRef.current) clearTimeout(mirrorTimerRef.current);
    mirrorTimerRef.current = setTimeout(() => {
      fetch("/.netlify/functions/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goals, tasks, habits, ideas, todayPlan, tomorrowPlan, context }),
      }).catch(() => {});
    }, 2500);
    return () => clearTimeout(mirrorTimerRef.current);
  }, [goals, tasks, habits, ideas, todayPlan, tomorrowPlan, context]);

  // Moving Locus between devices. localStorage never leaves the browser it was
  // written in, so without this a new phone or laptop starts empty and the old
  // one holds the only copy of everything.
  async function sendToDevice() {
    setTransferCode(null);
    try {
      const res = await fetch("/.netlify/functions/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          state: {
            goals, tasks, habits, ideas, todayPlan, tomorrowPlan,
            planArchive, history, skipPatterns, timestamps, context,
          },
        }),
      });
      const data = await res.json();
      if (data.code) setTransferCode(data.code);
      else toast(data.error || "Couldn't create a code");
    } catch {
      toast("Couldn't reach the server");
    }
  }

  async function receiveFromDevice() {
    const code = window.prompt("Enter the code shown on your other device:");
    if (!code) return;
    try {
      const res = await fetch("/.netlify/functions/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "claim", code }),
      });
      const data = await res.json();
      if (data.error) {
        toast(data.error);
        return;
      }
      const s = data.state || {};
      const counts = `${(s.goals || []).length} goals, ${(s.tasks || []).length} tasks, ${(s.habits || []).length} habits`;
      if (!window.confirm(`Received ${counts}. This replaces everything currently in Locus on this device. Continue?`)) return;

      if (Array.isArray(s.goals)) setGoals(s.goals);
      if (Array.isArray(s.tasks)) setTasks(s.tasks);
      if (Array.isArray(s.habits)) setHabits(s.habits);
      if (Array.isArray(s.ideas)) setIdeas(s.ideas);
      if (Array.isArray(s.todayPlan)) setTodayPlan(s.todayPlan);
      if (Array.isArray(s.tomorrowPlan)) setTomorrowPlan(s.tomorrowPlan);
      if (Array.isArray(s.history)) setHistory(s.history);
      if (Array.isArray(s.context)) setContext(s.context);
      if (s.planArchive && typeof s.planArchive === "object") setPlanArchive(s.planArchive);
      if (s.skipPatterns && typeof s.skipPatterns === "object") setSkipPatterns(s.skipPatterns);
      if (s.timestamps && typeof s.timestamps === "object") setTimestamps(s.timestamps);

      toast("Data received from your other device");
    } catch {
      toast("Couldn't reach the server");
    }
  }

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

  async function sendChat(override) {
    const msg = (typeof override === "string" ? override : chatInput).trim();
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

Reply in plain conversational text. If you need to change data, put a JSON array of actions on the FINAL line by itself with nothing after it. Emit it as raw JSON - never wrap it in a code fence or label it.

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
      const { message, actions, unparsed } = splitReply(reply);

      setChatHistory((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            (message || "Done.") +
            (unparsed ? "\n\nI couldn't apply that change - say it again and I'll retry." : ""),
        },
      ]);

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

  const SUG_COLORS = { goal: "var(--accent)", task: "var(--red)", social: "var(--violet)", recovery: "var(--green)", other: "var(--muted)" };


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


  const [theme, setTheme] = useState(() => localStorage.getItem("locus_theme") || "light");
  const [userName, setUserName] = useState(() => localStorage.getItem("locus_name") || (IS_DEMO ? "Atri" : ""));
  const [cmdInput, setCmdInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const cmdRef = useRef(null);

  useEffect(() => localStorage.setItem("locus_theme", theme), [theme]);
  useEffect(() => localStorage.setItem("locus_name", userName), [userName]);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        cmdRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const mono = { fontFamily: "var(--mono)" };
  const card = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14 };
  const primaryBtn = {
    background: "var(--accent)",
    color: "var(--on-accent)",
    border: "1px solid var(--accent)",
    borderRadius: 9,
    padding: "8px 14px",
    fontSize: 12.5,
    fontWeight: 600,
    fontFamily: "inherit",
    cursor: "pointer",
  };
  const ghostBtn = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "5px 11px",
    fontSize: 11.5,
    fontFamily: "inherit",
    color: "var(--muted)",
    cursor: "pointer",
  };
  const inputStyle = {
    flex: 1,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "10px 14px",
    fontSize: 14,
    color: "var(--text)",
    outline: "none",
  };
  const sectionLabel = {
    fontSize: 10,
    fontWeight: 700,
    color: "var(--muted)",
    textTransform: "uppercase",
    letterSpacing: "0.12em",
  };

  const NAV = [
    {
      title: "Plan",
      items: [
        { id: "today", label: "Today", icon: "home" },
        { id: "calendar", label: "Calendar", icon: "calendar" },
        { id: "tomorrow", label: "Plan", icon: "target" },
        { id: "ideas", label: "Ideas", icon: "bulb", badge: ideas.length },
      ],
    },
    {
      title: "Organize",
      items: [
        { id: "goals", label: "Goals", icon: "compass", badge: goals.length },
        { id: "tasks", label: "Tasks", icon: "check", badge: tasks.filter((t) => !t.done).length },
        { id: "habits", label: "Habits", icon: "repeat", badge: habits.length },
        { id: "chat", label: "Chat", icon: "chat" },
        { id: "history", label: "History", icon: "clock" },
      ],
    },
  ];
  const ALL_NAV = NAV.flatMap((s) => s.items);

  const REPLAN = [
    { label: "Something came up", msg: "Something came up and my day shifted - rebuild the rest of today around it." },
    { label: "I have less time", msg: "I have less time than planned today. Trim the plan down to what actually matters." },
    { label: "I'm feeling low energy", msg: "I'm low energy right now. Reshape the rest of today into something I can actually do." },
    { label: "Prioritize something", msg: "I want to prioritize one thing for the rest of today - ask me which, then rebuild around it." },
    { label: "Tell Locus what changed", msg: "", accent: true },
  ];

  const hour = now.getHours();
  const greeting =
    (hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening") + (userName ? ", " + userName : "") + ".";

  const CATS = {
    school: { label: "School", icon: "book", color: "var(--blue)" },
    career: { label: "Career", icon: "briefcase", color: "var(--violet)" },
    health: { label: "Health", icon: "dumbbell", color: "var(--amber)" },
    startup: { label: "Startup", icon: "rocket", color: "var(--red)" },
    rest: { label: "Break", icon: "cup", color: "var(--green)" },
    admin: { label: "Admin", icon: "folder", color: "var(--muted)" },
    routine: { label: "Routine", icon: "star", color: "var(--accent)" },
    build: { label: "Build", icon: "rocket", color: "var(--accent)" },
    focus: { label: "Focus", icon: "dot", color: "var(--accent)" },
  };
  const CAT_WORDS = [
    ["school", /\b(class|lecture|study|homework|exam|problem set|reading|course|cs |acc |fin |quiz|assignment|revision|lab|tutor|tutoring|writeup|office hours)\b/],
    ["rest", /\b(break|lunch|dinner|breakfast|rest|nap|unwind|relax|recharge|meal|coffee)\b/],
    ["health", /\b(workout|gym|run|lift|walk|yoga|stretch|sleep|health|training|cardio)\b/],
    ["career", /\b(intern|job|apply|application|recruit|resume|interview|career|linkedin|networking|trailhead|cert|certification|salesforce|mock demo)\b/],
    ["startup", /\b(startup|launch|customer|build|ship|product|research|pitch|founder|market)\b/],
    ["build", /\b(merge|refactor|schema|migration|deploy|debug|backend|frontend|api|bug|feature|locus|ship it|rebuild)\b/],
    ["admin", /\b(email|inbox|admin|errand|chore|clean|bills|calendar|buffer|misc)\b/],
    ["routine", /\b(review|plan|reflect|journal|meditat|routine|wind down|morning|evening)\b/],
  ];
  const catOf = (b) => {
    const t = ((b.title || "") + " " + (b.desc || "")).toLowerCase();
    for (const [key, re] of CAT_WORDS) if (re.test(t)) return CATS[key];
    return CATS.focus;
  };
  const tint = (c, pct) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;

  const runCommand = () => {
    const v = cmdInput.trim();
    if (!v) return;
    setCmdInput("");
    setTab("chat");
    sendChat(v);
  };

  if (!authReady && !IS_DEMO) {
    return <div className={"app" + (theme === "dark" ? " dark" : "")} />;
  }
  if (!session && !IS_DEMO) {
    return <SignIn theme={theme} />;
  }

  return (
    <div className={"app" + (theme === "dark" ? " dark" : "")}>
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
              background: "var(--surface)",
              border: "1px solid var(--accent-line)",
              borderRadius: 10,
              padding: "9px 16px",
              fontSize: 12.5,
              fontWeight: 550,
              color: "var(--accent)",
              boxShadow: "var(--shadow-md)",
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
          style={{ position: "fixed", inset: 0, background: "rgba(16,18,26,0.38)", zIndex: 55 }}
        />
      )}

      <aside className={"sidebar" + (sidebarOpen ? " open" : "")}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "20px 18px 10px" }}>
          <div
            style={{
              width: 24,
              height: 24,
              borderRadius: "50%",
              border: "3.5px solid var(--text)",
              flexShrink: 0,
            }}
          />
          <div style={{ fontSize: 15.5, fontWeight: 750, letterSpacing: "0.16em" }}>LOCUS</div>
          <button className="icon-btn mobile-only" style={{ marginLeft: "auto" }} onClick={() => setSidebarOpen(false)}>
            &times;
          </button>
        </div>

        <nav className="scroll" style={{ flex: 1, padding: "6px 12px 12px" }}>
          {NAV.map((sec) => (
            <div key={sec.title}>
              <div className="nav-label">{sec.title}</div>
              {sec.items.map((item) => (
                <button
                  key={item.id}
                  className={"nav-item" + (tab === item.id ? " active" : "")}
                  onClick={() => {
                    setTab(item.id);
                    setSidebarOpen(false);
                  }}
                >
                  <span className="nav-icon"><Icon name={item.icon} /></span>
                  {item.label}
                  {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div style={{ borderTop: "1px solid var(--border)", padding: "12px" }}>
          <button className="nav-item" onClick={() => setSettingsOpen((o) => !o)}>
            <span className="nav-icon"><Icon name="gear" /></span>
            Settings
            <span style={{ marginLeft: "auto", color: "var(--muted-2)", fontSize: 11 }}>{settingsOpen ? "–" : "+"}</span>
          </button>

          {settingsOpen && (
            <div style={{ padding: "4px 4px 10px" }}>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  style={{ ...ghostBtn, flex: 1, fontSize: 10.5 }}
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
                >
                  clear stats
                </button>
                <button
                  style={{ ...ghostBtn, flex: 1, fontSize: 10.5, color: "var(--red)", borderColor: "var(--red)" }}
                  onClick={() => {
                    if (IS_DEMO) return;
                    if (window.confirm("Erase ALL data and start completely fresh? This cannot be undone.")) {
                      Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
                      window.location.reload();
                    }
                  }}
                >
                  reset all
                </button>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button style={{ ...ghostBtn, flex: 1, fontSize: 10.5 }} onClick={sendToDevice}>
                  send to device
                </button>
                <button style={{ ...ghostBtn, flex: 1, fontSize: 10.5 }} onClick={receiveFromDevice}>
                  receive
                </button>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button
                  style={{ ...ghostBtn, flex: 1, fontSize: 10.5 }}
                  onClick={async () => {
                    await supabase.auth.signOut();
                    toast("Signed out");
                  }}
                >
                  sign out
                </button>
              </div>
              <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 8, lineHeight: 1.5 }}>
                {session.user.email}
                <br />
                {syncNote || (syncReady ? "synced" : "connecting...")}
              </div>
              {transferCode && (
                <div
                  style={{
                    marginTop: 8,
                    padding: "8px 10px",
                    border: "1px solid var(--accent-line)",
                    borderRadius: 8,
                    background: "var(--accent-soft)",
                  }}
                >
                  <div style={{ fontSize: 9.5, color: "var(--muted)", ...mono }}>enter on your other device</div>
                  <div style={{ fontSize: 18, letterSpacing: 3, color: "var(--accent)", marginTop: 4, ...mono }}>
                    {transferCode}
                  </div>
                  <div style={{ fontSize: 9.5, color: "var(--muted)", marginTop: 4, ...mono }}>
                    expires in 15 min &middot; one use
                  </div>
                </div>
              )}
            </div>
          )}

          <div
            onClick={() => {
              const n = window.prompt("What should Locus call you?", userName);
              if (n !== null) setUserName(n.trim());
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "9px 10px",
              marginTop: 4,
              borderRadius: 10,
              cursor: "pointer",
            }}
          >
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: "50%",
                background: "var(--accent-soft)",
                color: "var(--accent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12.5,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {(userName || "?").slice(0, 1).toUpperCase()}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {userName || "Add your name"}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>
                {now.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </div>
            </div>
          </div>
        </div>
      </aside>

      <div className="main">
        {IS_DEMO && (
          <div className="demo-bar">
            <span>
              Most planners hold your day. <span className="demo-bar-strong">Locus holds your life.</span>
            </span>
            <span className="demo-bar-sub">
              Goals, habits, tasks and parked ideas &mdash; the day is built out of all of it.
            </span>
            <span className="demo-bar-right">
              <span className="pill" style={{ background: "var(--surface)", color: "var(--accent)" }}>
                DEMO &middot; nothing saved
              </span>
              <a href="/" className="link-btn" style={{ textDecoration: "none" }}>
                Sign in
              </a>
            </span>
          </div>
        )}
        <header className="topbar">
          <button className="icon-btn mobile-only" onClick={() => setSidebarOpen(true)}>
            <Icon name="menu" />
          </button>
          <div className="topbar-title">
            {tab === "today" ? (
              <>
                <div className="greet">{greeting}</div>
                <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 5 }}>
                  {now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
                </div>
              </>
            ) : (
              <div className="greet" style={{ paddingTop: 3 }}>{ALL_NAV.find((n) => n.id === tab)?.label}</div>
            )}
          </div>

          <div className="cmd">
            <span style={{ color: "var(--accent)", display: "flex" }}><Icon name="sparkle" size={17} /></span>
            <input
              ref={cmdRef}
              className="bare"
              value={cmdInput}
              onChange={(e) => setCmdInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runCommand()}
              placeholder="What do you want to accomplish?"
            />
            <span className="kbd">&#8984;K</span>
            <button
              onClick={() => setTaskModal({ name: "", due: "", goal: "", imp: 2, done: false })}
              style={{
                width: 30,
                height: 30,
                borderRadius: 9,
                border: "none",
                background: "var(--accent)",
                color: "var(--on-accent)",
                fontSize: 17,
                lineHeight: 1,
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              +
            </button>
          </div>

          <button
            className="icon-btn topbar-theme"
            title="Toggle theme"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          >
            <Icon name={theme === "dark" ? "moon" : "sun"} />
          </button>
        </header>

        {tab === "today" && (
          <div className="scroll" style={{ flex: 1 }}>
            <div className="today-grid">
              <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
                <div className="card">
                  <div className="card-head">
                    <div className="card-title">Today</div>
                    <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
                      <div className="bar" style={{ width: 96 }}>
                        <div style={{ width: progress + "%", background: "var(--accent)" }} />
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
                        {completedCount}/{todayPlan.length}
                      </div>
                      <button className="btn" onClick={() => generateToday(null)} disabled={planLoading}>
                        {planLoading ? "…" : "Add habits"}
                      </button>
                    </div>
                  </div>

                  {!todayPlan.length && (
                    <div
                      style={{
                        padding: "44px 26px 48px",
                        color: "var(--muted)",
                        fontSize: 13,
                        textAlign: "center",
                        lineHeight: 1.8,
                        borderTop: "1px solid var(--border)",
                      }}
                    >
                      {habits.length
                        ? "Nothing on today yet. Add habits lays out your habits — everything else comes from Plan or Chat."
                        : "Nothing on today yet. You have no habits, so there's nothing to lay out — plan the day under Plan, or add blocks through Chat."}
                    </div>
                  )}

                  {doneBlocks.map((b) => (
                    <PlanBlock
                      key={b.id}
                      block={b}
                      cat={catOf(b)}
                      tint={tint}
                      onToggle={toggleBlock}
                      onSkip={skipBlock}
                      onReschedule={setRescheduleId}
                      onStart={startBlock}
                      skipCount={skipPatterns[b.title] || 0}
                    />
                  ))}

                  {doneBlocks.length > 0 && openBlocks.length > 0 && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "10px 18px",
                        borderTop: "1px solid var(--border)",
                      }}
                    >
                      <div style={sectionLabel}>Now</div>
                      <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                    </div>
                  )}

                  {openBlocks.map((b) => (
                    <PlanBlock
                      key={b.id}
                      block={b}
                      cat={catOf(b)}
                      tint={tint}
                      onToggle={toggleBlock}
                      onSkip={skipBlock}
                      onReschedule={setRescheduleId}
                      onStart={startBlock}
                      skipCount={skipPatterns[b.title] || 0}
                    />
                  ))}
                </div>

                <div className="card" style={{ padding: "16px 18px 18px" }}>
                  <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <div className="row-icon" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                      <Icon name="refresh" size={15} />
                    </div>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ fontSize: 14, fontWeight: 650 }}>Adaptive replanning</div>
                        <span className="pill" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                          BETA
                        </span>
                      </div>
                      <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>
                        Something came up? Let Locus adjust your plan.
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
                    {REPLAN.map((r) => (
                      <button
                        key={r.label}
                        className={"chip" + (r.accent ? " chip-accent" : "")}
                        onClick={() => {
                          setTab("chat");
                          if (r.msg) sendChat(r.msg);
                          else cmdRef.current?.focus();
                        }}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
        {tab === "tomorrow" && (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
            {/* --- header: date, planned-state, segment switch --- */}
            <div style={{ padding: "14px 20px 0", flexShrink: 0 }}>
              <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.4px", lineHeight: 1.15 }}>
                {tomorrowDate.toLocaleDateString("en-US", { weekday: "long" })}
              </div>
              <div style={{ ...sectionLabel, marginTop: 5 }}>
                {tomorrowDate.toLocaleDateString("en-US", { month: "long", day: "numeric" })}
                {" · "}
                <span style={{ color: tomorrowPlan.length ? "var(--accent)" : "var(--muted)" }}>
                  {tomorrowPlan.length
                    ? tomorrowPlan.length + " block" + (tomorrowPlan.length === 1 ? "" : "s") + " planned"
                    : "not planned yet"}
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 4,
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
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
                      background: tmrView === v.id ? "var(--accent-soft)" : "none",
                      border: "none",
                      borderRadius: 6,
                      padding: "7px 0",
                      cursor: "pointer",
                      ...mono,
                      fontSize: 11,
                      letterSpacing: "0.06em",
                      color: tmrView === v.id ? "var(--accent)" : "var(--muted)",
                    }}
                  >
                    {v.label}
                    <span
                      style={{
                        marginLeft: 5,
                        color: tmrView === v.id ? "var(--accent)" : "var(--muted-2)",
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
                        color: "var(--muted)",
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
                          background: sel ? "var(--accent-soft)" : "var(--surface)",
                          border: `1px solid ${sel ? "var(--accent-line)" : "var(--border)"}`,
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
                            background: SUG_COLORS[sug.type] || "var(--muted)",
                            flexShrink: 0,
                            marginTop: 5,
                          }}
                        />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>{sug.title}</div>
                          <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>{sug.desc}</div>
                        </div>
                        {sel && <div style={{ color: "var(--accent)", fontSize: 14 }}>&#10003;</div>}
                      </div>
                    );
                  })}
                </>
              ) : (
                <>
                  {!tomorrowPlan.length && (
                    <div
                      style={{
                        color: "var(--muted)",
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
                        <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                      </div>
                      {g.blocks.map((b) => (
                        <div key={b.id} style={{ ...card, padding: "11px 13px", marginBottom: 7 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            {b.duration && <div style={{ fontSize: 10, ...mono, color: "var(--muted)" }}>{b.duration}</div>}
                            <div style={{ marginLeft: "auto" }}>
                              <ImpDots imp={b.imp} />
                            </div>
                          </div>
                          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>{b.title}</div>
                          <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>{b.desc}</div>
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
                borderTop: "1px solid var(--border)",
                padding: "10px 20px 16px",
              }}
            >
              {selectedSuggestions.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 9 }}>
                  {selectedSuggestions.map((sTitle) => (
                    <div
                      key={sTitle}
                      style={{
                        background: "var(--accent-soft)",
                        border: "1px solid var(--accent-line)",
                        color: "var(--accent)",
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
                        style={{ color: "var(--accent)", cursor: "pointer" }}
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
                        background: m.role === "user" ? "var(--accent-soft)" : "var(--surface-2)",
                        border:
                          m.role === "user"
                            ? "1px solid var(--accent-line)"
                            : "1px solid var(--border)",
                      }}
                    >
                      {m.content}
                    </div>
                  ))}
                  {tmrLoading && <div style={{ fontSize: 12, color: "var(--muted)", ...mono }}>thinking...</div>}
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
                    background: "var(--accent-soft)",
                    border: "1px solid var(--accent-line)",
                    borderRadius: 8,
                    padding: "0 13px",
                    color: "var(--accent)",
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
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        padding: "10px 0",
                        color: "var(--muted)",
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
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "5px 12px",
                  color: "var(--text-2)",
                  cursor: "pointer",
                }}
              >
                &lsaquo;
              </button>
              <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.4px" }}>
                {calMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
              </div>
              <button
                onClick={() => setCalMonth(new Date(calY, calM + 1, 1))}
                style={{
                  background: "none",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "5px 12px",
                  color: "var(--text-2)",
                  cursor: "pointer",
                }}
              >
                &rsaquo;
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4, marginBottom: 6 }}>
              {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                <div key={i} style={{ textAlign: "center", fontSize: 10, ...mono, color: "var(--muted-2)" }}>
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
                      background: isSel ? "var(--accent-soft)" : isToday ? "var(--surface-2)" : "none",
                      border: isSel
                        ? "1px solid var(--accent-line)"
                        : isToday
                        ? "1px solid var(--border-strong)"
                        : "1px solid transparent",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12,
                        color: isSel ? "var(--accent)" : isToday ? "var(--text)" : "var(--muted)",
                        fontWeight: isToday || isSel ? 500 : 400,
                      }}
                    >
                      {day}
                    </div>
                    {has && (
                      <div style={{ width: 4, height: 4, borderRadius: "50%", background: isSel ? "var(--accent)" : "var(--muted-2)" }} />
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
              <div style={{ color: "var(--muted)", fontSize: 12, ...mono, padding: "12px 0" }}>
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
                  <div style={{ fontSize: 11, ...mono, color: "var(--accent)" }}>{b.time}</div>
                  {b.duration && <div style={{ fontSize: 10, ...mono, color: "var(--muted)" }}>{b.duration}</div>}
                  <ImpDots imp={b.imp} />
                  {b.done && <span style={{ marginLeft: "auto", fontSize: 10, ...mono, color: "var(--green)" }}>done</span>}
                  {b.status === "skipped" && (
                    <span style={{ marginLeft: "auto", fontSize: 10, ...mono, color: "var(--muted)" }}>skipped</span>
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
                <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.5, marginTop: 2 }}>{b.desc}</div>
              </div>
            ))}

            {selectedHistory && (
              <div style={{ marginTop: 14 }}>
                <div style={{ ...sectionLabel, marginBottom: 6 }}>Activity</div>
                {selectedHistory.entries.map((e, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, padding: "5px 0", fontSize: 12, color: "var(--text-2)" }}>
                    <span style={{ color: e.type === "task" ? "var(--green)" : e.type === "habit" ? "var(--amber)" : "var(--muted)" }}>
                      &bull;
                    </span>
                    <span style={{ flex: 1 }}>{e.text}</span>
                    {e.time && <span style={{ fontSize: 10, ...mono, color: "var(--muted-2)" }}>{e.time}</span>}
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
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
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
                    background: m.role === "user" ? "var(--accent-soft)" : "var(--surface)",
                    border: m.role === "user" ? "1px solid var(--accent-line)" : "1px solid var(--border)",
                  }}
                >
                  {m.content}
                </div>
              ))}
              {chatLoading && <div style={{ fontSize: 12, color: "var(--muted)", ...mono }}>thinking...</div>}
              <div ref={chatEndRef} />
            </div>
            <div
              style={{ display: "flex", gap: 8, padding: "12px 20px 20px", borderTop: "1px solid var(--border)" }}
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
                  background: "var(--accent-soft)",
                  border: "1px solid var(--accent-line)",
                  borderRadius: 7,
                  padding: "10px 16px",
                  color: "var(--accent)",
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
                borderBottom: "1px solid var(--border)",
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
                <div style={{ color: "var(--muted)", fontSize: 12, ...mono, textAlign: "center", padding: "28px 0" }}>
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
                      borderLeft: `3px solid ${g.p === "front" ? "var(--accent)" : g.p === "maint" ? "var(--violet)" : "var(--muted)"}`,
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
                          color: "var(--muted)",
                          background: "var(--chip)",
                          padding: "3px 8px",
                          borderRadius: 99,
                          marginLeft: 8,
                          flexShrink: 0,
                        }}
                      >
                        {g.area}
                      </div>
                    </div>
                    {g.desc && <div style={{ fontSize: 12.5, color: "var(--text-2)", marginTop: 6, lineHeight: 1.6 }}>{g.desc}</div>}
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                      <div
                        style={{
                          fontSize: 11,
                          ...mono,
                          color: g.p === "front" ? "var(--accent)" : g.p === "maint" ? "var(--violet)" : "var(--muted)",
                        }}
                      >
                        {g.p === "front" ? "front burner" : g.p === "maint" ? "maintenance" : "back burner"}
                      </div>
                      {g.deadline && (
                        <div style={{ fontSize: 11, ...mono, color: "var(--muted)", marginLeft: "auto" }}>{g.deadline}</div>
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
                          color: "var(--muted)",
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
                borderBottom: "1px solid var(--border)",
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
                <div style={{ color: "var(--muted)", fontSize: 12, ...mono, padding: "12px 0" }}>no pending tasks</div>
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
                borderBottom: "1px solid var(--border)",
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
                  background: "var(--surface-2)",
                  borderRadius: 7,
                  padding: "10px 14px",
                  fontSize: 11,
                  color: "var(--muted)",
                  lineHeight: 1.6,
                  marginBottom: 14,
                  borderLeft: "3px solid var(--amber)",
                }}
              >
                These shape how Claude builds your plan. Any frequency works - daily, 3x a week, every other week.
              </div>
              {!habits.length && (
                <div style={{ color: "var(--muted)", fontSize: 12, ...mono, textAlign: "center", padding: "28px 0" }}>
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
                          color: "var(--muted)",
                          background: "var(--chip)",
                          padding: "2px 7px",
                          borderRadius: 99,
                        }}
                      >
                        {h.freq || "custom"}
                      </span>
                      {h.note && <span style={{ fontSize: 11, color: "var(--muted)", ...mono }}>{h.note}</span>}
                    </div>
                    <div style={{ display: "flex", gap: 3, marginTop: 7 }}>
                      {(h.week || [0, 0, 0, 0, 0, 0, 0]).map((d, i) => (
                        <div
                          key={i}
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: "50%",
                            background: i === 6 && h.tickedToday ? "var(--green)" : d ? "var(--amber)" : "var(--chip)",
                          }}
                        />
                      ))}
                    </div>
                  </div>
                  {h.streak > 0 && <div style={{ fontSize: 11, ...mono, color: "var(--amber)" }}>{h.streak}d</div>}
                  <div
                    onClick={() => tickHabit(h.id)}
                    style={{
                      width: 28,
                      height: 28,
                      border: `1.5px solid ${h.tickedToday ? "var(--green)" : "var(--border-strong)"}`,
                      borderRadius: 8,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: h.tickedToday ? "rgba(31,158,106,0.12)" : "none",
                      color: "var(--green)",
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
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 12 }}
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
              <div style={{ color: "var(--muted)", fontSize: 12, ...mono, textAlign: "center", padding: "28px 0" }}>
                nothing parked here yet
              </div>
            )}
            {ideas.map((i) => (
              <div
                key={i.id}
                style={{ ...card, padding: "11px 15px", marginBottom: 7, display: "flex", alignItems: "center", gap: 10 }}
              >
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--violet)", opacity: 0.8, flexShrink: 0 }} />
                <div style={{ flex: 1, fontSize: 13, color: "var(--text-2)" }}>{i.t}</div>
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
                    border: "1px solid var(--accent-line)",
                    background: "none",
                    color: "var(--violet)",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  &rarr; goal
                </button>
                <button
                  onClick={() => setIdeas((prev) => prev.filter((x) => x.id !== i.id))}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 12 }}
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
              <div style={{ color: "var(--muted)", fontSize: 12, ...mono, textAlign: "center", padding: "28px 0" }}>
                no history yet
              </div>
            )}
            {history.map((day, di) => (
              <div key={di} style={{ marginBottom: 22 }}>
                <div style={{ ...sectionLabel, marginBottom: 9 }}>{day.date}</div>
                {day.entries.map((e, ei) => {
                  const color =
                    e.type === "task"
                      ? "var(--accent)"
                      : e.type === "habit"
                      ? "var(--amber)"
                      : e.type === "reschedule"
                      ? "var(--amber)"
                      : "var(--muted)";
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
                      <div style={{ flex: 1, fontSize: 12.5, color: "var(--text-2)" }}>{e.text}</div>
                      {e.time && <div style={{ fontSize: 10, ...mono, color: "var(--muted)" }}>{e.time}</div>}
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
                    border: `1px solid ${goalModal.p === val ? "var(--accent)" : "var(--border)"}`,
                    borderRadius: 7,
                    background: goalModal.p === val ? "var(--accent-soft)" : "none",
                    color: goalModal.p === val ? "var(--accent)" : "var(--muted)",
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
                    border: `1px solid ${taskModal.imp === val ? "var(--accent)" : "var(--border)"}`,
                    borderRadius: 7,
                    background: taskModal.imp === val ? "var(--accent-soft)" : "none",
                    color: taskModal.imp === val ? "var(--accent)" : "var(--muted)",
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
          <div style={{ fontSize: 11, color: "var(--muted)", ...mono, marginTop: 4 }}>
            Claude remembers this and adjusts future plans.
          </div>
          <ModalActions onCancel={() => setRescheduleId(null)} onSave={confirmReschedule} saveLabel="Got it" />
        </Modal>
      )}
    </div>
  );
}


function PlanBlock({ block, cat, tint, onToggle, onSkip, onReschedule, onStart, skipCount }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [skipInput, setSkipInput] = useState("");
  const [showSkip, setShowSkip] = useState(false);
  const skipped = block.status === "skipped";
  const moved = block.status === "rescheduled";
  const dim = block.done || skipped;
  const c = cat || { label: "Focus", icon: "dot", color: "var(--accent)" };
  const shade = tint || ((x) => x);

  const badges = [];
  if (skipped) badges.push({ text: "skipped" + (block.skipReason ? " · " + block.skipReason : ""), color: "var(--muted)" });
  if (moved && !block.done) badges.push({ text: "moved" + (block.newTime ? " → " + block.newTime : ""), color: "var(--amber)" });
  if (skipCount >= 2 && !block.done && !skipped) badges.push({ text: "skipped " + skipCount + "x recently", color: "var(--red)" });

  return (
    <div className="row" style={{ opacity: dim ? 0.5 : 1 }}>
      <div className="row-time">{block.time}</div>
      <span className="row-dot" style={{ background: c.color }} />
      <div className="row-icon" style={{ background: shade(c.color, 12), color: c.color }}>
        <Icon name={c.icon} size={15} />
      </div>

      <div className="row-main">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="row-title" style={{ textDecoration: dim ? "line-through" : "none" }}>
            {block.title}
          </div>
          {block.imp >= 3 && !dim && (
            <span className="pill" style={{ background: "var(--chip)", color: "var(--red)" }}>
              high
            </span>
          )}
        </div>
        {block.desc && <div className="row-desc">{block.desc}</div>}

        <div className="row-meta">
          <span>{block.time}</span>
          {block.duration && <span>· {block.duration}</span>}
          <span className="pill" style={{ background: shade(c.color, 12), color: c.color }}>
            {c.label}
          </span>
        </div>

        {badges.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
            {badges.map((b) => (
              <span key={b.text} className="pill" style={{ background: "var(--chip)", color: b.color }}>
                {b.text}
              </span>
            ))}
          </div>
        )}

        {showSkip && (
          <div style={{ display: "flex", gap: 6, marginTop: 9 }}>
            <input
              value={skipInput}
              onChange={(e) => setSkipInput(e.target.value)}
              placeholder="What came up? (optional)"
              style={{ flex: 1 }}
            />
            <button
              className="btn"
              onClick={() => {
                onSkip(block.id, skipInput.trim());
                setShowSkip(false);
              }}
            >
              Skip
            </button>
          </div>
        )}
      </div>

      <span className="pill row-cat" style={{ background: shade(c.color, 12), color: c.color }}>
        {c.label}
      </span>

      <div className="row-dur">{block.duration}</div>

      <div style={{ position: "relative", flexShrink: 0 }}>
        <button
          className="icon-btn"
          style={{ width: 24, height: 24, fontSize: 14, opacity: dim ? 0 : 1, pointerEvents: dim ? "none" : "auto" }}
          onClick={() => setMenuOpen((o) => !o)}
        >
          &hellip;
        </button>
        {menuOpen && (
          <div
            style={{
              position: "absolute",
              right: 0,
              top: 28,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              boxShadow: "var(--shadow-md)",
              zIndex: 50,
              minWidth: 130,
              overflow: "hidden",
            }}
          >
            {[
              ["Skip", () => setShowSkip(true)],
              ["Move", () => onReschedule(block.id)],
            ].map(([label, fn]) => (
              <button
                key={label}
                onClick={() => {
                  fn();
                  setMenuOpen(false);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "9px 13px",
                  fontSize: 12.5,
                  fontFamily: "inherit",
                  color: "var(--text-2)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        className={"check" + (block.done ? " on" : "")}
        disabled={skipped}
        onClick={() => {
          if (skipped) return;
          onStart(block.id);
          onToggle(block.id);
        }}
      >
        {block.done && <span className="tick" />}
      </button>
    </div>
  );
}

function TaskCard({ task, onToggle, onEdit, onDelete }) {
  return (
    <div
      className="card"
      onClick={() => onEdit(task)}
      style={{
        padding: "13px 15px",
        marginBottom: 8,
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        opacity: task.done ? 0.5 : 1,
        cursor: "pointer",
      }}
    >
      <button
        className={"check" + (task.done ? " on" : "")}
        style={{ marginTop: 1 }}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(task.id);
        }}
      >
        {task.done && <span className="tick" />}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 550, textDecoration: task.done ? "line-through" : "none" }}>
          {task.name}
        </div>
        {(task.due || task.goal) && (
          <div style={{ display: "flex", gap: 8, marginTop: 5, flexWrap: "wrap" }}>
            {task.due && (
              <span className="pill" style={{ background: "var(--chip)", color: "var(--muted)" }}>
                Due {task.due}
              </span>
            )}
            {task.goal && (
              <span className="pill" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                {task.goal}
              </span>
            )}
          </div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <ImpDots imp={task.imp || 1} />
        <button
          className="icon-btn"
          style={{ width: 24, height: 24, fontSize: 14 }}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(task.id);
          }}
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
        background: "rgba(16,18,26,0.42)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
        padding: "0 16px",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          boxShadow: "var(--shadow-md)",
          padding: 24,
          width: "100%",
          maxWidth: 430,
          maxHeight: "85vh",
          overflowY: "auto",
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.3px", marginBottom: 18 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: "var(--muted)",
          marginBottom: 6,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
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
    <div style={{ display: "flex", gap: 8, marginTop: 22 }}>
      <button className="btn" onClick={onCancel} style={{ padding: "10px 16px" }}>
        Cancel
      </button>
      <button className="btn btn-primary" onClick={onSave} style={{ flex: 1, justifyContent: "center", padding: "10px 16px" }}>
        {saveLabel}
      </button>
    </div>
  );
}

const ICONS = {
  home: '<path d="M3 10.2 12 3l9 7.2V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1.2"/>',
  bulb: '<path d="M9.5 18.5h5M10.5 21h3M12 3a6 6 0 0 0-3.4 10.9c.5.4.9 1.1.9 1.8v.3h5v-.3c0-.7.4-1.4.9-1.8A6 6 0 0 0 12 3z"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.2 5.2-5.2 2.2 2.2-5.2z"/>',
  check: '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="m8 12.2 2.8 2.8L16.2 9"/>',
  repeat: '<path d="M16.5 2.5 20 6l-3.5 3.5M20 6H7.5A3.5 3.5 0 0 0 4 9.5V11M7.5 21.5 4 18l3.5-3.5M4 18h12.5a3.5 3.5 0 0 0 3.5-3.5V13"/>',
  chat: '<path d="M20.5 12a7.5 7.5 0 0 1-11 6.6L4 20.5l1.9-5.4A7.5 7.5 0 1 1 20.5 12z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6.8V12l3.4 2"/>',
  gear: '<path d="M4 6h9M17.5 6h2.5M4 12h4.5M13 12h7M4 18h9M17.5 18h2.5"/><circle cx="15" cy="6" r="2.2"/><circle cx="10.5" cy="12" r="2.2"/><circle cx="15" cy="18" r="2.2"/>',
  book: '<path d="M4.5 4.8A1.8 1.8 0 0 1 6.3 3H19v18H6.3a1.8 1.8 0 0 1-1.8-1.8z"/><path d="M4.5 16.8H19"/>',
  briefcase: '<rect x="2.5" y="7" width="19" height="13" rx="2.5"/><path d="M8.5 7V5.2A2.2 2.2 0 0 1 10.7 3h2.6a2.2 2.2 0 0 1 2.2 2.2V7M2.5 12.5h19"/>',
  dumbbell: '<path d="M6.8 6.5v11M3.5 9.2v5.6M17.2 6.5v11M20.5 9.2v5.6M6.8 12h10.4"/>',
  rocket: '<path d="M12 2.6c3.4 2.5 5 6 5 9.4l-2.5 3.5h-5L7 12c0-3.4 1.6-6.9 5-9.4z"/><path d="M9.5 15.5 7.8 20l2.7-1.5M14.5 15.5 16.2 20l-2.7-1.5"/><circle cx="12" cy="9.8" r="1.7"/>',
  cup: '<path d="M4 5.5h12V12a6 6 0 0 1-12 0z"/><path d="M16 7.5h2.2a2.5 2.5 0 0 1 0 5H16M3.5 20.5h13"/>',
  folder: '<path d="M3 6.6A1.6 1.6 0 0 1 4.6 5h4L11 7.6h8.4A1.6 1.6 0 0 1 21 9.2v9.2a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 18.4z"/>',
  star: '<path d="m12 3.2 2.6 5.5 6 .9-4.3 4.2 1 6-5.3-2.8-5.3 2.8 1-6L3.4 9.6l6-.9z"/>',
  dot: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/>',
  sparkle: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.4v2.1M12 19.5v2.1M4.6 4.6l1.5 1.5M17.9 17.9l1.5 1.5M2.4 12h2.1M19.5 12h2.1M4.6 19.4l1.5-1.5M17.9 6.1l1.5-1.5"/>',
  moon: '<path d="M20.2 14.6A8.6 8.6 0 0 1 9.4 3.8a8.6 8.6 0 1 0 10.8 10.8z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  refresh: '<path d="M20 11.4A8 8 0 1 0 19.2 16"/><path d="M20.4 5.2v6.2h-6.2"/>',
};

function Icon({ name, size = 18, style }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, display: "block", ...style }}
      dangerouslySetInnerHTML={{ __html: ICONS[name] || ICONS.dot }}
    />
  );
}

function SignIn({ theme }) {
  const [mode, setMode] = useState("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const creds = { email: email.trim(), password };
    const { data, error: err } =
      mode === "in"
        ? await supabase.auth.signInWithPassword(creds)
        : await supabase.auth.signUp(creds);
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    // Sign-up with email confirmation on returns a user but no session.
    if (mode === "up" && !data.session) {
      setNotice("Check your email to confirm the account, then sign in.");
      setMode("in");
    }
  };

  return (
    <div
      className={"app" + (theme === "dark" ? " dark" : "")}
      style={{ alignItems: "center", justifyContent: "center", padding: 20 }}
    >
      <form onSubmit={submit} className="card" style={{ width: "100%", maxWidth: 360, padding: 26 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 6 }}>
          <div style={{ width: 22, height: 22, borderRadius: "50%", border: "3.5px solid var(--text)" }} />
          <div style={{ fontSize: 15, fontWeight: 750, letterSpacing: "0.16em" }}>LOCUS</div>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 20, lineHeight: 1.6 }}>
          {mode === "in" ? "Sign in and your plan follows you between devices." : "Create the account your data lives under."}
        </div>

        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "in" ? "current-password" : "new-password"}
            minLength={6}
            required
          />
        </Field>

        {error && <div style={{ fontSize: 12, color: "var(--red)", marginBottom: 10, lineHeight: 1.5 }}>{error}</div>}
        {notice && <div style={{ fontSize: 12, color: "var(--accent)", marginBottom: 10, lineHeight: 1.5 }}>{notice}</div>}

        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy}
          style={{ width: "100%", justifyContent: "center", padding: "11px 16px", marginTop: 4 }}
        >
          {busy ? "..." : mode === "in" ? "Sign in" : "Create account"}
        </button>

        <button
          type="button"
          className="link-btn"
          style={{ marginTop: 16, width: "100%", textAlign: "center" }}
          onClick={() => {
            setMode((m) => (m === "in" ? "up" : "in"));
            setError("");
          }}
        >
          {mode === "in" ? "Need an account? Create one" : "Already have an account? Sign in"}
        </button>

        {/* Demo mode is decided from the URL at load, so this has to be a real
            navigation rather than a state change. */}
        <div style={{ borderTop: "1px solid var(--border)", marginTop: 18, paddingTop: 16 }}>
          <a
            href="/?demo"
            className="btn"
            style={{ width: "100%", justifyContent: "center", padding: "10px 16px", textDecoration: "none" }}
          >
            Explore the demo
          </a>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 9, textAlign: "center", lineHeight: 1.55 }}>
            No account needed &mdash; a sample week of real planning, nothing saved
          </div>
        </div>
      </form>
    </div>
  );
}
