package server

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/serverapi"
)

func TestRetryTierSettingsFromPreferencesAppliesDefaults(t *testing.T) {
	rt := retryTierSettingsFromPreferences(serverapi.UIPreferences{})

	require.InDelta(t, float64(defaultRetryTierThresholdHours), rt.ThresholdHours, 0)
	require.Equal(t, defaultOftenRetryCount, rt.OftenCount)
	require.Equal(t, defaultOftenRetryIntervalMinutes, rt.OftenIntervalMinutes)
	require.Equal(t, defaultOccasionalRetryCount, rt.OccasionalCount)
	require.Equal(t, defaultOccasionalRetryIntervalMinutes, rt.OccasionalIntervalMinutes)
}

func TestRetryTierSettingsFromPreferencesKeepsSetValues(t *testing.T) {
	rt := retryTierSettingsFromPreferences(serverapi.UIPreferences{
		RetryTierThresholdHours:        2.5,
		OftenRetryCount:                7,
		OftenRetryIntervalMinutes:      2,
		OccasionalRetryCount:           9,
		OccasionalRetryIntervalMinutes: 15,
	})

	require.InDelta(t, 2.5, rt.ThresholdHours, 0)
	require.Equal(t, 7, rt.OftenCount)
	require.Equal(t, 2, rt.OftenIntervalMinutes)
	require.Equal(t, 9, rt.OccasionalCount)
	require.Equal(t, 15, rt.OccasionalIntervalMinutes)
}

func TestIsOften(t *testing.T) {
	rt := retryTierSettingsFromPreferences(serverapi.UIPreferences{RetryTierThresholdHours: 1})

	require.True(t, rt.isOften(59*time.Minute))
	require.True(t, rt.isOften(time.Hour)) // exactly at the threshold: still often
	require.False(t, rt.isOften(time.Hour+time.Second))
	require.True(t, rt.isOften(0))
}

func TestRetryDelays(t *testing.T) {
	rt := retryTierSettingsFromPreferences(serverapi.UIPreferences{
		OftenRetryCount: 3, OftenRetryIntervalMinutes: 1,
		OccasionalRetryCount: 5, OccasionalRetryIntervalMinutes: 5,
	})

	t.Run("often", func(t *testing.T) {
		got := rt.retryDelays(true)
		require.Equal(t, []time.Duration{time.Minute, time.Minute, time.Minute}, got)
	})

	t.Run("occasional escalates after the often burst", func(t *testing.T) {
		got := rt.retryDelays(false)
		require.Equal(t, []time.Duration{
			time.Minute, time.Minute, time.Minute,
			5 * time.Minute, 5 * time.Minute, 5 * time.Minute, 5 * time.Minute, 5 * time.Minute,
		}, got)
	})
}

func TestFloor(t *testing.T) {
	rt := retryTierSettingsFromPreferences(serverapi.UIPreferences{RetryTierThresholdHours: 1})
	now := time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC)

	t.Run("often gets no floor even when it would otherwise bite", func(t *testing.T) {
		// naturalNext fell back to "now" (an overdue often-class source is due immediately); without the
		// often==true check this would wrongly get pulled forward by the floor too.
		require.Equal(t, now, rt.floor(now, now.Add(-10*time.Minute), true, true))
	})

	t.Run("occasional floor wins when naturalNext fell back to now", func(t *testing.T) {
		// mirrors the real scenario: an occasional (e.g. 4h-interval) source's own NextSnapshotTime fell
		// back to "now" because its regular computation landed in the past -- exactly what happens right
		// after a late/retried completion. The floor pulls the next cycle out to lastCompletion+threshold.
		lastCompletion := now
		got := rt.floor(now, lastCompletion, true, false)
		require.Equal(t, lastCompletion.Add(time.Hour), got)
		require.True(t, got.After(now))
	})

	t.Run("occasional floor loses when naturalNext is already further out", func(t *testing.T) {
		natural := now.Add(4 * time.Hour) // a normal, non-overdue occasional computation
		lastCompletion := now.Add(-10 * time.Minute)
		require.Equal(t, natural, rt.floor(natural, lastCompletion, true, false))
	})

	t.Run("no completion yet: no floor", func(t *testing.T) {
		require.Equal(t, now, rt.floor(now, time.Time{}, false, false))
	})
}

func TestAdvanceRetryState(t *testing.T) {
	rt := retryTierSettingsFromPreferences(serverapi.UIPreferences{
		OftenRetryCount: 3, OftenRetryIntervalMinutes: 1,
		OccasionalRetryCount: 5, OccasionalRetryIntervalMinutes: 5,
	})

	oftenEstimate := func() (time.Duration, bool) { return 30 * time.Minute, true }
	occasionalEstimate := func() (time.Duration, bool) { return 4 * time.Hour, true }

	t.Run("success always clears, scheduled or not", func(t *testing.T) {
		active := retryState{often: true, attemptsUsed: 2}
		require.Equal(t, retryState{}, advanceRetryState(active, rt, false, true, oftenEstimate))
		require.Equal(t, retryState{}, advanceRetryState(active, rt, false, false, oftenEstimate))
	})

	t.Run("manual failure never starts or continues a cycle", func(t *testing.T) {
		require.Equal(t, retryState{}, advanceRetryState(retryState{}, rt, true, false, oftenEstimate))

		active := retryState{often: true, attemptsUsed: 1}
		require.Equal(t, active, advanceRetryState(active, rt, true, false, oftenEstimate), "a manual failure leaves an existing automatic cycle untouched")
	})

	t.Run("scheduled failure starts a fresh cycle, classifying its tier", func(t *testing.T) {
		got := advanceRetryState(retryState{}, rt, true, true, oftenEstimate)
		require.Equal(t, retryState{often: true, attemptsUsed: 1}, got)

		got = advanceRetryState(retryState{}, rt, true, true, occasionalEstimate)
		require.Equal(t, retryState{often: false, attemptsUsed: 1}, got)
	})

	t.Run("scheduled failure continues an active cycle without reclassifying", func(t *testing.T) {
		active := retryState{often: false, attemptsUsed: 3}
		// occasionalEstimate would classify fresh as "often" if this were consulted -- it must not be,
		// since the cycle is already active.
		got := advanceRetryState(active, rt, true, true, oftenEstimate)
		require.Equal(t, retryState{often: false, attemptsUsed: 4}, got)
	})

	t.Run("scheduled failure exhausting the budget gives up", func(t *testing.T) {
		// often budget is 3; one more failure at attemptsUsed==3 exhausts it.
		got := advanceRetryState(retryState{often: true, attemptsUsed: 3}, rt, true, true, oftenEstimate)
		require.Equal(t, retryState{}, got)

		// occasional budget is 3+5=8.
		got = advanceRetryState(retryState{often: false, attemptsUsed: 8}, rt, true, true, occasionalEstimate)
		require.Equal(t, retryState{}, got)
	})

	t.Run("no schedule to estimate from is conservative: often, no floor later", func(t *testing.T) {
		noEstimate := func() (time.Duration, bool) { return 0, false }
		got := advanceRetryState(retryState{}, rt, true, true, noEstimate)
		require.Equal(t, retryState{often: true, attemptsUsed: 1}, got)
	})
}

func TestRetryDueTime(t *testing.T) {
	rt := retryTierSettingsFromPreferences(serverapi.UIPreferences{
		OftenRetryCount: 3, OftenRetryIntervalMinutes: 1,
		OccasionalRetryCount: 5, OccasionalRetryIntervalMinutes: 5,
	})
	lastAttempted := time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC)

	t.Run("no active cycle: natural schedule applies", func(t *testing.T) {
		_, ok := retryDueTime(retryState{}, rt, lastAttempted)
		require.False(t, ok)
	})

	t.Run("active cycle: lastAttempted plus the delay at attemptsUsed-1", func(t *testing.T) {
		got, ok := retryDueTime(retryState{often: true, attemptsUsed: 1}, rt, lastAttempted)
		require.True(t, ok)
		require.True(t, lastAttempted.Add(time.Minute).Equal(got))

		got, ok = retryDueTime(retryState{often: false, attemptsUsed: 5}, rt, lastAttempted)
		require.True(t, ok)
		require.True(t, lastAttempted.Add(5*time.Minute).Equal(got), "5th slot is the 2nd occasional delay (index 4)")
	})

	t.Run("stale attemptsUsed past the current budget falls back to the natural schedule", func(t *testing.T) {
		// e.g. the retry-tier preferences changed mid-cycle and shortened the burst.
		_, ok := retryDueTime(retryState{often: true, attemptsUsed: 99}, rt, lastAttempted)
		require.False(t, ok)
	})
}
