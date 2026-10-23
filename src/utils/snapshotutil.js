const HOUR = 3600;

/**
 * A snapshot is overdue when the newest one is older than twice the schedule's interval plus half an hour
 * (never less than 3 hours): the same limit the backup health check uses. Sources without an interval (manual,
 * times of day) are never called overdue here.
 */
export function isOverdue(lastSnapshotTime, intervalSeconds, now) {
  if (!lastSnapshotTime || !intervalSeconds) {
    return false;
  }
  const limit = Math.max(3 * HOUR, 2 * intervalSeconds + HOUR / 2);
  return now.diff(lastSnapshotTime, "seconds") > limit;
}
