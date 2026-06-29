import { useState, useEffect, useRef } from "react";
import "./App.css";

const STORAGE_KEYS = {
  goals: "locus-goals",
  tasks: "locus-tasks",
  habits: "locus-habits",
  ideas: "locus-ideas",
  todayPlan: "locus-today-plan",
  tomorrowPlan: "locus-tomorrow-plan",
  history: "locus-history",
  skipPatterns: "locus-skip-patterns",
  journal: "locus-journal",
  timestamps: "locus-timestamps",
  context: "locus-context",
};

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}

function save(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

async function callClaude(system, messages, useWebSearch = false) {
  const res = await fetch("/.netlify/functions/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, messages, useWebSearch }),
  });
  const data = await res.json();
  return data.content?.[0]?.text || "Something went wrong.";
}

function buildContext(goals, tasks, habits, ideas, skipPatterns, journal, timestamps, context) {
  const ord = ["front", "maint", "back"];
  const sorted = [...goals].sort((a, b) => ord.indexOf(a.p) - ord.indexOf(b.p));
  const fp = sorted.filter((g) => g.p === "front");
  const mp = sorted.filter((g) => g.p === "maint");
  const bp = sorted.filter((g) => g.p === "back");
  const fg = (arr) => arr.length ? arr.map((g) => `- [id:${g.id}] ${g.name} (${g.area})${g.deadline ? ", by " + g.deadline : ""}${g.desc ? ": " + g.desc : ""}`).join("\n") : "None";
  const pt = tasks.filter((t) => !t.done);
  const ft = pt.length ? pt.map((t) => `- [id:${t.id}] ${t.name}${t.due ? ", due " + t.due : ""}${t.goal ? " [goal: " + t.goal + "]" : ""}${t.imp ? " [importance: " + t.imp + "/3]" : ""}`).join("\n") : "None";
  const patterns = Object.entries(skipPatterns).filter(([, c]) => c >= 2).map(([k, c]) => `- "${k}" skipped ${c}x`).join("\n") || "None";
  const habitCtx = habits.map((h) => `- [id:${h.id}] ${h.name} (${h.freq})${h.note ? ": " + h.note : ""}, streak: ${h.streak} days`).join("\n") || "None";
  const recentJournal = journal.slice(0, 5).map((j) => `- ${j.date}: ${j.text}`).join("\n") || "None";
  const tsCtx = Object.entries(timestamps).slice(0, 10).map(([k, v]) => `- ${k}: avg ${v.avg} min, ${v.count} completions`).join("\n") || "None";
  const ctxNotes = context.slice(0, 3).map((c) => `- ${c.date}: ${c.text}`).join("\n") || "None";
  return `USER CONTEXT:

LONG-TERM GOALS:
Front burner:
${fg(fp)}
Maintenance:
${fg(mp)}
Back burner:
${fg(bp)}

PENDING TASKS:
${ft}

HABITS:
${habitCtx}

SKIP PATTERNS:
${patterns}

COMPLETION TIME DATA:
${tsCtx}

RECENT JOURNAL ENTRIES:
${recentJournal}

LIFE CONTEXT NOTES:
${ctxNotes}

IDEAS PARKING LOT:
${ideas.map((i) => `- [id:${i.id}] ${i.t}`).join("\n") || "None"}`;
}

const IMP_COLORS = ["", "#706d68", "#8eaefb", "#f28b82"];

function ImpDots({ imp, size = 7 }) {
  return (
    <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
      {[1, 2, 3].map((i) => (
        <div key={i} style={{ width: size, height: size, borderRadius: "50%", background: i <= imp ? IMP_COLORS[imp] : "#32323e" }} />
      ))}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("today");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [goals, setGoals] = useState(() => load(STORAGE_KEYS.goals, []));
  const [tasks, setTasks] = useState(() => load(STORAGE_KEYS.tasks, []));
  const [habits, setHabits] = useState(() => load(STORAGE_KEYS.habits, []));
  const [ideas, setIdeas] = useState(() => load(STORAGE_KEYS.ideas, []));
  const [todayPlan, setTodayPlan] = useState(() => load(STORAGE_KEYS.todayPlan, []));
  const [tomorrowPlan, setTomorrowPlan] = useState(() => load(STORAGE_KEYS.tomorrowPlan, []));
  const [tomorrowSuggestions, setTomorrowSuggestions] = useState([]);
  const [selectedSuggestions, setSelectedSuggestions] = useState([]);
  const [history, setHistory] = useState(() => load(STORAGE_KEYS.history, []));
  const [skipPatterns, setSkipPatterns] = useState(() => load(STORAGE_KEYS.skipPatterns, {}));
  const [journal, setJournal] = useState(() => load(STORAGE_KEYS.journal, []));
  const [timestamps, setTimestamps] = useState(() => load(STORAGE_KEYS.timestamps, {}));
  const [context, setContext] = useState(() => load(STORAGE_KEYS.context, []));
  const [chatHistory, setChatHistory] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [tomorrowChatHistory, setTomorrowChatHistory] = useState([]);
  const [tomorrowChatInput, setTomorrowChatInput] = useState("");
  const [tomorrowChatLoading, setTomorrowChatLoading] = useState(false);
  const [planLoading, setPlanLoading] = useState(false);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [goalModal, setGoalModal] = useState(null);
  const [taskModal, setTaskModal] = useState(null);
  const [habitModal, setHabitModal] = useState(null);
  const [rescheduleModal, setRescheduleModal] = useState(null);
  const [rescheduleReason, setRescheduleReason] = useState("");
  const [rescheduleTime, setRescheduleTime] = useState("");
  const [ideaInput, setIdeaInput] = useState("");
  const [journalInput, setJournalInput] = useState("");
  const [toasts, setToasts] = useState([]);
  const chatBottomRef = useRef(null);
  const tomorrowChatBottomRef = useRef(null);

  useEffect(() => { save(STORAGE_KEYS.goals, goals); }, [goals]);
  useEffect(() => { save(STORAGE_KEYS.tasks, tasks); }, [tasks]);
  useEffect(() => { save(STORAGE_KEYS.habits, habits); }, [habits]);
  useEffect(() => { save(STORAGE_KEYS.ideas, ideas); }, [ideas]);
  useEffect(() => { save(STORAGE_KEYS.todayPlan, todayPlan); }, [todayPlan]);
  useEffect(() => { save(STORAGE_KEYS.tomorrowPlan, tomorrowPlan); }, [tomorrowPlan]);
  useEffect(() => { save(STORAGE_KEYS.history, history); }, [history]);
  useEffect(() => { save(STORAGE_KEYS.skipPatterns, skipPatterns); }, [skipPatterns]);
  useEffect(() => { save(STORAGE_KEYS.journal, journal); }, [journal]);
  useEffect(() => { save(STORAGE_KEYS.timestamps, timestamps); }, [timestamps]);
  useEffect(() => { save(STORAGE_KEYS.context, context); }, [context]);
  useEffect(() => { chatBottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatHistory, chatLoading]);
  useEffect(() => { tomorrowChatBottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [tomorrowChatHistory, tomorrowChatLoading]);

  const addToast = (msg) => {
    const id = Date.now();
    setToasts((p) => [...p, { id, msg }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 3000);
  };

  const addHistory = (type, text) => {
    const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    setHistory((prev) => {
      const next = [...prev];
      if (!next.length || next[0].date !== today) next.unshift({ date: today, entries: [] });
      next[0].entries.unshift({ type, text, time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) });
      return next;
    });
  };

  const logTimestamp = (blockTitle, startTime) => {
    if (!startTime) return;
    const duration = Math.round((Date.now() - startTime) / 60000);
    if (duration < 1 || duration > 480) return;
    setTimestamps((prev) => {
      const existing = prev[blockTitle] || { avg: 0, count: 0 };
      const newAvg = Math.round((existing.avg * existing.count + duration) / (existing.count + 1));
      return { ...prev, [blockTitle]: { avg: newAvg, count: existing.count + 1 } };
    });
  };

  const applyActions = (actions, g, t, h, i) => {
    let gs = [...g], ts = [...t], hs = [...h], is = [...i];
    let needsPlan = false, needsTomorrowPlan = false;

    for (const action of actions) {
      switch (action.type) {
        case "add_goal": {
          const ng = { id: Date.now().toString() + Math.random(), name: action.name, area: action.area || "Other", desc: action.desc || "", deadline: action.deadline || "", p: action.priority || "maint" };
          gs = [...gs, ng];
          addToast(`Added goal: ${ng.name}`);
          break;
        }
        case "edit_goal":
          gs = gs.map((x) => x.id === action.id ? { ...x, ...action.updates } : x);
          addToast("Updated goal");
          break;
        case "delete_goal":
          gs = gs.filter((x) => x.id !== action.id);
          addToast("Deleted goal");
          break;
        case "set_goal_priority":
          gs = gs.map((x) => x.name.toLowerCase().includes((action.name || "").toLowerCase()) ? { ...x, p: action.priority } : x);
          addToast("Updated priority");
          break;
        case "promote_idea": {
          const idea = is.find((x) => x.id === action.id || x.t.toLowerCase().includes((action.text || "").toLowerCase()));
          if (idea) {
            gs = [...gs, { id: Date.now().toString(), name: idea.t, area: action.area || "Other", desc: "", deadline: "", p: action.priority || "back" }];
            is = is.filter((x) => x.id !== idea.id);
            addToast(`Promoted idea to goal: ${idea.t}`);
          }
          break;
        }
        case "add_task": {
          const nt = { id: Date.now().toString() + Math.random(), name: action.name, due: action.due || "", goal: action.goal || "", desc: action.desc || "", imp: action.importance || 2, done: false };
          ts = [...ts, nt];
          addToast(`Added task: ${nt.name}`);
          break;
        }
        case "complete_task":
          ts = ts.map((x) => {
            const match = action.id ? x.id === action.id : x.name.toLowerCase().includes((action.name || "").toLowerCase());
            if (match && !x.done) addHistory("task", `Completed: ${x.name}`);
            return match ? { ...x, done: true } : x;
          });
          addToast("Task completed");
          break;
        case "uncomplete_task":
          ts = ts.map((x) => {
            const match = action.id ? x.id === action.id : x.name.toLowerCase().includes((action.name || "").toLowerCase());
            return match ? { ...x, done: false } : x;
          });
          addToast("Task reopened");
          break;
        case "delete_task":
          ts = ts.filter((x) => x.id !== action.id && !x.name.toLowerCase().includes((action.name || "").toLowerCase()));
          addToast("Deleted task");
          break;
        case "add_habit": {
          const nh = { id: Date.now().toString() + Math.random(), name: action.name, freq: action.freq || "daily", note: action.note || "", streak: 0, history: [0,0,0,0,0,0,0], tickedToday: false };
          hs = [...hs, nh];
          addToast(`Added habit: ${nh.name}`);
          break;
        }
        case "tick_habit":
          hs = hs.map((x) => {
            const match = action.id ? x.id === action.id : x.name.toLowerCase().includes((action.name || "").toLowerCase());
            if (!match) return x;
            const ticked = action.value !== undefined ? action.value : true;
            if (ticked) addHistory("habit", `Habit done: ${x.name}`);
            return { ...x, tickedToday: ticked, streak: ticked ? x.streak + 1 : Math.max(0, x.streak - 1), history: [...(x.history || [0,0,0,0,0,0,0]).slice(1), ticked ? 1 : 0] };
          });
          addToast("Habit updated");
          break;
        case "delete_habit":
          hs = hs.filter((x) => x.id !== action.id && !x.name.toLowerCase().includes((action.name || "").toLowerCase()));
          addToast("Deleted habit");
          break;
        case "add_idea": {
          const ni = { id: Date.now().toString() + Math.random(), t: action.text };
          is = [...is, ni];
          addToast("Added idea");
          break;
        }
        case "delete_idea":
          is = is.filter((x) => x.id !== action.id && !x.t.toLowerCase().includes((action.text || "").toLowerCase()));
          addToast("Deleted idea");
          break;
        case "add_context": {
          const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
          setContext((prev) => [{ date: today, text: action.text }, ...prev.slice(0, 9)]);
          addToast("Context noted");
          break;
        }
        case "generate_plan":
          needsPlan = true;
          break;
        case "generate_tomorrow_plan":
          needsTomorrowPlan = true;
          break;
        case "clear_completed_tasks":
          ts = ts.filter((x) => !x.done);
          addToast("Cleared completed tasks");
          break;
        default: break;
      }
    }
    return { gs, ts, hs, is, needsPlan, needsTomorrowPlan };
  };

  const generateTodayPlan = async (g, t, h, i, sp) => {
    setPlanLoading(true);
    const ctx = buildContext(g || goals, t || tasks, h || habits, i || ideas, sp || skipPatterns, journal, timestamps, context);
    try {
      const text = await callClaude(
        `You are a personal day planner for Locus. ${ctx}

Generate a realistic flexible day plan. Rules:
- NO rigid times unless the user specified something at a specific time (like "meeting at 3pm")
- Instead use approximate durations: (~1 hr), (~90 min), (~30 min)
- Order blocks by when they should happen (morning/afternoon/evening)
- Front burner goals get the most time
- Habits are constraints — factor them in but don't list them as blocks unless they need dedicated time
- Include 1-2 flex blocks for buffer
- Use completion time data to estimate realistic durations
- Avoid blocks matching skip patterns — restructure timing
- Respond ONLY with a JSON array, no markdown. Format: [{"time":"Morning","title":"Block title","desc":"Description. Be specific and actionable.","imp":3,"duration":"~90 min"}]
- imp is 1-3. duration is a string like "~1 hr" or "~45 min"`,
        [{ role: "user", content: "Build my plan for today." }]
      );
      const clean = text.replace(/```json|```/g, "").trim();
      const blocks = JSON.parse(clean).map((b, idx) => ({ ...b, id: "b" + idx, done: false, status: "pending", startTime: null }));
      setTodayPlan(blocks);
      addToast("Today's plan generated");
    } catch (e) {
      addToast("Error generating plan");
    }
    setPlanLoading(false);
  };

  const generateTomorrowPlanFromChat = async (extraInstructions, g, t, h) => {
    setPlanLoading(true);
    const ctx = buildContext(g || goals, t || tasks, h || habits, ideas, skipPatterns, journal, timestamps, context);
    const selected = selectedSuggestions.join(", ");
    try {
      const text = await callClaude(
        `You are planning tomorrow for the user. ${ctx}

Selected suggestions for tomorrow: ${selected || "none specified"}
Additional instructions: ${extraInstructions || "none"}

Generate a realistic flexible plan for tomorrow. Rules:
- NO rigid times unless specified
- Use approximate durations: (~1 hr), (~90 min), (~30 min)  
- Order by when things should happen
- Factor in selected suggestions and additional instructions
- Habits auto-apply, don't list unless needing dedicated time
- Include 1-2 flex blocks
- Be specific and actionable in descriptions
- Respond ONLY with JSON array. Format: [{"time":"Morning","title":"Block title","desc":"Description","imp":3,"duration":"~90 min"}]`,
        [{ role: "user", content: "Build my plan for tomorrow." }]
      );
      const clean = text.replace(/```json|```/g, "").trim();
      const blocks = JSON.parse(clean).map((b, idx) => ({ ...b, id: "t" + idx, done: false, status: "pending", startTime: null }));
      setTomorrowPlan(blocks);
      addToast("Tomorrow's plan generated");
    } catch (e) {
      addToast("Error generating tomorrow's plan");
    }
    setPlanLoading(false);
  };

  const loadTomorrowSuggestions = async () => {
    setSuggestionsLoading(true);
    const ctx = buildContext(goals, tasks, habits, ideas, skipPatterns, journal, timestamps, context);
    try {
      const text = await callClaude(
        `You are suggesting what to do tomorrow for the user. ${ctx}

Generate 6-8 suggestions for tomorrow. Mix of:
- Goal-related blocks (front burner first)
- Pending tasks that need attention
- Social/recovery if neglected
- Anything time-sensitive

Each suggestion should be a short actionable card. Respond ONLY with JSON array:
[{"title":"...","desc":"...","type":"goal|task|habit|social|recovery|other","imp":1|2|3}]`,
        [{ role: "user", content: "What should I do tomorrow?" }]
      );
      const clean = text.replace(/```json|```/g, "").trim();
      const sugs = JSON.parse(clean);
      setTomorrowSuggestions(sugs);
    } catch (e) {
      addToast("Error loading suggestions");
    }
    setSuggestionsLoading(false);
  };

  const loadSuggestions = async () => {
    setSuggestionsLoading(true);
    const ctx = buildContext(goals, tasks, habits, ideas, skipPatterns, journal, timestamps, context);
    try {
      const text = await callClaude(
        `You are a life coach and planner who knows this person deeply. ${ctx}

Analyze everything and generate 6-8 suggestions. Mix of:
- Pattern observations ("you keep skipping X, here's why it might be happening")
- Opportunities ("there might be a good networking event or resource for your SE goal")
- Long term ideas ("based on your interests, you might want to explore X")
- Blind spots ("your social goal hasn't appeared in your plan in a week")
- Actionable next steps for their most important goals

Search the web if relevant for opportunities, events, or resources.
Respond ONLY with JSON array:
[{"title":"...","desc":"...","type":"pattern|opportunity|longterm|blindspot|action","imp":1|2|3}]`,
        [{ role: "user", content: "What should I know and consider?" }],
        true
      );
      const clean = text.replace(/```json|```/g, "").trim();
      const sugs = JSON.parse(clean);
      setSuggestions(sugs);
    } catch (e) {
      addToast("Error loading suggestions");
    }
    setSuggestionsLoading(false);
  };

  const toggleBlock = (id, planType) => {
    const setter = planType === "tomorrow" ? setTomorrowPlan : setTodayPlan;
    const plan = planType === "tomorrow" ? tomorrowPlan : todayPlan;
    const block = plan.find((b) => b.id === id);
    if (!block) return;
    if (!block.done) {
      logTimestamp(block.title, block.startTime);
      addHistory("task", `Completed: ${block.title}`);
    }
    setter((prev) => prev.map((b) => b.id === id ? { ...b, done: !b.done, startTime: b.done ? Date.now() : b.startTime } : b));
    if (navigator.vibrate) navigator.vibrate([12, 8, 20]);
  };

  const startBlock = (id) => {
    setTodayPlan((prev) => prev.map((b) => b.id === id ? { ...b, startTime: b.startTime || Date.now() } : b));
  };

  const skipBlock = (id, reason) => {
    setTodayPlan((prev) => prev.map((b) => {
      if (b.id !== id) return b;
      setSkipPatterns((sp) => ({ ...sp, [b.title]: (sp[b.title] || 0) + 1 }));
      addHistory("skip", `Skipped: ${b.title}${reason ? " — " + reason : ""}`);
      if (reason) {
        setContext((prev2) => [{ date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }), text: `Skipped ${b.title}: ${reason}` }, ...prev2.slice(0, 9)]);
      }
      return { ...b, status: "skipped", skipReason: reason };
    }));
  };

  const confirmReschedule = () => {
    setTodayPlan((prev) => prev.map((b) => {
      if (b.id !== rescheduleModal) return b;
      setSkipPatterns((sp) => ({ ...sp, [b.title]: (sp[b.title] || 0) + 1 }));
      addHistory("reschedule", `Rescheduled: ${b.title}${rescheduleTime ? " → " + rescheduleTime : ""}${rescheduleReason ? " (" + rescheduleReason + ")" : ""}`);
      if (rescheduleReason) {
        setContext((prev2) => [{ date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }), text: `Rescheduled ${b.title}: ${rescheduleReason}` }, ...prev2.slice(0, 9)]);
      }
      return { ...b, status: "rescheduled", newTime: rescheduleTime, conflict: rescheduleReason };
    }));
    setRescheduleModal(null);
    setRescheduleReason("");
    setRescheduleTime("");
  };

  const saveJournal = () => {
    if (!journalInput.trim()) return;
    const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    setJournal((prev) => {
      const next = [...prev];
      const existing = next.findIndex((j) => j.date === today);
      if (existing >= 0) next[existing] = { ...next[existing], text: journalInput.trim(), updatedAt: Date.now() };
      else next.unshift({ date: today, text: journalInput.trim(), createdAt: Date.now() });
      return next;
    });
    setJournalInput("");
    addToast("Journal entry saved");
  };

  const sendChat = async () => {
    if (!chatInput.trim() || chatLoading) return;
    const userMsg = chatInput.trim();
    setChatInput("");
    setChatHistory((prev) => [...prev, { role: "user", content: userMsg }]);
    setChatLoading(true);
    const ctx = buildContext(goals, tasks, habits, ideas, skipPatterns, journal, timestamps, context);

    const needsSearch = /search|find|look up|what's happening|events|news|current|latest|near me|festival|concert|restaurant/i.test(userMsg);

    try {
      const reply = await callClaude(
        `You are Locus, a personal life planner assistant. You have full ability to modify the user's data directly and search the web when relevant.

${ctx}

You can perform MULTIPLE actions in one response. After your message, include a JSON array of actions on the very last line.

AVAILABLE ACTIONS:
{"type":"add_goal","name":"...","area":"Fitness|Career|Learning|Social|Finance|Health|Creative|Other","desc":"...","deadline":"...","priority":"front|maint|back"}
{"type":"edit_goal","id":"...","updates":{"name":"...","p":"...","desc":"...","deadline":"..."}}
{"type":"delete_goal","id":"..."}
{"type":"set_goal_priority","name":"...","priority":"front|maint|back"}
{"type":"promote_idea","id":"...","area":"...","priority":"front|maint|back"}
{"type":"add_task","name":"...","due":"...","goal":"...","importance":1|2|3}
{"type":"complete_task","name":"..."}
{"type":"uncomplete_task","name":"..."}
{"type":"delete_task","name":"..."}
{"type":"add_habit","name":"...","freq":"any frequency as text","note":"..."}
{"type":"tick_habit","name":"...","value":true|false}
{"type":"delete_habit","name":"..."}
{"type":"add_idea","text":"..."}
{"type":"delete_idea","text":"..."}
{"type":"add_context","text":"..."}
{"type":"generate_plan"}
{"type":"generate_tomorrow_plan"}
{"type":"clear_completed_tasks"}

FORMAT: Write your response, then on the very last line put the actions array if needed.
Example:
Done! Added the goal and noted your context.
[{"type":"add_goal","name":"Learn guitar","area":"Learning","priority":"back"},{"type":"add_context","text":"User wants to learn guitar, mentioned as social/creative outlet"}]

If someone brain dumps stress or life context, use add_context to remember it and factor it into future plans.
Be conversational and direct. Reference their actual data. Always confirm what you did.`,
        [...chatHistory, { role: "user", content: userMsg }],
        needsSearch
      );

      let message = reply;
      let actions = [];

      const lines = reply.trim().split("\n");
      const lastLine = lines[lines.length - 1].trim();
      if (lastLine.startsWith("[")) {
        try {
          actions = JSON.parse(lastLine);
          message = lines.slice(0, -1).join("\n").trim();
        } catch (e) {}
      }

      if (actions.length > 0) {
        const { gs, ts, hs, is, needsPlan, needsTomorrowPlan } = applyActions(actions, goals, tasks, habits, ideas);
        setGoals(gs);
        setTasks(ts);
        setHabits(hs);
        setIdeas(is);
        if (needsPlan) await generateTodayPlan(gs, ts, hs, is, skipPatterns);
        if (needsTomorrowPlan) await generateTomorrowPlanFromChat("", gs, ts, hs);
      }

      setChatHistory((prev) => [...prev, { role: "assistant", content: message }]);
    } catch {
      setChatHistory((prev) => [...prev, { role: "assistant", content: "Error connecting. Try again." }]);
    }
    setChatLoading(false);
  };

  const sendTomorrowChat = async () => {
    if (!tomorrowChatInput.trim() || tomorrowChatLoading) return;
    const userMsg = tomorrowChatInput.trim();
    setTomorrowChatInput("");
    setTomorrowChatHistory((prev) => [...prev, { role: "user", content: userMsg }]);
    setTomorrowChatLoading(true);

    const wantsGenerate = /generate|build|make|create|plan|schedule/i.test(userMsg);

    if (wantsGenerate || tomorrowChatHistory.length > 2) {
      await generateTomorrowPlanFromChat(
        [...tomorrowChatHistory.map(m => m.content), userMsg].join(". "),
        goals, tasks, habits
      );
      setTomorrowChatHistory((prev) => [...prev, { role: "assistant", content: "Generated your plan for tomorrow based on your selected suggestions and what you told me. Check the plan above — tap any block to adjust." }]);
    } else {
      setTomorrowChatHistory((prev) => [...prev, { role: "assistant", content: "Got it. Tell me anything else you want to include tomorrow, or say 'generate my plan' when ready." }]);
    }
    setTomorrowChatLoading(false);
  };

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const todayStr = today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const tomorrowStr = tomorrow.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  const doneTodayBlocks = todayPlan.filter((b) => b.done || b.status === "skipped");
  const pendingTodayBlocks = todayPlan.filter((b) => !b.done && b.status !== "skipped");
  const progress = todayPlan.length ? Math.round((todayPlan.filter((b) => b.done).length / todayPlan.length) * 100) : 0;

  const SUG_COLORS = { goal: "#8eaefb", task: "#f28b82", habit: "#edbe80", social: "#b8a0fc", recovery: "#81c995", other: "#706d68", pattern: "#f28b82", opportunity: "#8eaefb", longterm: "#b8a0fc", blindspot: "#f0c060", action: "#81c995" };

  const navItems = [
    { id: "today", label: "Today" },
    { id: "tomorrow", label: "Tomorrow" },
    { id: "chat", label: "Chat" },
    { id: "suggestions", label: "Suggestions" },
    { id: "journal", label: "Journal" },
    { id: "goals", label: "Goals", badge: goals.length },
    { id: "tasks", label: "Tasks", badge: tasks.filter((t) => !t.done).length },
    { id: "habits", label: "Habits", badge: habits.length },
    { id: "ideas", label: "Ideas", badge: ideas.length },
    { id: "history", label: "History" },
  ];

  const s = (obj) => obj;

  return (
    <div style={s({ display: "flex", height: "100vh", overflow: "hidden", background: "#1a1a20", color: "#f2efe9", fontFamily: "'Geist','Inter',sans-serif", fontSize: 14 })}>

      {/* TOASTS */}
      <div style={s({ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 400, display: "flex", flexDirection: "column", gap: 6, alignItems: "center", pointerEvents: "none" })}>
        {toasts.map((t) => (
          <div key={t.id} style={s({ background: "#2a2a34", border: "1px solid rgba(142,174,251,0.3)", borderRadius: 8, padding: "8px 16px", fontSize: 12, color: "#8eaefb", fontFamily: "monospace", whiteSpace: "nowrap" })}>{t.msg}</div>
        ))}
      </div>

      {sidebarOpen && <div onClick={() => setSidebarOpen(false)} style={s({ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 50 })} />}

      {/* SIDEBAR */}
      <div style={s({ position: "fixed", top: 0, left: 0, height: "100%", width: 220, background: "#22222a", borderRight: "1px solid rgba(255,255,255,0.09)", display: "flex", flexDirection: "column", zIndex: 60, transform: sidebarOpen ? "translateX(0)" : "translateX(-100%)", transition: "transform 0.22s ease" })}>
        <div style={s({ padding: "24px 20px 18px", display: "flex", alignItems: "flex-start", justifyContent: "space-between" })}>
          <div>
            <div style={s({ fontFamily: "Georgia,serif", fontSize: 21, fontStyle: "italic", color: "#f2efe9" })}>Locus</div>
            <div style={s({ fontSize: 11, color: "#706d68", marginTop: 3 })}>where focus lives</div>
          </div>
          <button onClick={() => setSidebarOpen(false)} style={s({ background: "none", border: "none", cursor: "pointer", color: "#706d68", fontSize: 18, lineHeight: 1, marginTop: 2 })}>x</button>
        </div>
        <nav style={s({ padding: "4px 10px", flex: 1, overflowY: "auto" })}>
          {navItems.map((item) => (
            <button key={item.id} onClick={() => { setTab(item.id); setSidebarOpen(false); }} style={s({ display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: 7, cursor: "pointer", color: tab === item.id ? "#8eaefb" : "#b0aca6", background: tab === item.id ? "rgba(142,174,251,0.16)" : "none", border: "none", width: "100%", textAlign: "left", fontSize: 13, marginBottom: 1, fontWeight: tab === item.id ? 500 : 400 })}>
              {item.label}
              {item.badge !== undefined && <span style={s({ marginLeft: "auto", fontSize: 10, background: tab === item.id ? "rgba(142,174,251,0.28)" : "#32323e", color: tab === item.id ? "#8eaefb" : "#706d68", padding: "1px 6px", borderRadius: 99 })}>{item.badge}</span>}
            </button>
          ))}
        </nav>
        <div style={s({ padding: "14px 20px", borderTop: "1px solid rgba(255,255,255,0.09)", fontSize: 11, color: "#706d68", fontFamily: "monospace" })}>
          <div>{today.toLocaleDateString("en-US", { weekday: "long" })}</div>
          <div style={s({ marginTop: 2, color: "#b0aca6" })}>{today.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</div>
        </div>
      </div>

      {/* MAIN */}
      <div style={s({ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", position: "relative" })}>

        {/* TOP BAR */}
        <div style={s({ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.09)", flexShrink: 0 })}>
          <button onClick={() => setSidebarOpen(true)} style={s({ background: "none", border: "none", cursor: "pointer", color: "#b0aca6", fontSize: 20, lineHeight: 1, flexShrink: 0 })}>&#9776;</button>
          <div style={s({ fontFamily: "Georgia,serif", fontSize: 16, fontStyle: "italic", color: "#f2efe9" })}>
            {navItems.find(n => n.id === tab)?.label}
          </div>
        </div>

        {/* TODAY */}
        {tab === "today" && (
          <div style={s({ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" })}>
            <div style={s({ padding: "16px 20px 14px", borderBottom: "1px solid rgba(255,255,255,0.09)", flexShrink: 0 })}>
              <div style={s({ display: "flex", alignItems: "flex-start", justifyContent: "space-between" })}>
                <div>
                  <div style={s({ fontFamily: "Georgia,serif", fontSize: 22, fontStyle: "italic" })}>{today.toLocaleDateString("en-US", { weekday: "long" })}</div>
                  <div style={s({ fontSize: 11, color: "#706d68", marginTop: 3, fontFamily: "monospace" })}>{todayStr}</div>
                </div>
                <button onClick={() => generateTodayPlan()} disabled={planLoading} style={s({ background: "#8eaefb", color: "#0e0f1a", border: "none", borderRadius: 7, padding: "8px 14px", fontSize: 12, fontWeight: 500, cursor: "pointer", opacity: planLoading ? 0.6 : 1, flexShrink: 0 })}>
                  {planLoading ? "..." : "Generate"}
                </button>
              </div>
              <div style={s({ display: "flex", alignItems: "center", gap: 12, marginTop: 10 })}>
                <div style={s({ flex: 1, height: 3, background: "#32323e", borderRadius: 99, overflow: "hidden" })}>
                  <div style={s({ height: "100%", width: progress + "%", background: "#8eaefb", borderRadius: 99, transition: "width 0.4s" })} />
                </div>
                <div style={s({ fontSize: 11, fontFamily: "monospace", color: "#706d68" })}>{todayPlan.filter((b) => b.done).length} / {todayPlan.length}</div>
              </div>
            </div>
            <div style={s({ flex: 1, overflowY: "auto" })}>
              {!todayPlan.length && <div style={s({ padding: "48px 20px", color: "#706d68", fontFamily: "monospace", fontSize: 12, textAlign: "center" })}>No plan yet. Hit Generate or plan tomorrow in the Tomorrow tab.</div>}
              {doneTodayBlocks.map((b) => <PlanBlock key={b.id} block={b} onToggle={(id) => toggleBlock(id, "today")} onSkip={skipBlock} onReschedule={setRescheduleModal} onStart={startBlock} skipCount={skipPatterns[b.title] || 0} />)}
              {doneTodayBlocks.length > 0 && pendingTodayBlocks.length > 0 && (
                <div style={s({ display: "flex", alignItems: "center", gap: 12, padding: "7px 16px 7px 48px" })}>
                  <div style={s({ flex: 1, height: 1, background: "rgba(255,255,255,0.09)" })} />
                  <div style={s({ fontSize: 10, fontFamily: "monospace", color: "#706d68", textTransform: "uppercase", letterSpacing: "0.1em" })}>Now</div>
                  <div style={s({ flex: 1, height: 1, background: "rgba(255,255,255,0.09)" })} />
                </div>
              )}
              {pendingTodayBlocks.map((b) => <PlanBlock key={b.id} block={b} onToggle={(id) => toggleBlock(id, "today")} onSkip={skipBlock} onReschedule={setRescheduleModal} onStart={startBlock} skipCount={skipPatterns[b.title] || 0} />)}
            </div>
          </div>
        )}

        {/* TOMORROW */}
        {tab === "tomorrow" && (
          <div style={s({ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" })}>
            <div style={s({ padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.09)", flexShrink: 0 })}>
              <div style={s({ fontFamily: "Georgia,serif", fontSize: 18, fontStyle: "italic", color: "#b0aca6" })}>{tomorrowStr}</div>
            </div>
            <div style={s({ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" })}>

              {/* Suggestions */}
              <div style={s({ padding: "14px 20px 0" })}>
                <div style={s({ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 })}>
                  <div style={s({ fontSize: 11, fontFamily: "monospace", color: "#706d68", textTransform: "uppercase", letterSpacing: "0.08em" })}>Suggestions for tomorrow</div>
                  <button onClick={loadTomorrowSuggestions} disabled={suggestionsLoading} style={s({ background: "none", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 6, padding: "4px 10px", fontSize: 11, color: "#706d68", cursor: "pointer", fontFamily: "monospace" })}>{suggestionsLoading ? "..." : "↻ refresh"}</button>
                </div>
                {!tomorrowSuggestions.length && <div style={s({ color: "#706d68", fontSize: 12, fontFamily: "monospace", padding: "8px 0 14px" })}>Hit refresh to load suggestions for tomorrow.</div>}
                <div style={s({ display: "flex", flexDirection: "column", gap: 7, marginBottom: 14 })}>
                  {tomorrowSuggestions.map((sug, i) => {
                    const isSelected = selectedSuggestions.includes(sug.title);
                    return (
                      <div key={i} onClick={() => setSelectedSuggestions((prev) => isSelected ? prev.filter((s) => s !== sug.title) : [...prev, sug.title])} style={s({ background: isSelected ? "rgba(142,174,251,0.1)" : "#22222a", border: `1px solid ${isSelected ? "rgba(142,174,251,0.4)" : "rgba(255,255,255,0.09)"}`, borderRadius: 10, padding: "11px 14px", cursor: "pointer", display: "flex", alignItems: "flex-start", gap: 10 })}>
                        <div style={s({ width: 8, height: 8, borderRadius: "50%", background: SUG_COLORS[sug.type] || "#706d68", flexShrink: 0, marginTop: 4 })} />
                        <div style={s({ flex: 1 })}>
                          <div style={s({ fontSize: 13, fontWeight: 500, color: "#f2efe9", marginBottom: 2 })}>{sug.title}</div>
                          <div style={s({ fontSize: 12, color: "#b0aca6", lineHeight: 1.5 })}>{sug.desc}</div>
                        </div>
                        {isSelected && <div style={s({ color: "#8eaefb", fontSize: 14, flexShrink: 0 })}>✓</div>}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Tomorrow plan preview */}
              {tomorrowPlan.length > 0 && (
                <div style={s({ padding: "0 20px 14px" })}>
                  <div style={s({ fontSize: 11, fontFamily: "monospace", color: "#706d68", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 })}>Plan for tomorrow</div>
                  {tomorrowPlan.map((b) => (
                    <div key={b.id} style={s({ background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 10, padding: "11px 14px", marginBottom: 7 })}>
                      <div style={s({ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 })}>
                        <div style={s({ fontSize: 11, fontFamily: "monospace", color: "#8eaefb" })}>{b.time}</div>
                        {b.duration && <div style={s({ fontSize: 10, fontFamily: "monospace", color: "#706d68" })}>{b.duration}</div>}
                        <ImpDots imp={b.imp || 2} />
                      </div>
                      <div style={s({ fontSize: 13, fontWeight: 500, color: "#f2efe9", marginBottom: 2 })}>{b.title}</div>
                      <div style={s({ fontSize: 12, color: "#b0aca6", lineHeight: 1.5 })}>{b.desc}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Tomorrow chat */}
              <div style={s({ borderTop: "1px solid rgba(255,255,255,0.09)", padding: "12px 20px", flexShrink: 0 })}>
                <div style={s({ fontSize: 11, fontFamily: "monospace", color: "#706d68", marginBottom: 8 })}>
                  {selectedSuggestions.length > 0 ? `${selectedSuggestions.length} suggestion${selectedSuggestions.length > 1 ? "s" : ""} selected — tell me anything else, or say "generate my plan"` : "Select suggestions above or tell me what you need tomorrow"}
                </div>
                <div style={s({ maxHeight: 140, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 })}>
                  {tomorrowChatHistory.map((m, i) => (
                    <div key={i} style={s({ maxWidth: "90%", padding: "8px 12px", borderRadius: 10, fontSize: 13, lineHeight: 1.6, alignSelf: m.role === "user" ? "flex-end" : "flex-start", background: m.role === "user" ? "rgba(142,174,251,0.16)" : "#2a2a34", border: m.role === "user" ? "1px solid rgba(142,174,251,0.28)" : "1px solid rgba(255,255,255,0.09)" })}>{m.content}</div>
                  ))}
                  {tomorrowChatLoading && <div style={s({ fontSize: 12, color: "#706d68", fontFamily: "monospace" })}>thinking...</div>}
                  <div ref={tomorrowChatBottomRef} />
                </div>
                <div style={s({ display: "flex", gap: 8 })}>
                  <input value={tomorrowChatInput} onChange={(e) => setTomorrowChatInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") sendTomorrowChat(); }} placeholder="I also need to... / generate my plan" style={s({ flex: 1, background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 7, padding: "10px 14px", fontSize: 16, color: "#f2efe9", outline: "none" })} />
                  <button onClick={sendTomorrowChat} disabled={tomorrowChatLoading} style={s({ background: "rgba(142,174,251,0.16)", border: "1px solid rgba(142,174,251,0.28)", borderRadius: 7, padding: "10px 14px", color: "#8eaefb", fontSize: 12, fontWeight: 500, cursor: "pointer" })}>Send</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* CHAT */}
        {tab === "chat" && (
          <div style={s({ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" })}>
            <div style={s({ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, padding: "16px 20px" })}>
              <div style={s({ maxWidth: "85%", padding: "10px 14px", borderRadius: 12, fontSize: 13, lineHeight: 1.65, background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", alignSelf: "flex-start", borderBottomLeftRadius: 3 })}>
                Hey — I'm Locus. Tell me anything: add goals, check off tasks, brain dump what's on your mind, ask me to search for something. I'll handle it and remember the context.
              </div>
              {chatHistory.map((m, i) => (
                <div key={i} style={s({ maxWidth: "85%", padding: "10px 14px", borderRadius: 12, fontSize: 13, lineHeight: 1.65, whiteSpace: "pre-wrap", alignSelf: m.role === "user" ? "flex-end" : "flex-start", background: m.role === "user" ? "rgba(142,174,251,0.16)" : "#22222a", border: m.role === "user" ? "1px solid rgba(142,174,251,0.28)" : "1px solid rgba(255,255,255,0.09)", borderBottomRightRadius: m.role === "user" ? 3 : 12, borderBottomLeftRadius: m.role === "user" ? 12 : 3 })}>{m.content}</div>
              ))}
              {chatLoading && <div style={s({ fontSize: 12, color: "#706d68", fontFamily: "monospace", alignSelf: "flex-start" })}>thinking...</div>}
              <div ref={chatBottomRef} />
            </div>
            <div style={s({ display: "flex", gap: 8, padding: "12px 20px 20px", borderTop: "1px solid rgba(255,255,255,0.09)", flexShrink: 0 })}>
              <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") sendChat(); }} placeholder="Add a goal, brain dump, search for something..." style={s({ flex: 1, background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 7, padding: "10px 14px", fontSize: 16, color: "#f2efe9", outline: "none" })} />
              <button onClick={sendChat} disabled={chatLoading} style={s({ background: "rgba(142,174,251,0.16)", border: "1px solid rgba(142,174,251,0.28)", borderRadius: 7, padding: "10px 16px", color: "#8eaefb", fontSize: 12, fontWeight: 500, cursor: "pointer" })}>Send</button>
            </div>
          </div>
        )}

        {/* SUGGESTIONS */}
        {tab === "suggestions" && (
          <div style={s({ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" })}>
            <div style={s({ padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.09)", display: "flex", justifyContent: "flex-end", flexShrink: 0 })}>
              <button onClick={loadSuggestions} disabled={suggestionsLoading} style={s({ background: "#8eaefb", color: "#0e0f1a", border: "none", borderRadius: 7, padding: "8px 14px", fontSize: 12, fontWeight: 500, cursor: "pointer", opacity: suggestionsLoading ? 0.6 : 1 })}>{suggestionsLoading ? "Analyzing..." : "↻ Refresh"}</button>
            </div>
            <div style={s({ flex: 1, overflowY: "auto", padding: "16px 20px" })}>
              {!suggestions.length && <div style={s({ color: "#706d68", fontSize: 12, fontFamily: "monospace", textAlign: "center", padding: "48px 0" })}>Hit Refresh — Claude will analyze your goals, habits, journal entries, patterns, and search the web to surface insights and ideas.</div>}
              {suggestions.map((sug, i) => (
                <div key={i} style={s({ background: "#22222a", border: `1px solid rgba(255,255,255,0.09)`, borderLeft: `3px solid ${SUG_COLORS[sug.type] || "#706d68"}`, borderRadius: 12, padding: "14px 16px", marginBottom: 10 })}>
                  <div style={s({ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 })}>
                    <div style={s({ fontSize: 10, fontFamily: "monospace", color: SUG_COLORS[sug.type] || "#706d68", textTransform: "uppercase", letterSpacing: "0.08em" })}>{sug.type}</div>
                    <ImpDots imp={sug.imp || 1} />
                  </div>
                  <div style={s({ fontSize: 14, fontWeight: 500, color: "#f2efe9", marginBottom: 6 })}>{sug.title}</div>
                  <div style={s({ fontSize: 13, color: "#b0aca6", lineHeight: 1.6 })}>{sug.desc}</div>
                  <div style={s({ display: "flex", gap: 6, marginTop: 10 })}>
                    <button onClick={() => { setChatInput(`Tell me more about: ${sug.title}`); setTab("chat"); }} style={s({ fontSize: 11, fontFamily: "monospace", padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.09)", background: "none", color: "#706d68", cursor: "pointer" })}>discuss in chat →</button>
                    {sug.type === "action" && <button onClick={() => { setChatInput(`Add task: ${sug.title}`); setTab("chat"); }} style={s({ fontSize: 11, fontFamily: "monospace", padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(142,174,251,0.3)", background: "rgba(142,174,251,0.1)", color: "#8eaefb", cursor: "pointer" })}>add as task</button>}
                    {sug.type === "longterm" && <button onClick={() => { setChatInput(`Add goal: ${sug.title}`); setTab("chat"); }} style={s({ fontSize: 11, fontFamily: "monospace", padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(184,160,252,0.3)", background: "rgba(184,160,252,0.1)", color: "#b8a0fc", cursor: "pointer" })}>add as goal</button>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* JOURNAL */}
        {tab === "journal" && (
          <div style={s({ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" })}>
            <div style={s({ flex: 1, overflowY: "auto", padding: "16px 20px" })}>
              <div style={s({ background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 12, padding: "14px 16px", marginBottom: 16 })}>
                <div style={s({ fontSize: 11, fontFamily: "monospace", color: "#706d68", marginBottom: 8 })}>{today.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}</div>
                <textarea value={journalInput} onChange={(e) => setJournalInput(e.target.value)} placeholder="How did today go? What's on your mind? No pressure — write whatever feels right." style={s({ width: "100%", background: "none", border: "none", outline: "none", fontSize: 13, color: "#f2efe9", lineHeight: 1.7, resize: "none", minHeight: 120, fontFamily: "'Geist','Inter',sans-serif" })} />
                <button onClick={saveJournal} style={s({ background: "#8eaefb", color: "#0e0f1a", border: "none", borderRadius: 7, padding: "8px 16px", fontSize: 12, fontWeight: 500, cursor: "pointer", marginTop: 8 })}>Save entry</button>
              </div>
              <div style={s({ fontSize: 11, fontFamily: "monospace", color: "#706d68", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 })}>Past entries</div>
              {!journal.length && <div style={s({ color: "#706d68", fontSize: 12, fontFamily: "monospace", padding: "12px 0" })}>no entries yet</div>}
              {journal.map((j, i) => (
                <div key={i} style={s({ background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 12, padding: "14px 16px", marginBottom: 10 })}>
                  <div style={s({ fontSize: 11, fontFamily: "monospace", color: "#706d68", marginBottom: 8 })}>{j.date}</div>
                  <div style={s({ fontSize: 13, color: "#b0aca6", lineHeight: 1.7, whiteSpace: "pre-wrap" })}>{j.text}</div>
                  {history.find((h) => h.date === j.date) && (
                    <div style={s({ marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.06)" })}>
                      <div style={s({ fontSize: 10, fontFamily: "monospace", color: "#706d68", marginBottom: 6 })}>Completed that day</div>
                      {history.find((h) => h.date === j.date)?.entries.filter((e) => e.type === "task").slice(0, 5).map((e, ei) => (
                        <div key={ei} style={s({ fontSize: 12, color: "#706d68", padding: "2px 0" })}>✓ {e.text.replace("Completed: ", "")}</div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* GOALS */}
        {tab === "goals" && (
          <div style={s({ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" })}>
            <div style={s({ padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.09)", display: "flex", justifyContent: "flex-end" })}>
              <button onClick={() => setGoalModal({ name: "", area: "Fitness", desc: "", deadline: "", p: "front" })} style={s({ background: "#8eaefb", color: "#0e0f1a", border: "none", borderRadius: 7, padding: "8px 14px", fontSize: 12, fontWeight: 500, cursor: "pointer" })}>+ Add</button>
            </div>
            <div style={s({ flex: 1, overflowY: "auto", padding: "16px 20px" })}>
              {!goals.length && <div style={s({ color: "#706d68", fontSize: 12, fontFamily: "monospace", textAlign: "center", padding: "28px 0" })}>no goals yet — tell Claude to add some</div>}
              {[...goals].sort((a, b) => ["front","maint","back"].indexOf(a.p) - ["front","maint","back"].indexOf(b.p)).map((g) => (
                <div key={g.id} onClick={() => setGoalModal(g)} style={s({ background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", borderLeft: `3px solid ${g.p === "front" ? "#8eaefb" : g.p === "maint" ? "#b8a0fc" : "#706d68"}`, borderRadius: 12, padding: "14px 16px", marginBottom: 10, cursor: "pointer" })}>
                  <div style={s({ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginLeft: 4 })}>
                    <div style={s({ fontSize: 14, fontWeight: 500 })}>{g.name}</div>
                    <div style={s({ fontSize: 10, fontFamily: "monospace", color: "#706d68", background: "#32323e", padding: "3px 8px", borderRadius: 99, flexShrink: 0, marginLeft: 8 })}>{g.area}</div>
                  </div>
                  {g.desc && <div style={s({ fontSize: 12.5, color: "#b0aca6", marginTop: 6, marginLeft: 4, lineHeight: 1.6 })}>{g.desc}</div>}
                  <div style={s({ display: "flex", alignItems: "center", gap: 10, marginTop: 10, marginLeft: 4 })}>
                    <div style={s({ fontSize: 11, fontFamily: "monospace", color: g.p === "front" ? "#8eaefb" : g.p === "maint" ? "#b8a0fc" : "#706d68" })}>{g.p === "front" ? "front burner" : g.p === "maint" ? "maintenance" : "back burner"}</div>
                    {g.deadline && <div style={s({ fontSize: 11, fontFamily: "monospace", color: "#706d68", marginLeft: "auto" })}>{g.deadline}</div>}
                    <button onClick={(e) => { e.stopPropagation(); setGoals((prev) => prev.filter((x) => x.id !== g.id)); }} style={s({ background: "none", border: "none", cursor: "pointer", color: "#706d68", marginLeft: g.deadline ? 0 : "auto", fontSize: 12 })}>x</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TASKS */}
        {tab === "tasks" && (
          <div style={s({ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" })}>
            <div style={s({ padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.09)", display: "flex", justifyContent: "flex-end" })}>
              <button onClick={() => setTaskModal({ name: "", due: "", goal: "", desc: "", imp: 2, done: false })} style={s({ background: "#8eaefb", color: "#0e0f1a", border: "none", borderRadius: 7, padding: "8px 14px", fontSize: 12, fontWeight: 500, cursor: "pointer" })}>+ Add</button>
            </div>
            <div style={s({ flex: 1, overflowY: "auto", padding: "16px 20px" })}>
              <div style={s({ fontSize: 10, fontFamily: "monospace", color: "#706d68", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 })}>Pending</div>
              {tasks.filter((t) => !t.done).sort((a, b) => (b.imp || 1) - (a.imp || 1)).map((t) => (
                <TaskCard key={t.id} task={t} goals={goals} onToggle={(id) => setTasks((prev) => prev.map((x) => x.id === id ? { ...x, done: !x.done } : x))} onEdit={setTaskModal} onDelete={(id) => setTasks((prev) => prev.filter((x) => x.id !== id))} />
              ))}
              {!tasks.filter((t) => !t.done).length && <div style={s({ color: "#706d68", fontSize: 12, fontFamily: "monospace", padding: "12px 0" })}>no pending tasks</div>}
              <div style={s({ fontSize: 10, fontFamily: "monospace", color: "#706d68", textTransform: "uppercase", letterSpacing: "0.1em", margin: "20px 0 8px" })}>Completed</div>
              {tasks.filter((t) => t.done).map((t) => (
                <TaskCard key={t.id} task={t} goals={goals} onToggle={(id) => setTasks((prev) => prev.map((x) => x.id === id ? { ...x, done: !x.done } : x))} onEdit={setTaskModal} onDelete={(id) => setTasks((prev) => prev.filter((x) => x.id !== id))} />
              ))}
            </div>
          </div>
        )}

        {/* HABITS */}
        {tab === "habits" && (
          <div style={s({ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" })}>
            <div style={s({ padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.09)", display: "flex", justifyContent: "flex-end" })}>
              <button onClick={() => setHabitModal({ name: "", freq: "", note: "" })} style={s({ background: "#8eaefb", color: "#0e0f1a", border: "none", borderRadius: 7, padding: "8px 14px", fontSize: 12, fontWeight: 500, cursor: "pointer" })}>+ Add</button>
            </div>
            <div style={s({ flex: 1, overflowY: "auto", padding: "16px 20px" })}>
              <div style={s({ background: "#2a2a34", borderRadius: 7, padding: "10px 14px", fontSize: 11, color: "#706d68", lineHeight: 1.6, marginBottom: 14, borderLeft: "3px solid rgba(237,190,128,0.3)" })}>Not tasks — these shape how Claude builds your plan. Any frequency works: daily, 3x/week, every 2 weeks, monthly.</div>
              {!habits.length && <div style={s({ color: "#706d68", fontSize: 12, fontFamily: "monospace", textAlign: "center", padding: "28px 0" })}>no habits yet</div>}
              {habits.map((h) => (
                <div key={h.id} style={s({ background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 12, padding: "13px 15px", marginBottom: 9, display: "flex", alignItems: "center", gap: 12 })}>
                  <div style={s({ flex: 1 })}>
                    <div style={s({ fontSize: 14, fontWeight: 500, marginBottom: 4 })}>{h.name}</div>
                    <div style={s({ display: "flex", alignItems: "center", gap: 8 })}>
                      <span style={s({ fontSize: 10, fontFamily: "monospace", color: "#706d68", background: "#32323e", padding: "2px 7px", borderRadius: 99 })}>{h.freq || "custom"}</span>
                      {h.note && <span style={s({ fontSize: 11, color: "#706d68", fontFamily: "monospace" })}>{h.note}</span>}
                    </div>
                    <div style={s({ display: "flex", gap: 3, marginTop: 7 })}>
                      {(h.history || [0,0,0,0,0,0,0]).map((d, i) => (
                        <div key={i} style={s({ width: 7, height: 7, borderRadius: "50%", background: i === 6 && h.tickedToday ? "#81c995" : d ? "#edbe80" : "#32323e" })} />
                      ))}
                    </div>
                  </div>
                  {h.streak > 0 && <div style={s({ fontSize: 11, fontFamily: "monospace", color: "#edbe80" })}>&#9889;{h.streak}</div>}
                  <div onClick={() => {
                    if (navigator.vibrate) navigator.vibrate([15, 10, 25]);
                    setHabits((prev) => prev.map((x) => {
                      if (x.id !== h.id) return x;
                      const ticked = !x.tickedToday;
                      if (ticked) addHistory("habit", `Habit done: ${x.name}`);
                      return { ...x, tickedToday: ticked, streak: ticked ? x.streak + 1 : Math.max(0, x.streak - 1), history: [...(x.history || [0,0,0,0,0,0,0]).slice(1), ticked ? 1 : 0] };
                    }));
                  }} style={s({ width: 28, height: 28, border: `1.5px solid ${h.tickedToday ? "#81c995" : "rgba(255,255,255,0.22)"}`, borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", background: h.tickedToday ? "rgba(129,201,149,0.12)" : "none", color: "#81c995", fontSize: 13 })}>
                    {h.tickedToday ? "✓" : ""}
                  </div>
                  <button onClick={() => setHabits((prev) => prev.filter((x) => x.id !== h.id))} style={s({ background: "none", border: "none", cursor: "pointer", color: "#706d68", fontSize: 12 })}>x</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* IDEAS */}
        {tab === "ideas" && (
          <div style={s({ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" })}>
            <div style={s({ flex: 1, overflowY: "auto", padding: "16px 20px" })}>
              <div style={s({ display: "flex", gap: 8, marginBottom: 14 })}>
                <input value={ideaInput} onChange={(e) => setIdeaInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && ideaInput.trim()) { setIdeas((prev) => [...prev, { id: Date.now().toString(), t: ideaInput.trim() }]); setIdeaInput(""); }}} placeholder="Drop an idea, no commitment..." style={s({ flex: 1, background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 7, padding: "10px 14px", fontSize: 16, color: "#f2efe9", outline: "none" })} />
                <button onClick={() => { if (ideaInput.trim()) { setIdeas((prev) => [...prev, { id: Date.now().toString(), t: ideaInput.trim() }]); setIdeaInput(""); }}} style={s({ background: "#8eaefb", color: "#0e0f1a", border: "none", borderRadius: 7, padding: "10px 14px", fontSize: 12, fontWeight: 500, cursor: "pointer" })}>Add</button>
              </div>
              {ideas.map((i) => (
                <div key={i.id} style={s({ background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 12, padding: "11px 15px", marginBottom: 7, display: "flex", alignItems: "center", gap: 10 })}>
                  <div style={s({ width: 7, height: 7, borderRadius: "50%", background: "#b8a0fc", opacity: 0.8, flexShrink: 0 })} />
                  <div style={s({ flex: 1, fontSize: 13, color: "#b0aca6" })}>{i.t}</div>
                  <button onClick={() => { setChatInput(`Promote idea to goal: ${i.t}`); setTab("chat"); }} style={s({ fontSize: 10, fontFamily: "monospace", padding: "3px 8px", borderRadius: 5, border: "1px solid rgba(184,160,252,0.3)", background: "none", color: "#b8a0fc", cursor: "pointer", flexShrink: 0 })}>→ goal</button>
                  <button onClick={() => setIdeas((prev) => prev.filter((x) => x.id !== i.id))} style={s({ background: "none", border: "none", cursor: "pointer", color: "#706d68", fontSize: 12 })}>x</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* HISTORY */}
        {tab === "history" && (
          <div style={s({ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" })}>
            <div style={s({ flex: 1, overflowY: "auto", padding: "16px 20px" })}>
              {!history.length && <div style={s({ color: "#706d68", fontSize: 12, fontFamily: "monospace", textAlign: "center", padding: "28px 0" })}>no history yet</div>}
              {history.map((day, di) => (
                <div key={di} style={s({ marginBottom: 22 })}>
                  <div style={s({ fontSize: 11, fontFamily: "monospace", color: "#706d68", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 9 })}>{day.date}</div>
                  {day.entries.map((e, ei) => {
                    const meta = { task: { bg: "rgba(142,174,251,0.16)", color: "#8eaefb", icon: "✓" }, habit: { bg: "rgba(237,190,128,0.13)", color: "#edbe80", icon: "!" }, skip: { bg: "#32323e", color: "#706d68", icon: "-" }, reschedule: { bg: "rgba(240,192,96,0.12)", color: "#f0c060", icon: "r" } }[e.type] || { bg: "#32323e", color: "#706d68", icon: "." };
                    return (
                      <div key={ei} style={s({ background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 7, padding: "9px 13px", marginBottom: 5, display: "flex", alignItems: "center", gap: 9 })}>
                        <div style={s({ width: 20, height: 20, borderRadius: "50%", background: meta.bg, color: meta.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, flexShrink: 0 })}>{meta.icon}</div>
                        <div style={s({ flex: 1, fontSize: 12.5, color: "#b0aca6" })}>{e.text}</div>
                        {e.time && <div style={s({ fontSize: 10, fontFamily: "monospace", color: "#706d68" })}>{e.time}</div>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* MODALS */}
      {goalModal && (
        <Modal onClose={() => setGoalModal(null)} title={goalModal.id ? "Edit goal" : "Add goal"}>
          <Field label="Goal name"><input value={goalModal.name} onChange={(e) => setGoalModal((m) => ({ ...m, name: e.target.value }))} placeholder="e.g. Land a fintech role" /></Field>
          <Field label="Life area">
            <select value={goalModal.area} onChange={(e) => setGoalModal((m) => ({ ...m, area: e.target.value }))}>
              {["Fitness","Career","Learning","Social","Finance","Health","Creative","Other"].map((a) => <option key={a}>{a}</option>)}
            </select>
          </Field>
          <Field label="Description"><textarea value={goalModal.desc} onChange={(e) => setGoalModal((m) => ({ ...m, desc: e.target.value }))} placeholder="Why this matters..." /></Field>
          <Field label="Target timeframe"><input value={goalModal.deadline} onChange={(e) => setGoalModal((m) => ({ ...m, deadline: e.target.value }))} placeholder="e.g. Spring 2027" /></Field>
          <Field label="Priority">
            <div style={{ display: "flex", gap: 6 }}>
              {[["front","Front"],["maint","Maint"],["back","Back"]].map(([val, label]) => (
                <button key={val} onClick={() => setGoalModal((m) => ({ ...m, p: val }))} style={{ flex: 1, padding: "8px 4px", fontSize: 11, fontFamily: "monospace", border: `1px solid ${goalModal.p === val ? "#8eaefb" : "rgba(255,255,255,0.09)"}`, borderRadius: 7, background: goalModal.p === val ? "rgba(142,174,251,0.16)" : "none", color: goalModal.p === val ? "#8eaefb" : "#706d68", cursor: "pointer" }}>{label}</button>
              ))}
            </div>
          </Field>
          <ModalActions onCancel={() => setGoalModal(null)} onSave={() => {
            if (!goalModal.name.trim()) return;
            const g = { ...goalModal, id: goalModal.id || Date.now().toString() };
            setGoals((prev) => goalModal.id ? prev.map((x) => x.id === g.id ? g : x) : [...prev, g]);
            setGoalModal(null);
          }} />
        </Modal>
      )}

      {taskModal && (
        <Modal onClose={() => setTaskModal(null)} title={taskModal.id ? "Edit task" : "Add task"}>
          <Field label="Task name"><input value={taskModal.name} onChange={(e) => setTaskModal((m) => ({ ...m, name: e.target.value }))} placeholder="e.g. Register for fall classes" /></Field>
          <Field label="Due date"><input value={taskModal.due} onChange={(e) => setTaskModal((m) => ({ ...m, due: e.target.value }))} placeholder="e.g. June 15" /></Field>
          <Field label="Linked goal">
            <select value={taskModal.goal} onChange={(e) => setTaskModal((m) => ({ ...m, goal: e.target.value }))}>
              <option value="">none</option>
              {goals.map((g) => <option key={g.id} value={g.name}>{g.name}</option>)}
            </select>
          </Field>
          <Field label="Importance">
            <div style={{ display: "flex", gap: 6 }}>
              {[[1,"Low"],[2,"Medium"],[3,"Critical"]].map(([val, label]) => (
                <button key={val} onClick={() => setTaskModal((m) => ({ ...m, imp: val }))} style={{ flex: 1, padding: "8px 6px", fontSize: 11, fontFamily: "monospace", border: `1px solid ${taskModal.imp === val ? "#8eaefb" : "rgba(255,255,255,0.09)"}`, borderRadius: 7, background: taskModal.imp === val ? "rgba(142,174,251,0.16)" : "none", color: taskModal.imp === val ? "#8eaefb" : "#706d68", cursor: "pointer" }}>{label}</button>
              ))}
            </div>
          </Field>
          <ModalActions onCancel={() => setTaskModal(null)} onSave={() => {
            if (!taskModal.name.trim()) return;
            const t = { ...taskModal, id: taskModal.id || Date.now().toString() };
            setTasks((prev) => taskModal.id ? prev.map((x) => x.id === t.id ? t : x) : [...prev, t]);
            setTaskModal(null);
          }} />
        </Modal>
      )}

      {habitModal && (
        <Modal onClose={() => setHabitModal(null)} title={habitModal.id ? "Edit habit" : "Add habit"}>
          <Field label="Habit name"><input value={habitModal.name} onChange={(e) => setHabitModal((m) => ({ ...m, name: e.target.value }))} placeholder="e.g. 200g protein" /></Field>
          <Field label="Frequency"><input value={habitModal.freq} onChange={(e) => setHabitModal((m) => ({ ...m, freq: e.target.value }))} placeholder="e.g. daily, 3x per week, every 2 weeks, monthly" /></Field>
          <Field label="Note (optional)"><input value={habitModal.note} onChange={(e) => setHabitModal((m) => ({ ...m, note: e.target.value }))} placeholder="e.g. spread across 4 meals" /></Field>
          <ModalActions onCancel={() => setHabitModal(null)} onSave={() => {
            if (!habitModal.name.trim()) return;
            const h = { ...habitModal, id: habitModal.id || Date.now().toString(), streak: habitModal.streak || 0, history: habitModal.history || [0,0,0,0,0,0,0], tickedToday: habitModal.tickedToday || false };
            setHabits((prev) => habitModal.id ? prev.map((x) => x.id === h.id ? h : x) : [...prev, h]);
            setHabitModal(null);
          }} />
        </Modal>
      )}

      {rescheduleModal && (
        <Modal onClose={() => setRescheduleModal(null)} title="What happened?">
          <Field label="Why couldn't you do it?"><textarea value={rescheduleReason} onChange={(e) => setRescheduleReason(e.target.value)} placeholder="e.g. Meeting ran long, ran out of energy, came up unexpectedly..." /></Field>
          <Field label="Move to when? (optional)"><input value={rescheduleTime} onChange={(e) => setRescheduleTime(e.target.value)} placeholder="e.g. this evening, tomorrow morning" /></Field>
          <div style={{ fontSize: 11, color: "#706d68", fontFamily: "monospace", marginTop: 4 }}>Claude will remember this and adjust future plans accordingly.</div>
          <ModalActions onCancel={() => setRescheduleModal(null)} onSave={confirmReschedule} saveLabel="Got it" />
        </Modal>
      )}
    </div>
  );
}

function PlanBlock({ block, onToggle, onSkip, onReschedule, onStart, skipCount = 0 }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [skipInput, setSkipInput] = useState("");
  const [showSkipInput, setShowSkipInput] = useState(false);
  const isSkipped = block.status === "skipped";
  const isRescheduled = block.status === "rescheduled";

  return (
    <div style={{ display: "flex", alignItems: "flex-start", borderBottom: "1px solid rgba(255,255,255,0.09)", opacity: block.done || isSkipped ? 0.32 : 1, position: "relative" }}>
      <div style={{ width: 48, flexShrink: 0, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 18 }}>
        <div onClick={() => { if (!isSkipped) { onStart(block.id); onToggle(block.id); }}} style={{ width: 18, height: 18, border: `1.5px solid ${block.done ? "#81c995" : "rgba(255,255,255,0.22)"}`, borderRadius: "50%", cursor: isSkipped ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", background: block.done ? "#81c995" : "none", flexShrink: 0 }}>
          {block.done && <div style={{ width: 8, height: 5, borderLeft: "2px solid #0e1a11", borderBottom: "2px solid #0e1a11", transform: "rotate(-45deg) translateY(-1px)" }} />}
        </div>
      </div>
      <div style={{ flex: 1, padding: "14px 8px 14px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
          <div style={{ fontSize: 11, fontFamily: "monospace", color: "#8eaefb" }}>{block.time}{block.duration ? ` ${block.duration}` : ""}{isRescheduled && block.newTime ? " → " + block.newTime : ""}</div>
          <ImpDots imp={block.imp || 2} />
        </div>
        <div style={{ fontSize: 14, fontWeight: 500, color: block.done || isSkipped ? "#706d68" : "#f2efe9", textDecoration: block.done || isSkipped ? "line-through" : "none", marginBottom: 3 }}>{block.title}</div>
        <div style={{ fontSize: 12.5, color: "#b0aca6", lineHeight: 1.6 }}>{block.desc}</div>
        {showSkipInput && (
          <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
            <input value={skipInput} onChange={(e) => setSkipInput(e.target.value)} placeholder="What came up? (optional)" style={{ flex: 1, background: "#2a2a34", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 6, padding: "6px 10px", fontSize: 12, color: "#f2efe9", outline: "none" }} />
            <button onClick={() => { onSkip(block.id, skipInput); setShowSkipInput(false); }} style={{ background: "#32323e", border: "none", borderRadius: 6, padding: "6px 10px", fontSize: 11, color: "#b0aca6", cursor: "pointer" }}>Skip</button>
          </div>
        )}
        <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap" }}>
          {block.done && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#81c995", background: "rgba(129,201,149,0.12)", padding: "2px 8px", borderRadius: 99 }}>completed</span>}
          {isSkipped && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#706d68", background: "#32323e", padding: "2px 8px", borderRadius: 99 }}>skipped{block.skipReason ? ` — ${block.skipReason}` : ""}</span>}
          {isRescheduled && !block.done && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#f0c060", background: "rgba(240,192,96,0.12)", padding: "2px 8px", borderRadius: 99 }}>rescheduled</span>}
          {skipCount >= 2 && !block.done && !isSkipped && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#f28b82", background: "rgba(242,139,130,0.12)", padding: "2px 8px", borderRadius: 99 }}>skipped {skipCount}x recently</span>}
        </div>
      </div>
      {!block.done && !isSkipped && (
        <div style={{ width: 34, flexShrink: 0, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 12, position: "relative" }}>
          <button onClick={() => setMenuOpen((o) => !o)} style={{ background: "none", border: "none", cursor: "pointer", color: "#706d68", fontSize: 15, padding: 4, borderRadius: 4 }}>...</button>
          {menuOpen && (
            <div style={{ position: "absolute", right: 6, top: 32, background: "#2a2a34", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 7, zIndex: 50, minWidth: 150, overflow: "hidden", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
              <button onClick={() => { setShowSkipInput(true); setMenuOpen(false); }} style={{ padding: "9px 13px", fontSize: 12, cursor: "pointer", color: "#b0aca6", background: "none", border: "none", width: "100%", textAlign: "left" }}>Skip</button>
              <button onClick={() => { onReschedule(block.id); setMenuOpen(false); }} style={{ padding: "9px 13px", fontSize: 12, cursor: "pointer", color: "#b0aca6", background: "none", border: "none", width: "100%", textAlign: "left" }}>Reschedule</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskCard({ task, goals, onToggle, onEdit, onDelete }) {
  return (
    <div onClick={() => onEdit(task)} style={{ background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 12, padding: "13px 15px", marginBottom: 8, display: "flex", alignItems: "flex-start", gap: 11, opacity: task.done ? 0.38 : 1, cursor: "pointer" }}>
      <div onClick={(e) => { e.stopPropagation(); onToggle(task.id); }} style={{ width: 17, height: 17, border: `1.5px solid ${task.done ? "#8eaefb" : "rgba(255,255,255,0.22)"}`, borderRadius: 5, flexShrink: 0, marginTop: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", background: task.done ? "#8eaefb" : "none" }}>
        {task.done && <div style={{ width: 8, height: 5, borderLeft: "2px solid #0e0f1a", borderBottom: "2px solid #0e0f1a", transform: "rotate(-45deg) translateY(-1px)" }} />}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: "#f2efe9", textDecoration: task.done ? "line-through" : "none" }}>{task.name}</div>
        {(task.due || task.goal) && (
          <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
            {task.due && <span style={{ fontSize: 11, fontFamily: "monospace", color: "#706d68" }}>Due: {task.due}</span>}
            {task.goal && <span style={{ fontSize: 11, fontFamily: "monospace", color: "#706d68" }}>↳ {task.goal}</span>}
          </div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <ImpDots imp={task.imp || 1} />
        <button onClick={(e) => { e.stopPropagation(); onDelete(task.id); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#706d68", fontSize: 12 }}>x</button>
      </div>
    </div>
  );
}

function Modal({ children, onClose, title }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, backdropFilter: "blur(2px)", padding: "0 16px" }} onClick={onClose}>
      <div style={{ background: "#22222a", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 12, padding: 24, width: "100%", maxWidth: 420, maxHeight: "85vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontFamily: "Georgia,serif", fontSize: 18, fontStyle: "italic", color: "#f2efe9", marginBottom: 18 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 13 }}>
      <div style={{ fontSize: 10, fontFamily: "monospace", color: "#706d68", marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
      {children}
    </div>
  );
}

function ModalActions({ onCancel, onSave, saveLabel = "Save" }) {
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
      <button onClick={onCancel} style={{ padding: "10px 16px", fontSize: 13, background: "none", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 7, color: "#b0aca6", cursor: "pointer" }}>Cancel</button>
      <button onClick={onSave} style={{ flex: 1, padding: 10, fontSize: 13, fontWeight: 500, background: "#8eaefb", color: "#0e0f1a", border: "none", borderRadius: 7, cursor: "pointer" }}>{saveLabel}</button>
    </div>
  );
}