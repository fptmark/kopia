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
