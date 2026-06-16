import { useState, useEffect } from "react";
import "./App.css";

const STORAGE_KEYS = {
  goals: "locus-goals",
  tasks: "locus-tasks",
  habits: "locus-habits",
  ideas: "locus-ideas",
  plan: "locus-plan",
  history: "locus-history",
  skipPatterns: "locus-skip-patterns",
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
  localStorage.setItem(key, JSON.stringify(val));
}

async function callClaude(system, messages) {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, messages }),
  });
  const data = await res.json();
  return data.content?.[0]?.text || "Something went wrong.";
}

function buildContext(goals, tasks, habits, ideas, skipPatterns) {
  const ord = ["front", "maint", "back"];
  const sorted = [...goals].sort((a, b) => ord.indexOf(a.p) - ord.indexOf(b.p));
  const fp = sorted.filter((g) => g.p === "front");
  const mp = sorted.filter((g) => g.p === "maint");
  const bp = sorted.filter((g) => g.p === "back");
  const fg = (arr) =>
    arr.length
      ? arr.map((g) => `- ${g.name} (${g.area})${g.deadline ? ", by " + g.deadline : ""}${g.desc ? ": " + g.desc : ""}`).join("\n")
      : "None";
  const pt = tasks.filter((t) => !t.done);
  const ft = pt.length
    ? pt.map((t) => `- ${t.name}${t.due ? ", due " + t.due : ""}${t.goal ? " [goal: " + t.goal + "]" : ""}${t.imp ? " [importance: " + t.imp + "/3]" : ""}`).join("\n")
    : "None";
  const patterns = Object.entries(skipPatterns)
    .filter(([, c]) => c >= 2)
    .map(([k, c]) => `- "${k}" skipped/rescheduled ${c}x`)
    .join("\n") || "None";
  const habitCtx = habits.map((h) => `- ${h.name} (${h.freq})${h.note ? ": " + h.note : ""}, streak: ${h.streak} days`).join("\n") || "None";
  return `USER CONTEXT:\n\nLONG-TERM GOALS:\nFront burner:\n${fg(fp)}\nMaintenance:\n${fg(mp)}\nBack burner:\n${fg(bp)}\n\nPENDING TASKS:\n${ft}\n\nHABITS:\n${habitCtx}\n\nSKIP PATTERNS (blocks consistently avoided):\n${patterns}\n\nIDEAS PARKING LOT:\n${ideas.map((i) => "- " + i.t).join("\n") || "None"}`;
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
  const [goals, setGoals] = useState(() => load(STORAGE_KEYS.goals, []));
  const [tasks, setTasks] = useState(() => load(STORAGE_KEYS.tasks, []));
  const [habits, setHabits] = useState(() => load(STORAGE_KEYS.habits, []));
  const [ideas, setIdeas] = useState(() => load(STORAGE_KEYS.ideas, []));
  const [planBlocks, setPlanBlocks] = useState(() => load(STORAGE_KEYS.plan, []));
  const [history, setHistory] = useState(() => load(STORAGE_KEYS.history, []));
  const [skipPatterns, setSkipPatterns] = useState(() => load(STORAGE_KEYS.skipPatterns, {}));
  const [chatHistory, setChatHistory] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [planLoading, setPlanLoading] = useState(false);
  const [goalModal, setGoalModal] = useState(null);
  const [taskModal, setTaskModal] = useState(null);
  const [habitModal, setHabitModal] = useState(null);
  const [rescheduleModal, setRescheduleModal] = useState(null);
  const [rescheduleReason, setRescheduleReason] = useState("");
  const [rescheduleTime, setRescheduleTime] = useState("");
  const [ideaInput, setIdeaInput] = useState("");

  useEffect(() => { save(STORAGE_KEYS.goals, goals); }, [goals]);
  useEffect(() => { save(STORAGE_KEYS.tasks, tasks); }, [tasks]);
  useEffect(() => { save(STORAGE_KEYS.habits, habits); }, [habits]);
  useEffect(() => { save(STORAGE_KEYS.ideas, ideas); }, [ideas]);
  useEffect(() => { save(STORAGE_KEYS.plan, planBlocks); }, [planBlocks]);
  useEffect(() => { save(STORAGE_KEYS.history, history); }, [history]);
  useEffect(() => { save(STORAGE_KEYS.skipPatterns, skipPatterns); }, [skipPatterns]);

  const addHistory = (type, text) => {
    const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    setHistory((prev) => {
      const next = [...prev];
      if (!next.length || next[0].date !== today) next.unshift({ date: today, entries: [] });
      next[0].entries.unshift({ type, text });
      return next;
    });
  };

  const generatePlan = async () => {
    setPlanLoading(true);
    const ctx = buildContext(goals, tasks, habits, ideas, skipPatterns);
    try {
      const text = await callClaude(
        `You are a personal day planner for Locus. ${ctx}\n\nGenerate a realistic time-blocked day plan. Rules:\n- Front burner goals get the most time\n- Maintenance goals get shorter blocks\n- Back burner only if space\n- Pending tasks get specific slots by importance\n- Habits are constraints, weave them in\n- Avoid blocks that match skip patterns — restructure timing instead\n- Include flex time\n- Respond ONLY with JSON array, no markdown, no explanation. Format: [{"time":"7:00 – 9:00 am","title":"Block title","desc":"Description","imp":3}]. imp is 1-3.`,
        [{ role: "user", content: "Build my plan for today." }]
      );
      const clean = text.replace(/```json|```/g, "").trim();
      const blocks = JSON.parse(clean).map((b, i) => ({ ...b, id: "b" + i, done: false, status: "pending" }));
      setPlanBlocks(blocks);
    } catch (e) {
      alert("Error generating plan. Check your API key and try again.");
    }
    setPlanLoading(false);
  };

  const toggleBlock = (id) => {
    setPlanBlocks((prev) =>
      prev.map((b) => {
        if (b.id !== id) return b;
        if (!b.done) addHistory("task", `Completed: ${b.title}`);
        return { ...b, done: !b.done };
      })
    );
    if (navigator.vibrate) navigator.vibrate([12, 8, 20]);
  };

  const skipBlock = (id) => {
    setPlanBlocks((prev) =>
      prev.map((b) => {
        if (b.id !== id) return b;
        setSkipPatterns((sp) => ({ ...sp, [b.title]: (sp[b.title] || 0) + 1 }));
        addHistory("skip", `Skipped: ${b.title}`);
        return { ...b, status: "skipped" };
      })
    );
  };

  const confirmReschedule = () => {
    setPlanBlocks((prev) =>
      prev.map((b) => {
        if (b.id !== rescheduleModal) return b;
        setSkipPatterns((sp) => ({ ...sp, [b.title]: (sp[b.title] || 0) + 1 }));
        addHistory("reschedule", `Rescheduled: ${b.title}${rescheduleTime ? " → " + rescheduleTime : ""}${rescheduleReason ? " (" + rescheduleReason + ")" : ""}`);
        return { ...b, status: "rescheduled", newTime: rescheduleTime, conflict: rescheduleReason };
      })
    );
    setRescheduleModal(null);
    setRescheduleReason("");
    setRescheduleTime("");
  };

  const sendChat = async () => {
    if (!chatInput.trim()) return;
    const userMsg = chatInput.trim();
    setChatInput("");
    setChatHistory((prev) => [...prev, { role: "user", content: userMsg }]);
    setChatLoading(true);
    const ctx = buildContext(goals, tasks, habits, ideas, skipPatterns);
    try {
      const reply = await callClaude(
        `You are a personal planner assistant inside Locus. ${ctx}\n\nHelp the user think through planning, priorities, balance, and what to focus on. Be concise and direct. Reference their actual goals and patterns.`,
        [...chatHistory, { role: "user", content: userMsg }]
      );
      setChatHistory((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch {
      setChatHistory((prev) => [...prev, { role: "assistant", content: "Error connecting. Try again." }]);
    }
    setChatLoading(false);
  };

  const today = new Date();
  const todayStr = today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const donePlanBlocks = planBlocks.filter((b) => b.done || b.status === "skipped");
  const pendingPlanBlocks = planBlocks.filter((b) => !b.done && b.status !== "skipped");
  const progress = planBlocks.length ? Math.round((planBlocks.filter((b) => b.done).length / planBlocks.length) * 100) : 0;

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden", background: "#1a1a20", color: "#f2efe9", fontFamily: "'Geist', 'Inter', sans-serif", fontSize: 14 }}>
      {/* SIDEBAR */}
      <div style={{ width: 220, flexShrink: 0, background: "#22222a", borderRight: "1px solid rgba(255,255,255,0.09)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "24px 20px 18px" }}>
          <div style={{ fontFamily: "Georgia, serif", fontSize: 21, fontStyle: "italic", color: "#f2efe9" }}>Locus</div>
          <div style={{ fontSize: 11, color: "#706d68", marginTop: 3 }}>where focus lives</div>
        </div>
        <nav style={{ padding: "4px 10px", flex: 1 }}>
          {[
            { id: "today", label: "Today" },
            { id: "chat", label: "Chat" },
            { id: "goals", label: "Goals", badge: goals.length },
            { id: "tasks", label: "Tasks", badge: tasks.filter((t) => !t.done).length },
            { id: "habits", label: "Habits", badge: habits.length },
            { id: "ideas", label: "Ideas", badge: ideas.length },
            { id: "history", label: "History" },
          ].map((item) => (
            <button key={item.id} onClick={() => setTab(item.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 7, cursor: "pointer", color: tab === item.id ? "#8eaefb" : "#b0aca6", background: tab === item.id ? "rgba(142,174,251,0.16)" : "none", border: "none", width: "100%", textAlign: "left", fontSize: 13, marginBottom: 1, fontWeight: tab === item.id ? 500 : 400 }}>
              {item.label}
              {item.badge !== undefined && <span style={{ marginLeft: "auto", fontSize: 10, background: tab === item.id ? "rgba(142,174,251,0.28)" : "#32323e", color: tab === item.id ? "#8eaefb" : "#706d68", padding: "1px 6px", borderRadius: 99 }}>{item.badge}</span>}
            </button>
          ))}
        </nav>
        <div style={{ padding: "14px 20px", borderTop: "1px solid rgba(255,255,255,0.09)", fontSize: 11, color: "#706d68", fontFamily: "monospace" }}>
          <div>{today.toLocaleDateString("en-US", { weekday: "long" })}</div>
          <div style={{ marginTop: 2, color: "#b0aca6" }}>{today.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</div>
        </div>
      </div>

      {/* MAIN */}
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>

        {/* TODAY */}
        {tab === "today" && (
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ padding: "24px 36px 16px", borderBottom: "1px solid rgba(255,255,255,0.09)", flexShrink: 0 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontFamily: "Georgia, serif", fontSize: 26, fontStyle: "italic" }}>{today.toLocaleDateString("en-US", { weekday: "long" })}</div>
                  <div style={{ fontSize: 11, color: "#706d68", marginTop: 4, fontFamily: "monospace" }}>{todayStr}</div>
                </div>
                <button onClick={generatePlan} disabled={planLoading} style={{ background: "#8eaefb", color: "#0e0f1a", border: "none", borderRadius: 7, padding: "9px 18px", fontSize: 12, fontWeight: 500, cursor: "pointer", opacity: planLoading ? 0.6 : 1 }}>
                  {planLoading ? "Generating..." : "↗ Generate plan"}
                </button>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
                <div style={{ flex: 1, height: 3, background: "#32323e", borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: progress + "%", background: "#8eaefb", borderRadius: 99, transition: "width 0.4s" }} />
                </div>
                <div style={{ fontSize: 11, fontFamily: "monospace", color: "#706d68" }}>{planBlocks.filter((b) => b.done).length} / {planBlocks.length}</div>
              </div>
            </div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {!planBlocks.length && <div style={{ padding: "48px 36px", color: "#706d68", fontFamily: "monospace", fontSize: 12, textAlign: "center" }}>No plan yet — hit "Generate plan" to build your day.</div>}
              {donePlanBlocks.map((b) => <PlanBlock key={b.id} block={b} onToggle={toggleBlock} onSkip={skipBlock} onReschedule={setRescheduleModal} />)}
              {donePlanBlocks.length > 0 && pendingPlanBlocks.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 20px 7px 50px" }}>
                  <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.09)" }} />
                  <div style={{ fontSize: 10, fontFamily: "monospace", color: "#706d68", textTransform: "uppercase", letterSpacing: "0.1em" }}>Now</div>
                  <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.09)" }} />
                </div>
              )}
              {pendingPlanBlocks.map((b) => <PlanBlock key={b.id} block={b} onToggle={toggleBlock} onSkip={skipBlock} onReschedule={setRescheduleModal} skipCount={skipPatterns[b.title] || 0} />)}
            </div>
          </div>
        )}

        {/* GOALS */}
        {tab === "goals" && (
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ padding: "24px 36px 16px", borderBottom: "1px solid rgba(255,255,255,0.09)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontFamily: "Georgia, serif", fontSize: 26, fontStyle: "italic" }}>Goals</div>
              <button onClick={() => setGoalModal({ name: "", area: "Fitness", desc: "", deadline: "", p: "front" })} style={{ background: "#8eaefb", color: "#0e0f1a", border: "none", borderRadius: 7, padding: "9px 18px", fontSize: 12, fontWeight: 500, cursor: "pointer" }}>+ Add goal</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "20px 36px" }}>
              {!goals.length && <div style={{ color: "#706d68", fontSize: 12, fontFamily: "monospace", textAlign: "center", padding: "28px 0" }}>no goals yet</div>}
              {[...goals].sort((a, b) => ["front","maint","back"].indexOf(a.p) - ["front","maint","back"].indexOf(b.p)).map((g) => (
                <div key={g.id} onClick={() => setGoalModal(g)} style={{ background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", borderLeft: `3px solid ${g.p === "front" ? "#8eaefb" : g.p === "maint" ? "#b8a0fc" : "#706d68"}`, borderRadius: 12, padding: "16px 18px", marginBottom: 10, cursor: "pointer" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginLeft: 6 }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{g.name}</div>
                    <div style={{ fontSize: 10, fontFamily: "monospace", color: "#706d68", background: "#32323e", padding: "3px 8px", borderRadius: 99 }}>{g.area}</div>
                  </div>
                  {g.desc && <div style={{ fontSize: 12.5, color: "#b0aca6", marginTop: 7, marginLeft: 6, lineHeight: 1.6 }}>{g.desc}</div>}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, marginLeft: 6 }}>
                    <div style={{ fontSize: 11, fontFamily: "monospace", color: g.p === "front" ? "#8eaefb" : g.p === "maint" ? "#b8a0fc" : "#706d68" }}>{g.p === "front" ? "front burner" : g.p === "maint" ? "maintenance" : "back burner"}</div>
                    {g.deadline && <div style={{ fontSize: 11, fontFamily: "monospace", color: "#706d68", marginLeft: "auto" }}>{g.deadline}</div>}
                    <button onClick={(e) => { e.stopPropagation(); setGoals((prev) => prev.filter((x) => x.id !== g.id)); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#706d68", marginLeft: g.deadline ? 0 : "auto", fontSize: 12 }}>✕</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TASKS */}
        {tab === "tasks" && (
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ padding: "24px 36px 16px", borderBottom: "1px solid rgba(255,255,255,0.09)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontFamily: "Georgia, serif", fontSize: 26, fontStyle: "italic" }}>Tasks</div>
              <button onClick={() => setTaskModal({ name: "", due: "", goal: "", desc: "", imp: 2, done: false })} style={{ background: "#8eaefb", color: "#0e0f1a", border: "none", borderRadius: 7, padding: "9px 18px", fontSize: 12, fontWeight: 500, cursor: "pointer" }}>+ Add task</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "20px 36px" }}>
              <div style={{ fontSize: 10, fontFamily: "monospace", color: "#706d68", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Pending</div>
              {tasks.filter((t) => !t.done).sort((a, b) => (b.imp || 1) - (a.imp || 1)).map((t) => (
                <TaskCard key={t.id} task={t} goals={goals} onToggle={(id) => { setTasks((prev) => prev.map((x) => x.id === id ? { ...x, done: !x.done } : x)); }} onEdit={setTaskModal} onDelete={(id) => setTasks((prev) => prev.filter((x) => x.id !== id))} />
              ))}
              {!tasks.filter((t) => !t.done).length && <div style={{ color: "#706d68", fontSize: 12, fontFamily: "monospace", padding: "12px 0" }}>no pending tasks</div>}
              <div style={{ fontSize: 10, fontFamily: "monospace", color: "#706d68", textTransform: "uppercase", letterSpacing: "0.1em", margin: "20px 0 8px" }}>Completed</div>
              {tasks.filter((t) => t.done).map((t) => (
                <TaskCard key={t.id} task={t} goals={goals} onToggle={(id) => setTasks((prev) => prev.map((x) => x.id === id ? { ...x, done: !x.done } : x))} onEdit={setTaskModal} onDelete={(id) => setTasks((prev) => prev.filter((x) => x.id !== id))} />
              ))}
            </div>
          </div>
        )}

        {/* HABITS */}
        {tab === "habits" && (
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ padding: "24px 36px 16px", borderBottom: "1px solid rgba(255,255,255,0.09)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontFamily: "Georgia, serif", fontSize: 26, fontStyle: "italic" }}>Habits</div>
              <button onClick={() => setHabitModal({ name: "", freq: "daily", note: "" })} style={{ background: "#8eaefb", color: "#0e0f1a", border: "none", borderRadius: 7, padding: "9px 18px", fontSize: 12, fontWeight: 500, cursor: "pointer" }}>+ Add habit</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "20px 36px" }}>
              <div style={{ background: "#2a2a34", borderRadius: 7, padding: "10px 14px", fontSize: 11, color: "#706d68", lineHeight: 1.6, marginBottom: 14, borderLeft: "3px solid rgba(237,190,128,0.3)" }}>Not tasks — these reset daily and shape how Claude builds your plan. Tick each day to build your streak.</div>
              {!habits.length && <div style={{ color: "#706d68", fontSize: 12, fontFamily: "monospace", textAlign: "center", padding: "28px 0" }}>no habits yet</div>}
              {habits.map((h) => (
                <div key={h.id} style={{ background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 12, padding: "13px 15px", marginBottom: 9, display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>{h.name}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 10, fontFamily: "monospace", color: "#706d68", background: "#32323e", padding: "2px 7px", borderRadius: 99 }}>{h.freq}</span>
                      {h.note && <span style={{ fontSize: 11, color: "#706d68", fontFamily: "monospace" }}>{h.note}</span>}
                    </div>
                    <div style={{ display: "flex", gap: 3, marginTop: 7 }}>
                      {(h.history || [0,0,0,0,0,0,0]).map((d, i) => (
                        <div key={i} style={{ width: 7, height: 7, borderRadius: "50%", background: i === 6 && h.tickedToday ? "#81c995" : d ? "#edbe80" : "#32323e" }} />
                      ))}
                    </div>
                  </div>
                  {h.streak > 0 && <div style={{ fontSize: 11, fontFamily: "monospace", color: "#edbe80", display: "flex", alignItems: "center", gap: 4 }}>⚡{h.streak}d</div>}
                  <div onClick={() => {
                    if (navigator.vibrate) navigator.vibrate([15, 10, 25]);
                    setHabits((prev) => prev.map((x) => {
                      if (x.id !== h.id) return x;
                      const ticked = !x.tickedToday;
                      if (ticked) addHistory("habit", `Habit done: ${x.name} — ${x.streak + 1} day streak`);
                      return { ...x, tickedToday: ticked, streak: ticked ? x.streak + 1 : Math.max(0, x.streak - 1), history: [...(x.history || [0,0,0,0,0,0,0]).slice(1), ticked ? 1 : 0] };
                    }));
                  }} style={{ width: 28, height: 28, border: `1.5px solid ${h.tickedToday ? "#81c995" : "rgba(255,255,255,0.22)"}`, borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", background: h.tickedToday ? "rgba(129,201,149,0.12)" : "none", color: "#81c995", fontSize: 13 }}>
                    {h.tickedToday ? "✓" : ""}
                  </div>
                  <button onClick={() => setHabits((prev) => prev.filter((x) => x.id !== h.id))} style={{ background: "none", border: "none", cursor: "pointer", color: "#706d68", fontSize: 12 }}>✕</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* IDEAS */}
        {tab === "ideas" && (
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ padding: "24px 36px 16px", borderBottom: "1px solid rgba(255,255,255,0.09)" }}>
              <div style={{ fontFamily: "Georgia, serif", fontSize: 26, fontStyle: "italic" }}>Ideas</div>
              <div style={{ fontSize: 11, color: "#706d68", marginTop: 4, fontFamily: "monospace" }}>parking lot — no pressure, no deadlines</div>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "20px 36px" }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                <input value={ideaInput} onChange={(e) => setIdeaInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && ideaInput.trim()) { setIdeas((prev) => [...prev, { id: Date.now().toString(), t: ideaInput.trim() }]); setIdeaInput(""); }}} placeholder="Drop an idea, no commitment..." style={{ flex: 1, background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 7, padding: "10px 14px", fontSize: 13, color: "#f2efe9", outline: "none" }} />
                <button onClick={() => { if (ideaInput.trim()) { setIdeas((prev) => [...prev, { id: Date.now().toString(), t: ideaInput.trim() }]); setIdeaInput(""); }}} style={{ background: "#8eaefb", color: "#0e0f1a", border: "none", borderRadius: 7, padding: "10px 14px", fontSize: 12, fontWeight: 500, cursor: "pointer" }}>Add</button>
              </div>
              {ideas.map((i) => (
                <div key={i.id} style={{ background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 12, padding: "11px 15px", marginBottom: 7, display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#b8a0fc", opacity: 0.8, flexShrink: 0 }} />
                  <div style={{ flex: 1, fontSize: 13, color: "#b0aca6" }}>{i.t}</div>
                  <button onClick={() => setIdeas((prev) => prev.filter((x) => x.id !== i.id))} style={{ background: "none", border: "none", cursor: "pointer", color: "#706d68", fontSize: 12 }}>✕</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* HISTORY */}
        {tab === "history" && (
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ padding: "24px 36px 16px", borderBottom: "1px solid rgba(255,255,255,0.09)" }}>
              <div style={{ fontFamily: "Georgia, serif", fontSize: 26, fontStyle: "italic" }}>History</div>
              <div style={{ fontSize: 11, color: "#706d68", marginTop: 4, fontFamily: "monospace" }}>your receipts — proof you're moving</div>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "20px 36px" }}>
              {!history.length && <div style={{ color: "#706d68", fontSize: 12, fontFamily: "monospace", textAlign: "center", padding: "28px 0" }}>no history yet</div>}
              {history.map((day, di) => (
                <div key={di} style={{ marginBottom: 22 }}>
                  <div style={{ fontSize: 11, fontFamily: "monospace", color: "#706d68", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 9 }}>{day.date}</div>
                  {day.entries.map((e, ei) => {
                    const meta = { task: { bg: "rgba(142,174,251,0.16)", color: "#8eaefb", icon: "✓" }, habit: { bg: "rgba(237,190,128,0.13)", color: "#edbe80", icon: "⚡" }, goal: { bg: "rgba(184,160,252,0.13)", color: "#b8a0fc", icon: "◎" }, skip: { bg: "#32323e", color: "#706d68", icon: "—" }, reschedule: { bg: "rgba(240,192,96,0.12)", color: "#f0c060", icon: "↻" } }[e.type] || { bg: "#32323e", color: "#706d68", icon: "•" };
                    return (
                      <div key={ei} style={{ background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 7, padding: "9px 13px", marginBottom: 5, display: "flex", alignItems: "center", gap: 9 }}>
                        <div style={{ width: 20, height: 20, borderRadius: "50%", background: meta.bg, color: meta.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, flexShrink: 0 }}>{meta.icon}</div>
                        <div style={{ flex: 1, fontSize: 12.5, color: "#b0aca6" }}>{e.text}</div>
                        <div style={{ fontSize: 10, fontFamily: "monospace", color: "#706d68" }}>{e.type}</div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* CHAT */}
        {tab === "chat" && (
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ padding: "24px 36px 16px", borderBottom: "1px solid rgba(255,255,255,0.09)" }}>
              <div style={{ fontFamily: "Georgia, serif", fontSize: 26, fontStyle: "italic" }}>Chat</div>
              <div style={{ fontSize: 11, color: "#706d68", marginTop: 4, fontFamily: "monospace" }}>think through your day with claude</div>
            </div>
            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, padding: "18px 36px" }}>
              <div style={{ maxWidth: "75%", padding: "10px 14px", borderRadius: 12, fontSize: 13, lineHeight: 1.65, background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", alignSelf: "flex-start", borderBottomLeftRadius: 3 }}>
                Hey — I know your goals, tasks, habits, and patterns. Ask me anything about your day, what to focus on, or how to rebalance.
              </div>
              {chatHistory.map((m, i) => (
                <div key={i} style={{ maxWidth: "75%", padding: "10px 14px", borderRadius: 12, fontSize: 13, lineHeight: 1.65, whiteSpace: "pre-wrap", alignSelf: m.role === "user" ? "flex-end" : "flex-start", background: m.role === "user" ? "rgba(142,174,251,0.16)" : "#22222a", border: m.role === "user" ? "1px solid rgba(142,174,251,0.28)" : "1px solid rgba(255,255,255,0.09)", borderBottomRightRadius: m.role === "user" ? 3 : 12, borderBottomLeftRadius: m.role === "user" ? 12 : 3 }}>{m.content}</div>
              ))}
              {chatLoading && <div style={{ fontSize: 12, color: "#706d68", fontFamily: "monospace", alignSelf: "flex-start" }}>thinking...</div>}
            </div>
            <div style={{ display: "flex", gap: 8, padding: "12px 36px 22px", borderTop: "1px solid rgba(255,255,255,0.09)" }}>
              <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") sendChat(); }} placeholder="What's on your mind..." style={{ flex: 1, background: "#22222a", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 7, padding: "10px 14px", fontSize: 13, color: "#f2efe9", outline: "none" }} />
              <button onClick={sendChat} disabled={chatLoading} style={{ background: "rgba(142,174,251,0.16)", border: "1px solid rgba(142,174,251,0.28)", borderRadius: 7, padding: "10px 18px", color: "#8eaefb", fontSize: 12, fontWeight: 500, cursor: "pointer" }}>Send</button>
            </div>
          </div>
        )}
      </div>

      {/* GOAL MODAL */}
      {goalModal && (
        <Modal onClose={() => setGoalModal(null)} title={goalModal.id ? "Edit goal" : "Add goal"}>
          <Field label="Goal name"><input value={goalModal.name} onChange={(e) => setGoalModal((m) => ({ ...m, name: e.target.value }))} placeholder="e.g. Land a fintech role" /></Field>
          <Field label="Life area">
            <select value={goalModal.area} onChange={(e) => setGoalModal((m) => ({ ...m, area: e.target.value }))}>
              {["Fitness","Career","Learning","Social","Finance","Health","Creative","Other"].map((a) => <option key={a}>{a}</option>)}
            </select>
          </Field>
          <Field label="Description"><textarea value={goalModal.desc} onChange={(e) => setGoalModal((m) => ({ ...m, desc: e.target.value }))} placeholder="Why this matters, what progress looks like..." /></Field>
          <Field label="Target timeframe"><input value={goalModal.deadline} onChange={(e) => setGoalModal((m) => ({ ...m, deadline: e.target.value }))} placeholder="e.g. Spring 2027" /></Field>
          <Field label="Priority">
            <div style={{ display: "flex", gap: 6 }}>
              {[["front","🔥 Front"],["maint","🔄 Maint"],["back","💤 Back"]].map(([val, label]) => (
                <button key={val} onClick={() => setGoalModal((m) => ({ ...m, p: val }))} style={{ flex: 1, padding: "8px 6px", fontSize: 11, fontFamily: "monospace", border: `1px solid ${goalModal.p === val ? "#8eaefb" : "rgba(255,255,255,0.09)"}`, borderRadius: 7, background: goalModal.p === val ? "rgba(142,174,251,0.16)" : "none", color: goalModal.p === val ? "#8eaefb" : "#706d68", cursor: "pointer" }}>{label}</button>
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

      {/* TASK MODAL */}
      {taskModal && (
        <Modal onClose={() => setTaskModal(null)} title={taskModal.id ? "Edit task" : "Add task"}>
          <Field label="Task name"><input value={taskModal.name} onChange={(e) => setTaskModal((m) => ({ ...m, name: e.target.value }))} placeholder="e.g. Register for fall classes" /></Field>
          <Field label="Due date"><input value={taskModal.due} onChange={(e) => setTaskModal((m) => ({ ...m, due: e.target.value }))} placeholder="e.g. June 15" /></Field>
          <Field label="Linked goal">
            <select value={taskModal.goal} onChange={(e) => setTaskModal((m) => ({ ...m, goal: e.target.value }))}>
              <option value="">— none —</option>
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

      {/* HABIT MODAL */}
      {habitModal && (
        <Modal onClose={() => setHabitModal(null)} title={habitModal.id ? "Edit habit" : "Add habit"}>
          <Field label="Habit name"><input value={habitModal.name} onChange={(e) => setHabitModal((m) => ({ ...m, name: e.target.value }))} placeholder="e.g. 200g protein" /></Field>
          <Field label="Frequency">
            <select value={habitModal.freq} onChange={(e) => setHabitModal((m) => ({ ...m, freq: e.target.value }))}>
              <option value="daily">Every day</option>
              <option value="weekdays">Weekdays only</option>
              <option value="3x">3× per week</option>
              <option value="weekly">Once a week</option>
            </select>
          </Field>
          <Field label="Note (optional)"><input value={habitModal.note} onChange={(e) => setHabitModal((m) => ({ ...m, note: e.target.value }))} placeholder="e.g. spread across 4 meals" /></Field>
          <ModalActions onCancel={() => setHabitModal(null)} onSave={() => {
            if (!habitModal.name.trim()) return;
            const h = { ...habitModal, id: habitModal.id || Date.now().toString(), streak: habitModal.streak || 0, history: habitModal.history || [0,0,0,0,0,0,0], tickedToday: habitModal.tickedToday || false };
            setHabits((prev) => habitModal.id ? prev.map((x) => x.id === h.id ? h : x) : [...prev, h]);
            setHabitModal(null);
          }} />
        </Modal>
      )}

      {/* RESCHEDULE MODAL */}
      {rescheduleModal && (
        <Modal onClose={() => setRescheduleModal(null)} title="Reschedule block">
          <Field label="What came up?"><textarea value={rescheduleReason} onChange={(e) => setRescheduleReason(e.target.value)} placeholder="e.g. Meeting ran long..." /></Field>
          <Field label="Move to when?"><input value={rescheduleTime} onChange={(e) => setRescheduleTime(e.target.value)} placeholder="e.g. 6pm, tomorrow morning" /></Field>
          <ModalActions onCancel={() => setRescheduleModal(null)} onSave={confirmReschedule} saveLabel="Reschedule" />
        </Modal>
      )}
    </div>
  );
}

function PlanBlock({ block, onToggle, onSkip, onReschedule, skipCount = 0 }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isSkipped = block.status === "skipped";
  const isRescheduled = block.status === "rescheduled";
  return (
    <div style={{ display: "flex", alignItems: "flex-start", borderBottom: "1px solid rgba(255,255,255,0.09)", opacity: block.done || isSkipped ? 0.32 : 1, background: block.done || isSkipped ? "transparent" : undefined, position: "relative" }}>
      <div style={{ width: 50, flexShrink: 0, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 19 }}>
        <div onClick={() => !isSkipped && onToggle(block.id)} style={{ width: 18, height: 18, border: `1.5px solid ${block.done ? "#81c995" : "rgba(255,255,255,0.22)"}`, borderRadius: "50%", cursor: isSkipped ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", background: block.done ? "#81c995" : "none", flexShrink: 0 }}>
          {block.done && <div style={{ width: 8, height: 5, borderLeft: "2px solid #0e1a11", borderBottom: "2px solid #0e1a11", transform: "rotate(-45deg) translateY(-1px)" }} />}
        </div>
      </div>
      <div style={{ flex: 1, padding: "15px 6px 15px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
          <div style={{ fontSize: 11, fontFamily: "monospace", color: "#8eaefb", letterSpacing: "0.02em" }}>{block.time}{isRescheduled && block.newTime ? " → " + block.newTime : ""}</div>
          <ImpDots imp={block.imp || 2} />
        </div>
        <div style={{ fontSize: 14, fontWeight: 500, color: block.done || isSkipped ? "#706d68" : "#f2efe9", textDecoration: block.done || isSkipped ? "line-through" : "none", marginBottom: 3 }}>{block.title}</div>
        <div style={{ fontSize: 12.5, color: "#b0aca6", lineHeight: 1.6 }}>{block.desc}</div>
        <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap" }}>
          {block.done && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#81c995", background: "rgba(129,201,149,0.12)", padding: "2px 8px", borderRadius: 99 }}>completed</span>}
          {isSkipped && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#706d68", background: "#32323e", padding: "2px 8px", borderRadius: 99 }}>skipped</span>}
          {isRescheduled && !block.done && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#f0c060", background: "rgba(240,192,96,0.12)", padding: "2px 8px", borderRadius: 99 }}>rescheduled</span>}
          {skipCount >= 2 && !block.done && !isSkipped && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#f28b82", background: "rgba(242,139,130,0.12)", padding: "2px 8px", borderRadius: 99 }}>skipped {skipCount}× recently</span>}
        </div>
      </div>
      {!block.done && !isSkipped && (
        <div style={{ width: 34, flexShrink: 0, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 14, position: "relative" }}>
          <button onClick={() => setMenuOpen((o) => !o)} style={{ background: "none", border: "none", cursor: "pointer", color: "#706d68", fontSize: 15, padding: 4, borderRadius: 4 }}>···</button>
          {menuOpen && (
            <div style={{ position: "absolute", right: 6, top: 34, background: "#2a2a34", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 7, zIndex: 50, minWidth: 150, overflow: "hidden", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
              <button onClick={() => { onSkip(block.id); setMenuOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 13px", fontSize: 12, cursor: "pointer", color: "#b0aca6", background: "none", border: "none", width: "100%", textAlign: "left" }}>✕ Skip</button>
              <button onClick={() => { onReschedule(block.id); setMenuOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 13px", fontSize: 12, cursor: "pointer", color: "#b0aca6", background: "none", border: "none", width: "100%", textAlign: "left" }}>↻ Reschedule</button>
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
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            {task.due && <span style={{ fontSize: 11, fontFamily: "monospace", color: "#706d68" }}>Due: {task.due}</span>}
            {task.goal && <span style={{ fontSize: 11, fontFamily: "monospace", color: "#706d68" }}>↳ {task.goal}</span>}
          </div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <ImpDots imp={task.imp || 1} />
        <button onClick={(e) => { e.stopPropagation(); onDelete(task.id); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#706d68", fontSize: 12 }}>✕</button>
      </div>
    </div>
  );
}

function Modal({ children, onClose, title }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, backdropFilter: "blur(2px)" }} onClick={onClose}>
      <div style={{ background: "#22222a", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 12, padding: 26, width: 430, maxWidth: "calc(100vw - 32px)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontFamily: "Georgia, serif", fontSize: 18, fontStyle: "italic", color: "#f2efe9", marginBottom: 18 }}>{title}</div>
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