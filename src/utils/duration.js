// A period is typed as a number and a unit and stored in seconds.
export const DURATION_UNITS = [
  { id: "sec", seconds: 1 },
  { id: "min", seconds: 60 },
  { id: "hr", seconds: 3600 },
  { id: "days", seconds: 86400 },
];

const unitSeconds = (id) => DURATION_UNITS.find((u) => u.id === id)?.seconds ?? 1;

/** The number and unit that show a period: the largest unit that divides it evenly (5400 is 90 min). */
export function splitDuration(seconds) {
  if (!seconds || seconds < 0) {
    return { text: "", unit: "hr" };
  }
  for (const u of [...DURATION_UNITS].reverse()) {
    if (seconds % u.seconds === 0) {
      return { text: String(seconds / u.seconds), unit: u.id };
    }
  }
  return { text: String(seconds), unit: "sec" };
}

/** The period in seconds for a typed number and unit (decimals allowed: 1.5 hr), or null if it is not a number. */
export function parseDuration(text, unit) {
  if (!/^\d*\.?\d+$/.test(String(text).trim())) {
    return null;
  }
  return Math.round(Number(text) * unitSeconds(unit));
}

/** A period for reading: "1 hr", "90 min", "2 days". Empty for nothing. */
export function formatDuration(seconds) {
  if (!seconds) {
    return "";
  }
  const { text, unit } = splitDuration(seconds);
  return `${text} ${unit}`;
}
