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
    name: "Land a new job in product design",
    area: "Career",
    desc: "Portfolio refreshed, ten target companies, two referrals in progress.",
    deadline: "by January",
    p: "front",
  },
  {
    id: "d-g2",
    name: "Launch the recipe-sharing side project",
    area: "Creative",
    desc: "Get a working beta in front of ten friends, then iterate on what they actually use.",
    deadline: "end of the year",
    p: "front",
  },
  {
    id: "d-g3",
    name: "Run a half marathon",
    area: "Health",
    desc: "Twelve-week plan, three runs a week, long run on Saturdays.",
    deadline: "race day in March",
    p: "front",
  },
  {
    id: "d-g4",
    name: "Hold a conversation in Spanish",
    area: "Learning",
    desc: "Evening class twice a week plus daily practice.",
    deadline: "before the summer trip",
    p: "maint",
  },
  {
    id: "d-g5",
    name: "Keep the basics steady",
    area: "Health",
    desc: "Sleep by 11, cook most dinners, one screen-free evening a week.",
    deadline: "",
    p: "maint",
  },
];

const tasks = [
  { id: "d-t1", name: "Finish portfolio case study #2", due: "tomorrow", goal: "Land a new job in product design", imp: 3, done: false },
  { id: "d-t2", name: "Prep for Thursday's recruiter call", due: "Thursday", goal: "Land a new job in product design", imp: 3, done: false },
  { id: "d-t3", name: "Thank-you note to the referral contact", due: "Friday", goal: "Land a new job in product design", imp: 2, done: false },
  { id: "d-t4", name: "Update resume headline", due: "this week", goal: "Land a new job in product design", imp: 2, done: true },
  { id: "d-t5", name: "Sketch the recipe upload flow", due: "Sunday", goal: "Launch the recipe-sharing side project", imp: 2, done: false },
  { id: "d-t6", name: "Book a dentist appointment", due: "Friday", goal: "", imp: 1, done: false },
  { id: "d-t7", name: "Pick a hosting provider for the beta", due: "", goal: "Launch the recipe-sharing side project", imp: 1, done: true },
  { id: "d-t8", name: "Write the beta invite email", due: "next week", goal: "Launch the recipe-sharing side project", imp: 2, done: false },
];

const habits = [
  { id: "d-h1", name: "Run", freq: "3x a week", note: "easy pace, long run Saturday", days: [2, 4, 6], start: "07:00", end: "08:00", streak: 9, tickedToday: false, lastTicked: iso(-1), week: [1, 0, 1, 0, 1, 1, 0] },
  { id: "d-h2", name: "Read 20 pages", freq: "daily", note: "", days: [], start: "", end: "", streak: 17, tickedToday: true, lastTicked: iso(0), week: [1, 1, 1, 1, 1, 1, 1] },
  { id: "d-h3", name: "Spanish practice", freq: "daily", note: "15 min flashcards", days: [], start: "", end: "", streak: 5, tickedToday: false, lastTicked: iso(-1), week: [1, 1, 1, 0, 1, 1, 0] },
  { id: "d-h4", name: "Stretch", freq: "weekdays", note: "10 min after work", days: [1, 2, 3, 4, 5], start: "", end: "", streak: 3, tickedToday: false, lastTicked: iso(-1), week: [0, 1, 1, 1, 0, 0, 1] },
  // Added through the connector, so the day lives in freq rather than days -
  // the shape that used to leak onto every weekday.
  { id: "d-h5", name: "Grocery run", freq: "Sunday", note: "", days: [], start: "", end: "", streak: 2, tickedToday: false, lastTicked: iso(-8), week: [0, 0, 0, 0, 0, 0, 0] },
];

const ideas = [
  { id: "d-i1", t: "Monthly dinner club with friends - everyone brings one new recipe" },
  { id: "d-i2", t: "Turn the job search into a tracker that shows which channel actually gets replies" },
  { id: "d-i3", t: "Let the recipe app scale ingredients by how many people are coming" },
  { id: "d-i4", t: "Plan a running route that ends at the farmers market" },
  { id: "d-i5", t: "Write a short post about redesigning my own portfolio" },
  { id: "d-i6", t: "Ask the planner to defend its schedule, then argue with it" },
];

// Fixed weekly commitments - these place themselves on any matching day.
const commitments = [
  { id: "d-c-work", label: "Work", kind: "work", days: [1, 2, 3, 4, 5], start: "09:00", end: "12:30", note: "" },
  { id: "d-c-spa", label: "Spanish class", kind: "class", days: [2, 4], start: "18:30", end: "19:30", note: "community center" },
  { id: "d-c-vol", label: "Volunteer shift", kind: "other", days: [6], start: "10:00", end: "12:00", note: "food bank" },
];

const todayPlan = [
  { id: "d-b2", time: "9:00 AM", duration: "180 min", title: "Work", desc: "Design review in the morning", imp: 2, done: true },
  { id: "d-b3", time: "12:30 PM", duration: "45 min", title: "Lunch", desc: "Walk, no phone", imp: 1, done: true },
  { id: "d-b4", time: "1:30 PM", duration: "90 min", title: "Portfolio case study #2", desc: "Due tomorrow - finish the research section", imp: 3, done: false },
  { id: "d-b5", time: "3:15 PM", duration: "20 min", title: "Break", desc: "Refuel", imp: 1, done: false },
  { id: "d-b6", time: "3:45 PM", duration: "60 min", title: "Job search", desc: "Two applications, follow up with the referral", imp: 3, done: false },
  { id: "d-b7", time: "5:00 PM", duration: "75 min", title: "Recipe app - upload flow", desc: "Sketch the three screens for adding a recipe", imp: 2, done: false },
  { id: "d-b8", time: "6:30 PM", duration: "45 min", title: "Cook dinner", desc: "", imp: 1, done: false },
  { id: "d-b9", time: "7:30 PM", duration: "20 min", title: "Spanish practice", desc: "Flashcards", imp: 2, done: false },
  { id: "d-b10", time: "8:30 PM", duration: "20 min", title: "Review & plan tomorrow", desc: "What moved, what slipped, what tomorrow actually needs", imp: 2, done: false },
];

const tomorrowPlan = [
  { id: "d-c1", time: "7:00 AM", duration: "45 min", title: "Run - easy 5k", desc: "", imp: 2, phase: "Morning" },
  { id: "d-c2", time: "9:00 AM", duration: "180 min", title: "Work", desc: "", imp: 2, phase: "Morning" },
  { id: "d-c3", time: "1:00 PM", duration: "30 min", title: "Send portfolio case study #2", desc: "Final proofread, then share the link", imp: 3, phase: "Afternoon" },
  { id: "d-c4", time: "2:00 PM", duration: "45 min", title: "Prep recruiter call", desc: "Three stories, two questions to ask them", imp: 3, phase: "Afternoon" },
  { id: "d-c5", time: "4:00 PM", duration: "60 min", title: "Beta invite email", desc: "Draft and pick the first ten people", imp: 2, phase: "Afternoon" },
];

const archive = {
  [iso(-1)]: [
    { id: "d-y1", time: "7:00 AM", duration: "45 min", title: "Run - intervals", desc: "", imp: 2, done: true },
    { id: "d-y2", time: "1:30 PM", duration: "90 min", title: "Portfolio case study #2", desc: "Wireframes", imp: 3, done: true },
    { id: "d-y3", time: "3:30 PM", duration: "60 min", title: "Job search", desc: "Three applications", imp: 3, done: true },
    { id: "d-y4", time: "5:00 PM", duration: "75 min", title: "Recipe app - hosting setup", desc: "Picked a provider and deployed a test page", imp: 2, done: true },
    { id: "d-y5", time: "8:00 PM", duration: "20 min", title: "Spanish practice", desc: "", imp: 1, status: "skipped", skipReason: "ran long on the deploy" },
  ],
  [iso(-2)]: [
    { id: "d-x1", time: "9:00 AM", duration: "180 min", title: "Work", desc: "", imp: 2, done: true },
    { id: "d-x2", time: "1:30 PM", duration: "60 min", title: "Coffee with a referral contact", desc: "", imp: 3, done: true },
    { id: "d-x3", time: "6:30 PM", duration: "60 min", title: "Spanish class", desc: "", imp: 2, done: true },
  ],
  [iso(-3)]: [
    { id: "d-w1", time: "8:30 AM", duration: "60 min", title: "Reading", desc: "Design book, two chapters", imp: 1, done: true },
    { id: "d-w2", time: "1:00 PM", duration: "75 min", title: "Portfolio case study #2", desc: "Interview notes", imp: 3, done: true },
    { id: "d-w3", time: "4:00 PM", duration: "45 min", title: "Job search", desc: "", imp: 3, status: "skipped", skipReason: "meeting at work ran over" },
  ],
  [iso(-4)]: [
    { id: "d-v1", time: "8:00 AM", duration: "90 min", title: "Run - long run", desc: "8 miles", imp: 2, done: true },
    { id: "d-v2", time: "10:00 AM", duration: "120 min", title: "Volunteer shift", desc: "", imp: 2, done: true },
    { id: "d-v3", time: "3:00 PM", duration: "60 min", title: "Meal prep", desc: "Three dinners for the week", imp: 1, done: true },
  ],
};

const history = [
  {
    date: pretty(-1),
    key: iso(-1),
    entries: [
      { type: "task", text: "Finished: Pick a hosting provider for the beta", time: "6:10 PM" },
      { type: "habit", text: "Run - 9 day streak", time: "7:50 AM" },
      { type: "block", text: "Completed: Recipe app - hosting setup", time: "6:15 PM" },
      { type: "reschedule", text: "Moved Spanish practice - ran long on the deploy", time: "8:05 PM" },
    ],
  },
  {
    date: pretty(-2),
    key: iso(-2),
    entries: [
      { type: "task", text: "Finished: Update resume headline", time: "5:20 PM" },
      { type: "habit", text: "Read 20 pages - 15 day streak", time: "10:15 PM" },
      { type: "block", text: "Completed: Coffee with a referral contact", time: "2:35 PM" },
    ],
  },
  {
    date: pretty(-3),
    key: iso(-3),
    entries: [
      { type: "block", text: "Completed: Portfolio case study #2", time: "2:20 PM" },
      { type: "reschedule", text: "Moved Job search - meeting at work ran over", time: "4:10 PM" },
    ],
  },
];

// The learned side of the app: what gets skipped, how long things really take,
// and the notes it keeps about how the week is going.
const skipPatterns = { "Spanish practice": 2, "Job search": 1 };

const timestamps = {
  "Portfolio case study #2": { runs: 6, avg: 104 },
  "Job search": { runs: 9, avg: 47 },
  "Run - easy 5k": { runs: 14, avg: 38 },
  "Cook dinner": { runs: 11, avg: 52 },
};

const context = [
  { date: pretty(-12).split(", ")[1], text: "Evening blocks after 8pm get skipped more often than any other slot." },
  { date: pretty(-10).split(", ")[1], text: "Job search consistently takes about 45 minutes, not the 60 it gets scheduled for." },
  { date: pretty(-8).split(", ")[1], text: "Portfolio work runs about 15% over its estimate - budget accordingly near a deadline." },
  { date: pretty(-6).split(", ")[1], text: "Work meetings on Wednesdays tend to overrun and eat the block right after." },
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
