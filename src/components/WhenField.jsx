import { joinTime, ordinal, parseTime, WEEKDAYS } from "../utils/rollup";
import { SegmentedField } from "./SegmentedField";

const DAYS = WEEKDAYS.map((n) => n.slice(0, 3));

/**
 * Types a number into a field that holds 1..max, the way a date picker does: a first digit that could still
 * grow into a valid number waits, anything else is final. Returns the new value, and whether the field is done.
 */
export function typeNumber(buffer, digit, max) {
  let next = buffer + digit;
  if (Number(next) > max || Number(next) === 0) {
    next = digit;
  }
  const n = Number(next);
  if (n < 1 || n > max) {
    return { value: null, buffer: "", done: false };
  }
  return { value: n, buffer: next, done: n * 10 > max };
}

/** The next name starting with the letter, after the current one (so repeated presses cycle: T, T = Tue, Thu). */
export function typeLetter(names, current, letter) {
  const l = letter.toLowerCase();
  const matches = names.map((n, i) => [n, i]).filter(([n]) => n.toLowerCase().startsWith(l));
  if (matches.length === 0) {
    return -1;
  }
  const after = matches.find(([, i]) => i > current);
  return (after || matches[0])[1];
}

/**
 * A date-picker style field for when a summary is sent: each part is highlighted when selected and edited by
 * typing; left and right arrows move between the parts. freq is daily, weekly or monthly.
 */
export function WhenField({ name, freq, weekday = 0, dom = 1, time, onChange }) {
  const tm = parseTime(time);

  const setTime = (patch) => {
    const t = { ...tm, ...patch };
    onChange({ time: joinTime(t.h, 0, t.ap) });
  };

  const parts = [];
  if (freq === "weekly") {
    parts.push({
      ariaLabel: `Day of week for ${name}`,
      text: DAYS[weekday] ?? DAYS[0],
      type: (key) => {
        const i = typeLetter(DAYS, weekday, key);
        return i >= 0 ? { set: () => onChange({ weekday: i }), done: true } : null;
      },
      step: (d) => onChange({ weekday: (weekday + d + 7) % 7 }),
    });
  }
  if (freq === "monthly") {
    parts.push({
      ariaLabel: `Day of month for ${name}`,
      text: dom === 0 ? "Last" : ordinal(dom),
      type: (key, buffer) => {
        if (key.toLowerCase() === "l") {
          return { set: () => onChange({ dom: 0 }), done: true };
        }
        if (!/^[0-9]$/.test(key)) {
          return null;
        }
        const r = typeNumber(buffer.current, key, 28);
        buffer.current = r.buffer;
        return r.value === null ? null : { set: () => onChange({ dom: r.value }), done: r.done };
      },
      step: (d) => onChange({ dom: (dom + d + 29) % 29 }),
    });
  }
  parts.push({
    ariaLabel: `Hour for ${name}`,
    text: String(tm.h),
    type: (key, buffer) => {
      if (!/^[0-9]$/.test(key)) {
        return null;
      }
      const r = typeNumber(buffer.current, key, 12);
      buffer.current = r.buffer;
      return r.value === null ? null : { set: () => setTime({ h: r.value }), done: r.done };
    },
    step: (d) => setTime({ h: ((tm.h - 1 + d + 12) % 12) + 1 }),
  });
  parts.push({
    ariaLabel: `AM or PM for ${name}`,
    text: tm.ap,
    type: (key) => {
      const k = key.toLowerCase();
      if (k === "a" || k === "p") {
        return { set: () => setTime({ ap: k === "a" ? "AM" : "PM" }), done: false };
      }
      return null;
    },
    step: () => setTime({ ap: tm.ap === "AM" ? "PM" : "AM" }),
  });

  return <SegmentedField ariaLabel={`When for ${name}`} parts={parts} />;
}
