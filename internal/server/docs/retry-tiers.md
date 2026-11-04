# Retry tiers: how Snapshot and Verify recover from a failed automatic attempt

This covers the shared mechanism `source_manager.go` (Snapshot) and `server.go`/`snapshot_verify_run.go`
(Verify) use to retry a failed *automatic* attempt, and how that retry interacts with each source's regular
schedule so a retry and the next regular run can't collide. Code: `retry_tier.go`.

## Background: why this exists

Before this, Snapshot had a percentage-of-interval suppression window (`recentlyCompletedWithinTolerance`,
removed) grafted onto the scheduler to stop two automatic runs landing back to back, and a dead
`backoffBeforeNextSnapshot` retry path that could never actually fire (its own guard always saw
`nextSnapshotTime` as nil, because the only thing that sets it back to non-nil skips the window while an
upload is in flight). Verify had no retry or collision guard at all: a scheduled verify that was interrupted
by the machine waking from sleep just stayed "still due" indefinitely, so every time
`systemRecentlyUnstable()` cleared it fired again, against whatever the current latest snapshot happened to
be -- in practice, several long sample verifies of *different* snapshots in one morning, not one retried
verify.

This replaces both with one mechanism, used identically by Snapshot and Verify.

## The two tiers

A source's automatic retry behaviour depends on how far apart its *own* regular runs are, not on how overdue
it happens to be right now:

- **often**: the source's own schedule gap is within `RetryTierThresholdHours` (default 1h) -- e.g. an
  hourly snapshot, or a verify schedule shorter than the threshold.
- **occasional**: the gap is longer than the threshold -- e.g. a 4-hour snapshot interval, or Verify's
  once-daily time-of-day schedule.

On a failed automatic attempt:

- An **often** source retries `OftenRetryCount` times (default 3), `OftenRetryIntervalMinutes` apart
  (default 1), then gives up for this cycle.
- An **occasional** source gets the same often burst first, then escalates to `OccasionalRetryCount` more
  retries (default 5), `OccasionalRetryIntervalMinutes` apart (default 5), before giving up.

"Gives up" means exactly that: no further retry this cycle. The regular schedule computation (which now
always accounts for the attempt that just happened, successful or not -- see below) picks the cycle back up
on its own next due time.

A manual trigger ("Snapshot now", a manual Verify click) never enters this retry loop at all -- it just
reports its own success or failure, same as before.

All five settings are in `serverapi.UIPreferences` (`RetryTierThresholdHours`, `OftenRetryCount`,
`OftenRetryIntervalMinutes`, `OccasionalRetryCount`, `OccasionalRetryIntervalMinutes`), editable in
Preferences → Scheduling; 0 (unset) uses the defaults above.

## Classifying a source: `schedulePeriodEstimate`

Classification needs "how far apart are this source's own regular runs," which is *not* the same question
as "when would `NextSnapshotTime`/`NextVerifyTime` say this source is next due right now" -- that real
computation is anchored to the last actual completion/attempt, which right at a cycle's own due moment is
close to *now* regardless of whether the source runs hourly or daily, so it can't tell the two apart.

`schedulePeriodEstimate` (`retry_tier.go`) answers the real question instead:

- For a **plain interval** schedule, the period is `IntervalSeconds` directly -- exact, and independent of
  what moment it happens to be asked.
- For a **time-of-day or cron** schedule, there's no single interval field to read, so it measures the gap
  between two consecutive occurrences, counting from a reference point a safe 48h in the past (so the
  schedule being asked about exactly *at* one of its own occurrences doesn't read as "zero gap").

Reaching for the real `NextSnapshotTime(from, from)` directly (as an earlier version of this did) is a trap:
its `Truncate` grid is phase-dependent -- the gap it reports for a fixed interval can legitimately be
anywhere from just-above-zero to the full interval, purely depending on where `from` sits on the absolute
grid, not on the schedule's actual cadence. `schedulePeriodEstimate` avoids that for interval schedules by
not going through `NextSnapshotTime` for them at all.

## The occasional-only floor

An occasional source's real next-run computation gets one more step: it's floored to at least
`lastCompletion + threshold`.

```
next = max(naturally-computed-next-time, lastCompletion + thresholdHours)
```

This matters because `NextSnapshotTime`/`NextVerifyTime`'s own math falls back to "now" whenever its regular
(`Truncate`-based or time-of-day) computation lands in the past -- an overdue source is due immediately, not
at some stale past slot. That fallback is correct in general, but combined with `Truncate`'s phase-dependence
it means the "natural" next time computed shortly after a completion can -- depending on grid alignment --
land surprisingly soon, not a full interval out. The floor is a flat backstop against that specifically for
occasional sources: no automatic cycle starts less than `thresholdHours` after the last one completed,
regardless of what the natural computation says. An **often** source gets no floor: its retry burst
(`OftenRetryCount` x `OftenRetryIntervalMinutes`, a few minutes at most) is short enough relative to even the
shortest realistic often schedule that it can't run ahead of the next regular slot on its own, so the
natural computation is trusted as-is.

The floor is deliberately a backstop, not load-bearing for day-to-day correctness: in the ordinary case
(classify, retry, give up or succeed, all evaluated at essentially the same moment) the natural computation
already lands a full schedule-period out on its own. It matters when something evaluates a source's schedule
meaningfully later than its last attempt -- in practice, the periodic global repository refresh sweep
(`RefreshInterval`, default 4h) landing on an occasional source some time after it last completed.

## Why Snapshot and Verify both need their own "last attempted" time

`findClosestNextSnapshotTimeReadLocked` has always used `max(lastCompleteSnapshot.StartTime,
lastAttemptedSnapshotTime)` as the schedule's anchor -- `lastAttemptedSnapshotTime` is set in
`snapshotInternal` before an upload even starts, succeed or fail. That's what makes the natural computation
self-correct after a failure: even though nothing completed, the next `Truncate` lands a full interval past
the *attempt*, not stuck on the old completion.

Verify never had the equivalent. `findClosestNextVerifyTimeReadLocked` only read `lastVerificationTime(...)`,
which is written only on a completed (not merely attempted) verify -- so an interrupted attempt left no
trace, and the schedule kept reading the old, increasingly stale completion as "still overdue," refiring
every time `systemRecentlyUnstable()` cleared. `lastAttemptedVerifyTime` (set by `sourceManager.
markVerifyAttempted`, called at the top of every scheduled verify attempt in `runScheduledVerifyWithRetries`)
closes that gap the same way `lastAttemptedSnapshotTime` always has.

## Where the pieces live

| Concern | Snapshot | Verify |
|---|---|---|
| Automatic trigger entry point | `sourceManager.scheduleAutomaticSnapshot` (`getSchedulerItems`) | `Server.triggerScheduledVerify` |
| Retry loop | `sourceManager.attemptSnapshotWithRetries` | `Server.runScheduledVerifyWithRetries` |
| Classify this cycle's tier | `sourceManager.classifySnapshotRetryTier` | `sourceManager.classifyVerifyRetryTier` |
| Period estimate for classification | `sourceManager.snapshotPeriodEstimateReadLocked` | `sourceManager.verifyPeriodEstimateReadLocked` |
| "Attempt started" marker | `snapshotInternal` sets `lastAttemptedSnapshotTime` | `sourceManager.markVerifyAttempted` |
| Natural next-time + floor | `sourceManager.findClosestNextSnapshotTimeReadLocked` | `sourceManager.findClosestNextVerifyTimeReadLocked` |
| Shared tier logic (classification threshold, floor, retry delays) | `retryTierSettings` (`retry_tier.go`) | same |

Both retry loops run in their own goroutine and return control to the scheduler at once (Verify's
`triggerScheduledVerify` always has: its result runs as a `Trigger()` call inside the single shared
scheduler loop in `internal/scheduler/scheduler.go`, which must never block on one source's retry burst
while other sources and maintenance wait behind it).

## Maintenance is intentionally not part of this

Maintenance already has its own, separate "don't retry too soon after a failure" mechanism:
`maintenance.TimeToAttemptNextMaintenance` computes the next due time from the repository's own persisted
`Schedule.Runs` manifest (so it survives a server restart, unlike anything in-memory), and
`srvMaintenance.afterFailedRun` (`server_maintenance.go`) sets a flat `now + MinMaintenanceInterval` floor on
any failure. It is simpler than the Snapshot/Verify mechanism (one stage, no burst-retry) and, in real task
history, never showed the duplicate/cancel pattern Snapshot and Verify did -- it isn't broken, so it wasn't
folded into this.
