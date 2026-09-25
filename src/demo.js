// Demo mode. Visiting /?demo (or /demo) loads a seeded example week with no
// sign-in, so someone following a link from a resume sees the app working
// instead of a login wall.
//
// It is deliberately read-only against everything real: load() reads from here
// instead of localStorage, save() becomes a no-op, and the effects that talk to
// Supabase, the connector queue and the snapshot mirror all bail out. Opening
// the demo link on your own phone therefore cannot touch your own data.

export const IS_DEMO =
  typeof window !== "undefined" &&
  (new URLSearchParams(window.location.search).has("demo") || window.location.pathname.replace(/\/$/, "") === "/demo");

const iso = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const pretty = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
};

const goals = [
  {
    id: "d-g1",
    name: "Land a Sales Engineering internship",
    area: "Career",
    desc: "Fintech or SaaS. Target list built, three warm intros in progress.",
    deadline: "by December",
    p: "front",
  },
  {
    id: "d-g2",
    name: "Ship Locus v2",
    area: "Creative",
    desc: "Backend as source of truth, then adaptive replanning that learns from skips.",
    deadline: "end of semester",
    p: "front",
  },
  {
    id: "d-g3",
    name: "Salesforce Admin certification",
    area: "Career",
    desc: "Trailhead modules on weekends, exam booked once I clear the practice set.",
    deadline: "by November",
    p: "front",
  },
  {
    id: "d-g4",
    name: "Graduate with a high GPA",
    area: "Learning",
    desc: "Accounting and CS coursework both stay above the line.",
    deadline: "Spring 2027",
    p: "maint",
  },
  {
    id: "d-g5",
    name: "Train consistently",
    area: "Health",
    desc: "Five lifting sessions a week, protein hit daily, sleep before midnight.",
    deadline: "",
    p: "maint",
  },
];

const tasks = [
  { id: "d-t1", name: "CS 218 lab 4 writeup", due: "tomorrow", goal: "Graduate with a high GPA", imp: 3, done: false },
  { id: "d-t2", name: "Prep Thursday accounting tutoring session", due: "Thursday", goal: "Graduate with a high GPA", imp: 2, done: false },
  { id: "d-t3", name: "Follow up with the SE contact from the career fair", due: "Friday", goal: "Land a Sales Engineering internship", imp: 3, done: false },
  { id: "d-t4", name: "Rewrite resume bullet for Locus", due: "this week", goal: "Land a Sales Engineering internship", imp: 2, done: true },
  { id: "d-t5", name: "Trailhead: Data Modeling superbadge", due: "Sunday", goal: "Salesforce Admin certification", imp: 2, done: false },
  { id: "d-t6", name: "Weekly trade memo for the StockTrak competition", due: "Friday", goal: "", imp: 2, done: false },
  { id: "d-t7", name: "Read the Postgres row-level-security docs", due: "", goal: "Ship Locus v2", imp: 1, done: true },
  { id: "d-t8", name: "Add per-item timestamps so two devices can merge", due: "next week", goal: "Ship Locus v2", imp: 2, done: false },
];

const habits = [
  { id: "d-h1", name: "Lift", freq: "5x a week", note: "upper/lower split", streak: 11, tickedToday: false, lastTicked: iso(-1), week: [1, 1, 0, 1, 1, 1, 0] },
  { id: "d-h2", name: "Read 20 pages", freq: "daily", note: "", streak: 24, tickedToday: true, lastTicked: iso(0), week: [1, 1, 1, 1, 1, 1, 1] },
  { id: "d-h3", name: "Mental math drills", freq: "daily", note: "10 min soroban", streak: 6, tickedToday: false, lastTicked: iso(-1), week: [1, 1, 1, 0, 1, 1, 0] },
  { id: "d-h4", name: "Anki review", freq: "weekdays", note: "accounting deck", streak: 3, tickedToday: false, lastTicked: iso(-1), week: [0, 1, 1, 1, 0, 0, 1] },
];

const ideas = [
  { id: "d-i1", t: "Newsletter for campus founders - one build log a week" },
  { id: "d-i2", t: "Score every warm intro by how many hops it takes to reach a hiring manager" },
  { id: "d-i3", t: "Give Locus a probability that a goal actually lands, updated from how often I skip its blocks" },
  { id: "d-i4", t: "Soroban trainer that draws the bead movement instead of just checking the answer" },
  { id: "d-i5", t: "Barcode scanning for the meal tracker so logging takes five seconds" },
  { id: "d-i6", t: "Ask the planner to defend its schedule, then argue with it" },
];

// Fixed weekly commitments - these place themselves on any matching day.
const commitments = [
  { id: "d-c-fin", label: "FIN 445 lecture", kind: "class", days: [1, 3, 5], start: "13:00", end: "13:50", note: "Gatton 191" },
  { id: "d-c-tut", label: "Tutoring shift", kind: "work", days: [2, 4], start: "14:00", end: "18:00", note: "" },
  { id: "d-c-gym", label: "Lift", kind: "gym", days: [1, 3, 5, 6, 0], start: "10:15", end: "12:00", note: "" },
  { id: "d-c-chap", label: "Chapter meeting", kind: "other", days: [2], start: "19:00", end: "20:00", note: "every other week" },
];

const todayPlan = [
  { id: "d-b1", time: "7:30 AM", duration: "60 min", title: "Lift - upper body", desc: "Push day, then protein shake", imp: 2, done: true },
  { id: "d-b2", time: "9:00 AM", duration: "75 min", title: "CS 218 lecture", desc: "Process scheduling and signals", imp: 2, done: true },
  { id: "d-b3", time: "10:30 AM", duration: "20 min", title: "Break", desc: "Walk, no phone", imp: 1, done: true },
  { id: "d-b4", time: "11:00 AM", duration: "90 min", title: "CS 218 lab 4 writeup", desc: "Due tomorrow - finish the fork/exec section", imp: 3, done: false },
  { id: "d-b5", time: "12:45 PM", duration: "45 min", title: "Lunch", desc: "Refuel", imp: 1, done: false },
  { id: "d-b6", time: "1:30 PM", duration: "60 min", title: "Accounting tutoring", desc: "Two students, revenue recognition", imp: 2, done: false },
  { id: "d-b7", time: "3:00 PM", duration: "60 min", title: "Internship search", desc: "Two applications, follow up with the career-fair contact", imp: 3, done: false },
  { id: "d-b8", time: "4:15 PM", duration: "75 min", title: "Locus v2 - merge logic", desc: "Per-item timestamps so the phone and laptop stop fighting", imp: 3, done: false },
  { id: "d-b9", time: "6:00 PM", duration: "45 min", title: "Dinner", desc: "", imp: 1, done: false },
  { id: "d-b10", time: "7:00 PM", duration: "40 min", title: "Trailhead", desc: "Data modeling module", imp: 2, done: false },
  { id: "d-b11", time: "8:30 PM", duration: "20 min", title: "Review & plan tomorrow", desc: "What moved, what slipped, what tomorrow actually needs", imp: 2, done: false },
];

const tomorrowPlan = [
  { id: "d-c1", time: "8:00 AM", duration: "60 min", title: "Lift - lower body", desc: "", imp: 2, phase: "Morning" },
  { id: "d-c2", time: "9:30 AM", duration: "50 min", title: "Hand in CS 218 lab 4", desc: "Submit before the 10am cutoff", imp: 3, phase: "Morning" },
  { id: "d-c3", time: "11:00 AM", duration: "90 min", title: "ACC 301 problem set", desc: "Chapter 8, leases", imp: 2, phase: "Morning" },
  { id: "d-c4", time: "2:00 PM", duration: "45 min", title: "Coffee with the SE contact", desc: "Ask what their demo interview actually looks like", imp: 3, phase: "Afternoon" },
  { id: "d-c5", time: "4:00 PM", duration: "60 min", title: "StockTrak trade memo", desc: "Thesis and sizing for two positions", imp: 2, phase: "Afternoon" },
];

const archive = {
  [iso(-1)]: [
    { id: "d-y1", time: "8:00 AM", duration: "60 min", title: "Lift - lower body", desc: "", imp: 2, done: true },
    { id: "d-y2", time: "9:30 AM", duration: "90 min", title: "ACC 301 problem set", desc: "Chapter 7", imp: 2, done: true },
    { id: "d-y3", time: "1:00 PM", duration: "60 min", title: "Internship search", desc: "Three applications", imp: 3, done: true },
    { id: "d-y4", time: "3:30 PM", duration: "75 min", title: "Locus v2 - Supabase schema", desc: "Tables and row-level security", imp: 3, done: true },
    { id: "d-y5", time: "7:00 PM", duration: "40 min", title: "Mental math drills", desc: "", imp: 1, status: "skipped", skipReason: "ran long on the schema" },
  ],
  [iso(-2)]: [
    { id: "d-x1", time: "9:00 AM", duration: "75 min", title: "CS 218 lecture", desc: "", imp: 2, done: true },
    { id: "d-x2", time: "11:00 AM", duration: "60 min", title: "Accounting tutoring", desc: "Three students", imp: 2, done: true },
    { id: "d-x3", time: "2:00 PM", duration: "90 min", title: "Trailhead", desc: "Two modules", imp: 2, done: true },
    { id: "d-x4", time: "5:00 PM", duration: "60 min", title: "Lift - push", desc: "", imp: 2, done: true },
  ],
  [iso(-3)]: [
    { id: "d-w1", time: "8:30 AM", duration: "90 min", title: "FIN reading", desc: "Fixed income chapter", imp: 2, done: true },
    { id: "d-w2", time: "1:00 PM", duration: "75 min", title: "Locus v2 - UI rebuild", desc: "Timeline rows and the mobile layout", imp: 3, done: true },
    { id: "d-w3", time: "4:00 PM", duration: "45 min", title: "Internship search", desc: "", imp: 3, status: "skipped", skipReason: "tutoring session ran over" },
  ],
  [iso(-4)]: [
    { id: "d-v1", time: "9:00 AM", duration: "60 min", title: "Lift - pull", desc: "", imp: 2, done: true },
    { id: "d-v2", time: "11:00 AM", duration: "120 min", title: "Mock demo practice", desc: "Whiteboard the Locus architecture out loud", imp: 3, done: true },
    { id: "d-v3", time: "3:00 PM", duration: "60 min", title: "StockTrak review", desc: "Closed the energy position", imp: 2, done: true },
  ],
};

const history = [
  {
    date: pretty(-1),
    key: iso(-1),
    entries: [
      { type: "task", text: "Finished: Read the Postgres row-level-security docs", time: "4:42 PM" },
      { type: "habit", text: "Lift - 11 day streak", time: "8:55 AM" },
      { type: "block", text: "Completed: Locus v2 - Supabase schema", time: "4:45 PM" },
      { type: "reschedule", text: "Moved Mental math drills - ran long on the schema", time: "7:05 PM" },
    ],
  },
  {
    date: pretty(-2),
    key: iso(-2),
    entries: [
      { type: "task", text: "Finished: Rewrite resume bullet for Locus", time: "6:20 PM" },
      { type: "habit", text: "Read 20 pages - 22 day streak", time: "10:15 PM" },
      { type: "block", text: "Completed: Accounting tutoring", time: "12:05 PM" },
    ],
  },
  {
    date: pretty(-3),
    key: iso(-3),
    entries: [
      { type: "block", text: "Completed: Locus v2 - UI rebuild", time: "2:20 PM" },
      { type: "reschedule", text: "Moved Internship search - tutoring session ran over", time: "4:10 PM" },
    ],
  },
];

// The learned side of the app: what gets skipped, how long things really take,
// and the notes it keeps about how the week is going.
const skipPatterns = { "Mental math drills": 2, "Internship search": 1 };

const timestamps = {
  "CS 218 lab 4 writeup": { runs: 6, avg: 104 },
  "Internship search": { runs: 9, avg: 47 },
  "Lift - upper body": { runs: 14, avg: 63 },
  "Accounting tutoring": { runs: 11, avg: 58 },
};

const context = [
  { date: "Sep 18", text: "Evening blocks after 8pm get skipped more often than any other slot." },
  { date: "Sep 20", text: "Internship search consistently takes about 45 minutes, not the 60 it gets scheduled for." },
  { date: "Sep 21", text: "Lab writeups run 15% over their estimate - budget accordingly the week something is due." },
  { date: "Sep 23", text: "Tutoring on Tuesdays tends to overrun and eats the block right after it." },
];

// Keyed by the same localStorage keys the app already uses, so demo mode is a
// one-line change inside load() rather than a special case at every call site.
export const DEMO_STATE = {
  "locus-goals": goals,
  "locus-tasks": tasks,
  "locus-habits": habits,
  "locus-ideas": ideas,
  "locus-commitments": commitments,
  "locus-fixed-dismissed": {},
  "locus-today-plan": todayPlan,
  "locus-tomorrow-plan": tomorrowPlan,
  "locus-tomorrow-date": iso(1),
  "locus-plan-archive": archive,
  "locus-history": history,
  "locus-skip-patterns": skipPatterns,
  "locus-timestamps": timestamps,
  "locus-context": context,
  "locus-last-open": iso(0),
};
