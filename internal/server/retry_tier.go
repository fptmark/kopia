package server

import (
	"time"

	"github.com/kopia/kopia/internal/serverapi"
)

// Default values for the UIPreferences retry-tier fields, used whenever a preference is unset (zero).
// See docs/retry-tiers.md for the algorithm these implement.
const (
	defaultRetryTierThresholdHours        = 1
	defaultOftenRetryCount                = 3
	defaultOftenRetryIntervalMinutes      = 1
	defaultOccasionalRetryCount           = 5
	defaultOccasionalRetryIntervalMinutes = 5
)

// retryTierSettings holds the resolved (defaults already applied) retry-tier preferences. See
// docs/retry-tiers.md.
type retryTierSettings struct {
	ThresholdHours            float64
	OftenCount                int
	OftenIntervalMinutes      int
	OccasionalCount           int
	OccasionalIntervalMinutes int
}

// retryTierSettingsFromPreferences resolves retryTierSettings from UIPreferences, filling in defaults for
// anything unset (zero/negative).
func retryTierSettingsFromPreferences(p serverapi.UIPreferences) retryTierSettings {
	rt := retryTierSettings{
		ThresholdHours:            p.RetryTierThresholdHours,
		OftenCount:                p.OftenRetryCount,
		OftenIntervalMinutes:      p.OftenRetryIntervalMinutes,
		OccasionalCount:           p.OccasionalRetryCount,
		OccasionalIntervalMinutes: p.OccasionalRetryIntervalMinutes,
	}

	if rt.ThresholdHours <= 0 {
		rt.ThresholdHours = defaultRetryTierThresholdHours
	}

	if rt.OftenCount <= 0 {
		rt.OftenCount = defaultOftenRetryCount
	}

	if rt.OftenIntervalMinutes <= 0 {
		rt.OftenIntervalMinutes = defaultOftenRetryIntervalMinutes
	}

	if rt.OccasionalCount <= 0 {
		rt.OccasionalCount = defaultOccasionalRetryCount
	}

	if rt.OccasionalIntervalMinutes <= 0 {
		rt.OccasionalIntervalMinutes = defaultOccasionalRetryIntervalMinutes
	}

	return rt
}

// schedulePeriodEstimateSafeMargin is how far into the past schedulePeriodEstimate's reference point sits
// for a time-of-day/cron schedule, so landing exactly on an occurrence never reads as "no gap at all".
// Longer than any realistic schedule gap (a weekly cron, say) matters less here than being safely unrelated
// to `from`; a cron this sparse is not a realistic retry-tier candidate anyway.
const schedulePeriodEstimateSafeMargin = 48 * time.Hour

// schedulePeriodEstimate estimates how far apart a schedule's own regular occurrences are, for retry-tier
// classification (docs/retry-tiers.md). For a plain interval schedule this is IntervalSeconds directly --
// exact, and independent of what moment it happens to be asked, unlike asking `next` what it would do if a
// run had just completed at `from`: that reads the schedule's absolute, phase-dependent Truncate grid, which
// can land anywhere from just after `from` to a full interval later purely depending on where `from` sits on
// it, not on the schedule's actual cadence. For a time-of-day or cron schedule there is no single interval
// to read off, so this instead measures the gap between two consecutive occurrences, counting from safely
// in the past -- again so `from` landing exactly on an occurrence doesn't read as zero gap.
func schedulePeriodEstimate(intervalSeconds int64, hasTimesOfDayOrCron bool, next func(previous, now time.Time) (time.Time, bool), from time.Time) (time.Duration, bool) {
	if intervalSeconds > 0 && !hasTimesOfDayOrCron {
		return time.Duration(intervalSeconds) * time.Second, true
	}

	reference := from.Add(-schedulePeriodEstimateSafeMargin)

	first, ok := next(reference, reference)
	if !ok {
		return 0, false
	}

	second, ok := next(first, first.Add(time.Second))
	if !ok {
		return 0, false
	}

	return second.Sub(first), true
}

func (rt retryTierSettings) threshold() time.Duration {
	return time.Duration(rt.ThresholdHours * float64(time.Hour))
}

// isOften reports whether period -- the task's own schedule gap, estimated as the time from some moment to
// its next occurrence if it had just run at that same moment -- falls within the configured threshold.
// "often" tasks get a short retry burst and no floor on the next cycle; "occasional" tasks additionally
// escalate to a longer, slower retry and get a floor so a retry can't land a fresh cycle too close to the
// last one that completed.
func (rt retryTierSettings) isOften(period time.Duration) bool {
	return period <= rt.threshold()
}

// floor pulls naturalNext forward to at least lastCompletion+threshold when the task is occasional-class
// (often == false). An often-class task gets no floor: its retry burst (OftenCount x
// OftenIntervalMinutes) is short enough relative to even the shortest realistic often schedule that it
// can't run ahead of the next regular slot on its own, so the natural schedule computation is trusted as
// is. hasCompletion false (nothing has ever completed for this task) also skips the floor -- there is
// nothing to measure it from.
//
// This matters because naturalNext's own math falls back to "now" whenever its regular computation lands
// in the past (an overdue source is due immediately, not at some stale past slot) -- exactly the situation
// right after a late or retried completion, which is also exactly when an occasional-class task most needs
// the floor.
func (rt retryTierSettings) floor(naturalNext, lastCompletion time.Time, hasCompletion, often bool) time.Time {
	if !hasCompletion || often {
		return naturalNext
	}

	f := lastCompletion.Add(rt.threshold())
	if f.After(naturalNext) {
		return f
	}

	return naturalNext
}

// retryDelays returns the sequence of wait-before-retry durations for a failed automatic attempt of this
// retry tier, classified once at the start of the cycle. An often-class task always gets OftenCount
// retries, OftenIntervalMinutes apart, then stops. An occasional-class task gets the same often burst
// first, then escalates to OccasionalCount more retries, OccasionalIntervalMinutes apart. Once the
// returned delays are exhausted, the caller gives up and leaves the natural schedule (with floor, for
// occasional) to pick the cycle up again.
func (rt retryTierSettings) retryDelays(often bool) []time.Duration {
	oftenInterval := time.Duration(rt.OftenIntervalMinutes) * time.Minute

	delays := make([]time.Duration, 0, rt.OftenCount+rt.OccasionalCount)
	for range rt.OftenCount {
		delays = append(delays, oftenInterval)
	}

	if !often {
		occInterval := time.Duration(rt.OccasionalIntervalMinutes) * time.Minute
		for range rt.OccasionalCount {
			delays = append(delays, occInterval)
		}
	}

	return delays
}

// retryTierSettings resolves the server's current retry-tier preferences, defaults applied.
func (s *Server) retryTierSettings() retryTierSettings {
	prefs, err := getUIPreferencesOrEmpty(s)
	if err != nil {
		prefs = serverapi.UIPreferences{}
	}

	return retryTierSettingsFromPreferences(prefs)
}

// retryState is a retry-tier cycle in progress for one task kind (Snapshot or Verify) on one source.
// attemptsUsed==0 is the zero value and means no cycle is active -- the natural schedule applies. This is
// primary state (nobody else computes it; it is just a record of attempts as they happen), not a cache of
// anything derived, so unlike a cached next-due-time it cannot go stale: it is only ever read by the same
// due-time computation that advanceRetryState keeps in step with. See docs/retry-tiers.md.
type retryState struct {
	often        bool
	attemptsUsed int
}

// advanceRetryState is the one place a retry-tier cycle changes, for both Snapshot and Verify: called once
// after every attempt, scheduled or manual. A success (however triggered) always clears the cycle -- there
// is nothing left to retry. A scheduled failure starts a fresh cycle (classifying its tier via
// periodEstimate) or continues an active one, consuming one more of its budget; once the budget is used up
// it gives up and clears the cycle, letting the natural schedule (with its occasional floor) pick things up.
// A manual failure never starts, continues, or clears a cycle -- manual attempts never retry, by design, but
// don't cancel an automatic retry that's already in progress either.
func advanceRetryState(rs retryState, rt retryTierSettings, failed, scheduled bool, periodEstimate func() (time.Duration, bool)) retryState {
	if !failed {
		return retryState{}
	}

	if !scheduled {
		return rs
	}

	if rs.attemptsUsed == 0 {
		period, ok := periodEstimate()
		rs.often = !ok || rt.isOften(period)
	}

	rs.attemptsUsed++

	if rs.attemptsUsed > len(rt.retryDelays(rs.often)) {
		return retryState{}
	}

	return rs
}

// retryDueTime reports the due time an active retry-tier cycle implies -- lastAttempted plus the tier's next
// delay -- or ok=false when no cycle is active (or it's gone stale, e.g. the retry-tier preferences changed
// mid-cycle and shortened the burst past attemptsUsed) and the natural schedule applies instead.
func retryDueTime(rs retryState, rt retryTierSettings, lastAttempted time.Time) (time.Time, bool) {
	if rs.attemptsUsed == 0 {
		return time.Time{}, false
	}

	delays := rt.retryDelays(rs.often)
	if rs.attemptsUsed > len(delays) {
		return time.Time{}, false
	}

	return lastAttempted.Add(delays[rs.attemptsUsed-1]), true
}
