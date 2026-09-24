// Adds demo mode to src/App.jsx. Run once from the repo root:
//
//   node apply-demo.mjs
//
// It checks every edit point before changing anything, so either all eight
// edits land or the file is left exactly as it was. Nothing is deleted, and
// `git checkout src/App.jsx` undoes it entirely.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const APP = "src/App.jsx";

if (!existsSync(APP)) {
  console.error(`Can't find ${APP}. Run this from the repo root (cd ~/Desktop/locus).`);
  process.exit(1);
}
if (!existsSync("src/demo.js")) {
  console.error("Can't find src/demo.js. Save that file into src/ first, then re-run.");
  process.exit(1);
}

let src = readFileSync(APP, "utf8");

if (src.includes('from "./demo"')) {
  console.log("Demo mode is already applied - nothing to do.");
  process.exit(0);
}

const edits = [
  {
    what: "import demo module",
    find: 'import { supabase, pullAll, pushItems, pushPlanDay, pushDoc, isEmptyState } from "./db";',
    replace:
      'import { supabase, pullAll, pushItems, pushPlanDay, pushDoc, isEmptyState } from "./db";\nimport { IS_DEMO, DEMO_STATE } from "./demo";',
  },
  {
    what: "read seeded data instead of localStorage",
    find: "function load(key, fallback) {\n  try {",
    replace: "function load(key, fallback) {\n  if (IS_DEMO) return DEMO_STATE[key] ?? fallback;\n  try {",
  },
  {
    what: "never write to localStorage in demo",
    find: "function save(key, val) {\n  try {",
    replace: "function save(key, val) {\n  if (IS_DEMO) return;\n  try {",
  },
  {
    what: "skip the sign-in wall",
    find:
      '  if (!authReady) {\n    return <div className={"app" + (theme === "dark" ? " dark" : "")} />;\n  }\n  if (!session) {\n    return <SignIn theme={theme} />;\n  }',
    replace:
      '  if (!authReady && !IS_DEMO) {\n    return <div className={"app" + (theme === "dark" ? " dark" : "")} />;\n  }\n  if (!session && !IS_DEMO) {\n    return <SignIn theme={theme} />;\n  }',
  },
  {
    what: "don't drain the connector queue in demo",
    find: "  useEffect(() => {\n    if (inboxDrainedRef.current) return;",
    replace: "  useEffect(() => {\n    if (IS_DEMO) return;\n    if (inboxDrainedRef.current) return;",
  },
  {
    what: "don't overwrite the connector snapshot with demo data",
    find:
      "    const empty =\n      !goals.length && !tasks.length && !habits.length && !ideas.length && !todayPlan.length && !tomorrowPlan.length;\n    if (empty) return;",
    replace:
      "    const empty =\n      !goals.length && !tasks.length && !habits.length && !ideas.length && !todayPlan.length && !tomorrowPlan.length;\n    if (IS_DEMO || empty) return;",
  },
  {
    what: "disable 'reset all' in demo",
    find: '                    if (window.confirm("Erase ALL data and start completely fresh? This cannot be undone.")) {',
    replace:
      '                    if (IS_DEMO) return;\n                    if (window.confirm("Erase ALL data and start completely fresh? This cannot be undone.")) {',
  },
  {
    what: "label the page as a demo",
    find: '                <div className="greet">{greeting}</div>',
    replace: `                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <div className="greet">{greeting}</div>
                  {IS_DEMO && (
                    <span className="pill" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                      DEMO &middot; sample data
                    </span>
                  )}
                </div>`,
  },
];

// Check everything first - one ambiguous or missing anchor and we touch nothing.
const problems = [];
for (const e of edits) {
  const n = src.split(e.find).length - 1;
  if (n !== 1) problems.push(`  ${n === 0 ? "not found" : `found ${n} times`}: ${e.what}`);
}

if (problems.length) {
  console.error("Stopping - src/App.jsx doesn't look the way this patch expects:\n");
  console.error(problems.join("\n"));
  console.error("\nNothing was changed. Send these lines to Claude and it'll adjust the patch.");
  process.exit(1);
}

for (const e of edits) src = src.replace(e.find, e.replace);
writeFileSync(APP, src);

console.log(`Applied ${edits.length} edits to ${APP}.\n`);
console.log("Next:");
console.log("  npm run build            # confirm it compiles");
console.log("  npm run dev              # then open the printed URL with ?demo on the end");
console.log("  git add -A && git commit -m 'Add demo mode' && git push");
