export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** The roll-up time is stored as 24-hour "HH:MM" and edited as hour, minute and AM/PM. */
export function parseTime(s) {
  const [h24, m] = (s || "08:00").split(":").map(Number);
  return { h: h24 % 12 === 0 ? 12 : h24 % 12, m, ap: h24 >= 12 ? "PM" : "AM" };
}

export function joinTime(h, m, ap) {
  return String((h % 12) + (ap === "PM" ? 12 : 0)).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

/** 1 as "1st", 22 as "22nd". */
export function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10 > 3 ? 0 : n % 10]}`;
}

export const DEFAULT_SUCCESS = { freq: "off", weekday: 0, dom: 1, time: "08:00" };
