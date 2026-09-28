// One definition of "which days does this happen on", imported by both the app
// and the MCP function. They previously disagreed: the app read a structured
// `days` array while the connector only ever wrote a free-text `freq`, so a
// habit added by saying "add a grocery run on Sunday" arrived with days: []
// and the app's "no days means every day" rule put it on every day.

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Accepts [1,3], ["Mon","Wed"], "Monday, Wednesday", "Sunday", "MWF". */
export function parseDays(v) {
  if (Array.isArray(v) && v.every((d) => typeof d === "number")) return v.filter((d) => d >= 0 && d <= 6);
  const text = (Array.isArray(v) ? v.join(",") : String(v || "")).toLowerCase();
  const out = [];
  DAY_SHORT.forEach((short, i) => {
    if (text.includes(short.toLowerCase()) || text.includes(DAY_NAMES[i].toLowerCase())) out.push(i);
  });
  if (out.length) return [...new Set(out)];
  if (/^[mtwrfsu]+$/.test(text.replace(/[^a-z]/g, ""))) {
    const map = { m: 1, t: 2, w: 3, r: 4, f: 5, s: 6, u: 0 };
    return [...new Set(text.replace(/[^a-z]/g, "").split("").map((c) => map[c]).filter((d) => d !== undefined))];
  }
  return [];
}

/**
 * The days a routine actually runs. Prefers the structured field, falls back to
 * reading the frequency text. An empty result means "every day" - a 3x-a-week
 * routine has no fixed days, so it should show up daily to be ticked.
 */
export function effectiveDays(h) {
  if (Array.isArray(h.days) && h.days.length) return h.days;
  const freq = String(h.freq || "").toLowerCase();
  if (/every ?day|daily/.test(freq)) return [];
  if (/weekday/.test(freq)) return [1, 2, 3, 4, 5];
  if (/weekend/.test(freq)) return [0, 6];
  return parseDays(freq);
}

/** Does this routine run on that weekday? Empty days means yes, always. */
export function runsOn(h, dow) {
  const days = effectiveDays(h);
  return !days.length || days.includes(dow);
}
