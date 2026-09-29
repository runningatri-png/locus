// One place that decides what belongs on a given date. Imported by both the app
// (src/App.jsx) and the MCP connector (netlify/functions/mcp.js).
//
// Written as a shared module on purpose. The last time two files each kept their
// own idea of a date format, habits showed up on the wrong days for a week
// before anyone noticed - see src/days.js, which exists for the same reason.

/** A Date -> "YYYY-MM-DD", in local time. Never use toISOString() for this: it
 *  converts to UTC first, so late evenings land on tomorrow. */
export function isoKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Noon, so daylight-saving shifts can never push a date onto its neighbour. */
export function dateOf(key) {
  return new Date(key + "T12:00:00");
}

export function addDays(key, n) {
  const d = dateOf(key);
  d.setDate(d.getDate() + n);
  return isoKey(d);
}

export function daysBetween(aKey, bKey) {
  return Math.round((dateOf(bKey) - dateOf(aKey)) / 86400000);
}

export function norm(str) {
  return (str || "").trim().toLowerCase();
}

const DUE_DOW = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

/**
 * A task's due date is free text - "2026-10-02", "Friday", "next week", "".
 * Only text naming exactly one real day earns a slot on the calendar; anything
 * vaguer stays vague rather than being invented into a precise date. That rule
 * is deliberate: a guessed deadline is worse than a missing one.
 *
 * Returns "YYYY-MM-DD", or null when the text doesn't name a single day.
 */
export function dueKey(due, todayK) {
  const q = norm(due);
  if (!q) return null;

  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(q);
  if (iso) return iso[0];

  if (q === "today" || q === "tonight") return todayK;
  if (q === "tomorrow") return addDays(todayK, 1);

  // "by Friday", "next Monday", "on thurs." all name one weekday.
  const word = q.replace(/^(next|this|on|by|due|before)\s+/, "").replace(/[^a-z]/g, "");
  if (Object.prototype.hasOwnProperty.call(DUE_DOW, word)) {
    const delta = (DUE_DOW[word] - dateOf(todayK).getDay() + 7) % 7;
    return addDays(todayK, delta); // today counts as "Monday" when today is Monday
  }

  return null;
}

/** Human countdown from one date to another: "today", "tomorrow", "in 3 days". */
export function countdown(fromKey, toKey) {
  const n = daysBetween(fromKey, toKey);
  if (n < 0) return `${-n} day${-n === 1 ? "" : "s"} ago`;
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  return `in ${n} days`;
}

/** A block the user put there themselves, as opposed to one a routine or fixed
 *  commitment produced. Auto-placed blocks carry `src` (or are `derived` on
 *  future days); a one-off carries neither. */
export function isOneOff(b) {
  return !b.src && !b.derived && !b.fixed && !b.tracked;
}

/**
 * The Upcoming list on Today: deadlines and one-off blocks from today through
 * `span` days ahead, grouped by date, empty days left out. Recurring routines
 * are excluded on purpose - they're the same every week, so leaving them out is
 * what lets the unusual things stand out.
 *
 * `viewOf(key)` is the app's own dayView(), passed in rather than re-derived,
 * so there's still exactly one answer to "what's on this date".
 *
 * Today's blocks are skipped (they're already in the plan beside the panel);
 * today's deadlines are kept, because tasks aren't blocks and appear nowhere
 * else on Today.
 */
export function upcomingDays(todayK, span, viewOf) {
  const out = [];
  for (let rel = 0; rel <= span; rel++) {
    const key = addDays(todayK, rel);
    const v = viewOf(key);
    // High importance first within a day - the thing you can't miss leads.
    const deadlines = [...v.deadlines].sort((a, b) => (b.imp || 2) - (a.imp || 2));
    const blocks =
      rel === 0 ? [] : v.blocks.filter((b) => isOneOff(b) && !b.done && b.status !== "skipped");
    if (deadlines.length || blocks.length) out.push({ key, rel, deadlines, blocks });
  }
  return out;
}

/** The single nearest item, for the collapsed one-line summary on mobile.
 *  Deadlines lead within a day, matching the order the full list shows. */
export function nextUpcoming(groups) {
  const g = groups[0];
  if (!g) return null;
  const t = g.deadlines[0];
  return {
    key: g.key,
    rel: g.rel,
    title: t ? t.name : g.blocks[0].title,
    deadline: !!t,
    total: groups.reduce((n, x) => n + x.deadlines.length + x.blocks.length, 0),
  };
}
