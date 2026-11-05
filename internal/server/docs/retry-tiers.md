# Retry tiers: how Snapshot and Verify recover from a failed automatic attempt

This covers the shared mechanism `source_manager.go` uses for both Snapshot and Verify: retrying a failed
*automatic* attempt, and how that retry interacts with each source's regular schedule so a retry and the
next regular run can't collide. Code: `retry_tier.go` (the pure tier math) and `source_manager.go` (the one
execution path and the next-due-time computation that's aware of it).

## One execution path, not two

There is exactly one place a source's background work runs: `sourceManager.runLocal`, a single per-source
goroutine reading one `requests` channel. Every request -- the scheduler hitting a due time, or a manual
"Snapshot now" -- is a `scheduledRequest{kind, scheduled}`, and `runLocal` dispatches it to
`runScheduledSnapshot` or `runScheduledVerify`, which both call the single shared `runAttempt`. There is no
separate retry loop, no per-cycle goroutine that sleeps between attempts, and no second mechanism for Verify
that works differently from Snapshot's. A retry is not a special case the executor handles -- it's just
another `scheduledRequest`, triggered by the scheduler the same way the first attempt was, because the
*next-due-time computation* (`findClosestNextSnapshotTimeReadLocked` / `...VerifyTimeReadLocked`) accounts
for an in-progress retry cycle and reports the retry's due time instead of the natural schedule's, for as
long as that cycle is active. The scheduler itself never knows or cares that a given trigger is a retry.

This is also why nothing here sleeps: the earlier design had `attemptSnapshotWithRetries` (Snapshot) and
`Server.runScheduledVerifyWithRetries` (Verify) as two separate, hand-copied loops, each calling
`sleepInterruptibly` between attempts in its own goroutine -- a second, ad hoc scheduling mechanism running
in parallel with the real one. Removed entirely: retry delays are just due times, and due times are the
single scheduler's job.

## retryState: primary state, not a cache

`sourceManager` holds one `retryState{often, attemptsUsed}` per kind (`snapshotRetry`, `verifyRetry`).
`attemptsUsed == 0` (the zero value) means no cycle is active and the natural schedule applies. This is *not*
a cache of anything derived -- nobody else computes "how many retries has this cycle used"; it's the direct
record of what `runAttempt` has actually done. That distinction matters: a cached, derived value (like the
next-due-time cache this design replaced -- see "no caching" below) can go stale relative to the state it was
derived from. Primary state, read by the same computation that writes it, cannot.

`advanceRetryState` (`retry_tier.go`) is the one place a cycle changes, called by `runAttempt` after every
attempt:

- **Success**, however triggered (scheduled or manual), always clears the cycle. There's nothing left to
  retry, and a stale "still mid-retry" cycle sitting around would otherwise race a fresh success home (e.g. a
  manual snapshot succeeding right after an automatic one failed) into scheduling a pointless extra retry a
  few minutes later.
- A **scheduled failure** starts a fresh cycle (classifying its tier via `periodEstimate`, see below) or
  continues an active one, consuming one more of its budget. Once the budget (`retryDelays`, same shape as
  before) is used up, it clears the cycle and the natural schedule (with its occasional floor) takes back
  over.
- A **manual failure** never starts, continues, or clears a cycle. A manual trigger never retries, by design
  -- but it also doesn't cancel an automatic retry that's already in progress.

This one function replaces both kinds' separate retry-loop bodies.

### A failure is a failure, whatever caused it

There is no special case here for *why* an attempt failed -- a real error, a stall-timeout kill, a task
canceled some other way, all consume the retry budget identically. Earlier drafts of this design considered
carving out an exception for a failure caused by detected system instability (the machine looking like it
just woke from sleep), reasoning it would unfairly burn through the budget. Working through it: the quick
burst (`OftenRetryCount` × `OftenRetryIntervalMinutes`) is exactly suited to a brief transient condition like
that, and the common case is at most one such failure per real instability episode -- not enough to matter.
A machine with persistently flaky power/connectivity burning through the whole budget on repeated failures
degrades to the natural (patient, infrequent) schedule, which is the correct conservative behavior for that
situation anyway, not a bug to design around. Keeping the rule uniform -- no exceptions for failure cause --
is simpler and was judged not to cost anything real.

## No caching: next-due-time is computed fresh, every time

`findClosestNextSnapshotTimeReadLocked` / `findClosestNextVerifyTimeReadLocked` are called directly by
`getNextSnapshotTime` / `getNextVerifyTime`, which `Server.getSchedulerItems` calls fresh on every single
scheduler tick -- there is no `nextSnapshotTime`/`nextVerifyTime` field cached anywhere. This replaced an
earlier design where `refreshStatus()` computed these once and cached the result into struct fields, read
back later by the scheduler. That design had a real, confirmed bug: a value computed under one set of
conditions, cached, and read back after conditions changed is exactly the shape of staleness that produced a
real unscheduled extra snapshot and verify in the field (see git history around the original diagnosis if you
need the full account). Computing the real inputs here -- `s.pol`, `s.lastCompleteSnapshot`, a small local
preferences-file read via `retryTierSettings()` -- turned out to be cheap enough to just do on every ask;
only `refreshStatus()`'s own inputs (a repository policy read and a snapshot list) are expensive enough to
stay cached and event-triggered, exactly as before. There is nothing left that needs separate cache
invalidation logic: three conditions that used to be handled by `refreshStatus()` choosing when to skip
recomputing the cache (paused, an attempt already in flight, nothing to verify yet) are instead checked
directly, every time, inside the computation itself:

- `s.paused` → both kinds suppressed (`ok=false`, no scheduler item at all).
- `s.snapshotInProgress` / `s.verifyInProgress` → that one kind suppressed while its own attempt is running.
- `s.lastCompleteSnapshot == nil` → Verify suppressed: nothing to verify yet, and without this check a source
  with no complete snapshot would report itself "due" forever (nothing ever advances
  `lastAttemptedVerifyTime` to move the computation forward), busy-looping the scheduler.

## The two tiers

A source's automatic retry behaviour depends on how far apart its *own* regular runs are, not on how overdue
it happens to be right now:

- **often**: the source's own schedule gap is within `RetryTierThresholdHours` (default 1h) -- e.g. an
  hourly snapshot, or a verify schedule shorter than the threshold.
- **occasional**: the gap is longer than the threshold -- e.g. a 4-hour snapshot interval, or Verify's
  once-daily time-of-day schedule.

On a failed scheduled attempt:

- An **often** source retries `OftenRetryCount` times (default 3), `OftenRetryIntervalMinutes` apart
  (default 1), then gives up for this cycle.
- An **occasional** source gets the same often burst first, then escalates to `OccasionalRetryCount` more
  retries (default 5), `OccasionalRetryIntervalMinutes` apart (default 5), before giving up.

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

Reaching for the real `NextSnapshotTime(from, from)` directly is a trap: its `Truncate` grid is
phase-dependent -- the gap it reports for a fixed interval can legitimately be anywhere from just-above-zero
to the full interval, purely depending on where `from` sits on the absolute grid, not on the schedule's
actual cadence. `schedulePeriodEstimate` avoids that for interval schedules by not going through
`NextSnapshotTime` for them at all.

## The occasional-only floor

An occasional source's natural next-run computation gets one more step: it's floored to at least
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
(`OftenRetryCount` × `OftenRetryIntervalMinutes`, a few minutes at most) is short enough relative to even the
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

Verify needs the equivalent, and `lastAttemptedVerifyTime` (set by `sourceManager.markVerifyAttempted`,
called by `runScheduledVerify`'s attempt closure before every scheduled verify attempt) provides it the same
way. Without it, an interrupted attempt would leave no trace, and the schedule would keep reading the old,
increasingly stale completion as "still overdue."

## Where the pieces live

| Concern | Snapshot | Verify |
|---|---|---|
| Automatic trigger entry point | `sourceManager.scheduleAutomaticSnapshot` (`getSchedulerItems`) | `sourceManager.scheduleAutomaticVerify` (`getSchedulerItems`) |
| Execute one attempt | `sourceManager.runScheduledSnapshot` | `sourceManager.runScheduledVerify` |
| Shared attempt + retry-state bookkeeping | `sourceManager.runAttempt` | same |
| Period estimate for classification | `sourceManager.snapshotPeriodEstimateReadLocked` | `sourceManager.verifyPeriodEstimateReadLocked` |
| "Attempt started" marker | `snapshotInternal` sets `lastAttemptedSnapshotTime` | `sourceManager.markVerifyAttempted` |
| Natural next-time + retry-state + floor | `sourceManager.findClosestNextSnapshotTimeReadLocked` | `sourceManager.findClosestNextVerifyTimeReadLocked` |
| Shared tier logic (classification threshold, floor, retry delays, cycle advance) | `retryTierSettings`, `advanceRetryState`, `retryDueTime` (`retry_tier.go`) | same |

## Maintenance is intentionally not part of this

Maintenance already has its own, separate "don't retry too soon after a failure" mechanism:
`maintenance.TimeToAttemptNextMaintenance` computes the next due time from the repository's own persisted
`Schedule.Runs` manifest (so it survives a server restart, unlike anything in-memory), and
`srvMaintenance.afterFailedRun` (`server_maintenance.go`) sets a flat `now + MinMaintenanceInterval` floor on
any failure. It is simpler than the Snapshot/Verify mechanism (one stage, no burst-retry) and, in real task
history, never showed the duplicate/cancel pattern Snapshot and Verify did -- it isn't broken, so it wasn't
folded into this.

## There is no "machine recently unstable" scheduling concept any more

An earlier design detected a gap consistent with the machine having just woken from sleep
(`verifier.tick`'s sleep-gap check) and used it two ways: proactively canceling every running Snapshot,
Verify and Maintenance task the moment it was detected, and deferring the scheduler from starting *any* new
background work for a fixed grace window (`WakeGraceSeconds`) afterward. Both are gone. A canceled task is
now just a failed attempt, handled uniformly by the retry-tier mechanism above like any other failure, and
nothing proactively defers new work based on a predicted "probably still unstable" signal -- the stall-timeout
watchdog (`stall_timeout.go`, `storageStallTimeoutSeconds`) already bounds how long any single attempt can
hang for an unrelated reason, which covers most of what the proactive cancellation was for anyway.

The wake-gap detection itself (`verifier.tick`) still exists, but only for one unrelated purpose: suppressing
a misleading "snapshot looks stale" health-check warning for a grace period right after a start or a real
wake (`graceUntil`), so the dashboard doesn't flash a false alarm before scheduling has had a chance to catch
up. That's a UI-correctness concern, not a scheduling one, and was never part of this mechanism's job.

One real, separate risk the old deferral incidentally reduced the window for: Verify and Maintenance run
concurrently by design (nothing else serializes them), and a long-running Verify's pack-blob listing
(`BlobMap`, captured once at the start of the run) can go stale if Maintenance legitimately repacks content
into a new blob while the run is still in progress -- read as a false "missing from storage" finding. This
was confirmed in real task history (four occurrences, all predating the stall-timeout fix, all on
abnormally long-running Verify tasks). The fix for that is in `snapshot_verify.go`'s `checkPack`: a `BlobMap`
miss is re-checked live, via `BlobReader.GetMetadata`, before being reported as a real failure -- fixing the
actual stale-snapshot mechanism directly, independent of what made the run long (sleep/wake, a slow
connection, or anything else), rather than trying to prevent the two tasks from ever overlapping.
