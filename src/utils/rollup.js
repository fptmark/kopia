export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** The roll-up time is stored as 24-hour "HH:MM" and edited as hour, minute and AM/PM. */
export function parseTime(s) {
  const [h24, m] = (s || "08:00").split(":").map(Number);
  return { h: h24 % 12 === 0 ? 12 : h24 % 12, m, ap: h24 >= 12 ? "PM" : "AM" };
}

export function joinTime(h, m, ap) {
  return String((h % 12) + (ap === "PM" ? 12 : 0)).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

/** The next time a summary with this schedule (success.freq daily, weekly or monthly) is due, after `now`. */
export function nextRollup(schedule, now = new Date()) {
  const r = schedule || { freq: "daily", time: "08:00" };
  const [h, m] = r.time.split(":").map(Number);
  const t = new Date(now);
  t.setSeconds(0, 0);
  t.setHours(h, m);

  if (r.freq === "daily") {
    if (t <= now) t.setDate(t.getDate() + 1);
    return t;
  }

  if (r.freq === "weekly") {
    const want = ((r.weekday || 0) + 1) % 7; // weekday 0 is Monday; JavaScript counts from Sunday
    let add = (want - t.getDay() + 7) % 7;
    if (add === 0 && t <= now) add = 7;
    t.setDate(t.getDate() + add);
    return t;
  }

  const dom = r.dom ?? 1;
  const pick = (y, mo) =>
    dom === 0 ? new Date(y, mo + 1, 0, h, m) : new Date(y, mo, Math.min(dom, new Date(y, mo + 1, 0).getDate()), h, m);
  let c = pick(t.getFullYear(), t.getMonth());
  if (c <= now) c = pick(t.getFullYear(), t.getMonth() + 1);
  return c;
}

export const DEFAULT_SUCCESS = { freq: "off", weekday: 0, dom: 1, time: "08:00" };
