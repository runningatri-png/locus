// Supabase is the source of truth for Locus's data. localStorage stays as an
// offline cache and first-run seed, but whatever is in Postgres wins.
//
// The URL and publishable key below are meant to be public - they identify the
// project, they don't grant access. Every table has row-level security keyed to
// auth.uid(), so a signed-out client (or someone else's account) reads nothing.
import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  "https://acgwejjquchbspoibssm.supabase.co",
  "sb_publishable_xcDfWVy91h0mTevOrOEwVQ_S4MEZGu3",
  { auth: { persistSession: true, autoRefreshToken: true, storageKey: "locus-auth" } }
);

// Item ids stay client-generated, so a row and its in-app object share an id.
// Only the column names differ ("desc" is reserved in SQL, hence descr).
const MAPPERS = {
  goals: {
    toRow: (g) => ({
      id: g.id,
      name: g.name || "",
      area: g.area || "",
      descr: g.desc || "",
      deadline: g.deadline || "",
      p: g.p || "front",
    }),
    toApp: (r) => ({ id: r.id, name: r.name, area: r.area, desc: r.descr, deadline: r.deadline, p: r.p }),
  },
  tasks: {
    toRow: (t) => ({
      id: t.id,
      name: t.name || "",
      due: t.due || "",
      goal: t.goal || "",
      imp: t.imp ?? 2,
      done: !!t.done,
    }),
    toApp: (r) => ({ id: r.id, name: r.name, due: r.due, goal: r.goal, imp: r.imp, done: r.done }),
  },
  habits: {
    toRow: (h) => ({
      id: h.id,
      name: h.name || "",
      freq: h.freq || "",
      note: h.note || "",
      streak: h.streak || 0,
      ticked_today: !!h.tickedToday,
      last_ticked: h.lastTicked || null,
      week: Array.isArray(h.week) ? h.week : [0, 0, 0, 0, 0, 0, 0],
    }),
    toApp: (r) => ({
      id: r.id,
      name: r.name,
      freq: r.freq,
      note: r.note,
      streak: r.streak,
      tickedToday: r.ticked_today,
      lastTicked: r.last_ticked || "",
      week: r.week,
    }),
  },
  ideas: {
    toRow: (i) => ({ id: i.id, t: i.t || "" }),
    toApp: (r) => ({ id: r.id, t: r.t }),
  },
  commitments: {
    toRow: (c) => ({
      id: c.id,
      label: c.label || "",
      kind: c.kind || "other",
      days: Array.isArray(c.days) ? c.days : [],
      start_time: c.start || "",
      end_time: c.end || "",
      note: c.note || "",
    }),
    toApp: (r) => ({
      id: r.id,
      label: r.label,
      kind: r.kind,
      days: r.days || [],
      start: r.start_time || "",
      end: r.end_time || "",
      note: r.note || "",
    }),
  },
};

export const ITEM_TABLES = Object.keys(MAPPERS);

/** Everything the app needs, in one round trip per table. */
export async function pullAll() {
  const [goals, tasks, habits, ideas, commitments, days, docs] = await Promise.all([
    supabase.from("goals").select("*"),
    supabase.from("tasks").select("*"),
    supabase.from("habits").select("*"),
    supabase.from("ideas").select("*"),
    supabase.from("commitments").select("*"),
    supabase.from("plan_days").select("*"),
    supabase.from("docs").select("*"),
  ]);

  const err = [goals, tasks, habits, ideas, commitments, days, docs].find((r) => r.error);
  if (err) throw err.error;

  const planArchive = {};
  for (const row of days.data) planArchive[row.day] = row.blocks || [];

  const doc = {};
  for (const row of docs.data) doc[row.key] = row.value;

  return {
    goals: goals.data.map(MAPPERS.goals.toApp),
    tasks: tasks.data.map(MAPPERS.tasks.toApp),
    habits: habits.data.map(MAPPERS.habits.toApp),
    ideas: ideas.data.map(MAPPERS.ideas.toApp),
    commitments: commitments.data.map(MAPPERS.commitments.toApp),
    planArchive,
    history: doc.history || [],
    skipPatterns: doc.skipPatterns || {},
    timestamps: doc.timestamps || {},
    context: doc.context || [],
    fixedDismissed: doc.fixedDismissed || {},
  };
}

/**
 * Make the table match the array: upsert everything present, delete what is
 * gone. Whole-array writes are wasteful in theory and irrelevant at this size
 * (tens of rows), and they make deletion correct without tracking diffs.
 */
export async function pushItems(table, items, userId) {
  const mapper = MAPPERS[table];
  const rows = items.map((i) => ({ ...mapper.toRow(i), user_id: userId, updated_at: new Date().toISOString() }));

  if (rows.length) {
    const { error } = await supabase.from(table).upsert(rows, { onConflict: "user_id,id" });
    if (error) throw error;
  }

  const keep = items.map((i) => i.id);
  let del = supabase.from(table).delete().eq("user_id", userId);
  if (keep.length) del = del.not("id", "in", `(${keep.map((k) => `"${k}"`).join(",")})`);
  const { error } = await del;
  if (error) throw error;
}

export async function pushPlanDay(day, blocks, userId) {
  const { error } = await supabase
    .from("plan_days")
    .upsert({ user_id: userId, day, blocks, updated_at: new Date().toISOString() }, { onConflict: "user_id,day" });
  if (error) throw error;
}

export async function pushDoc(key, value, userId) {
  const { error } = await supabase
    .from("docs")
    .upsert({ user_id: userId, key, value, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" });
  if (error) throw error;
}

export function isEmptyState(s) {
  return !(
    (s.goals || []).length ||
    (s.tasks || []).length ||
    (s.habits || []).length ||
    (s.ideas || []).length ||
    (s.commitments || []).length ||
    Object.keys(s.planArchive || {}).length
  );
}
