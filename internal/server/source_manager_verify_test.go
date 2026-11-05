package server

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/internal/uitask"
	"github.com/kopia/kopia/notification/notifydata"
	"github.com/kopia/kopia/repo"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/policy"
)

// stubSourceManagerServer is a minimal sourceManagerServerInterface for testing sourceManager's own verify
// scheduling logic in isolation, without a real repository or task history.
type stubSourceManagerServer struct {
	lastVerify   time.Time
	lastVerifyOK bool
	rt           retryTierSettings // zero value: retryTierSettings() fills in the defaults
}

func (s *stubSourceManagerServer) runSnapshotTask(context.Context, snapshot.SourceInfo, func(context.Context, uitask.Controller, *notifydata.ManifestWithError) error) error {
	return nil
}

func (s *stubSourceManagerServer) runQueuedVerifyOnce(context.Context, repo.Repository, *snapshot.Manifest, string, float64) error {
	return nil
}

func (s *stubSourceManagerServer) refreshScheduler(string) {}

func (s *stubSourceManagerServer) lastVerificationTime(snapshot.SourceInfo, string) (time.Time, bool) {
	return s.lastVerify, s.lastVerifyOK
}

func (s *stubSourceManagerServer) retryTierSettings() retryTierSettings {
	if s.rt == (retryTierSettings{}) {
		return retryTierSettingsFromPreferences(serverapi.UIPreferences{})
	}

	return s.rt
}

func TestFindClosestNextVerifyTime(t *testing.T) {
	src := snapshot.SourceInfo{Host: "h", UserName: "u", Path: "/x"}

	t.Run("manual never schedules", func(t *testing.T) {
		stub := &stubSourceManagerServer{}
		sm := &sourceManager{server: stub, src: src, verifyPol: policy.VerifySchedulingPolicy{
			SchedulingPolicy: policy.SchedulingPolicy{Manual: true, IntervalSeconds: 3600},
		}}

		require.Nil(t, sm.findClosestNextVerifyTimeReadLocked())
	})

	t.Run("unconfigured never schedules", func(t *testing.T) {
		stub := &stubSourceManagerServer{}
		sm := &sourceManager{server: stub, src: src}

		require.Nil(t, sm.findClosestNextVerifyTimeReadLocked())
	})

	t.Run("a configured interval schedules, using the stored last-verify time", func(t *testing.T) {
		stub := &stubSourceManagerServer{lastVerify: time.Now().Add(-48 * time.Hour), lastVerifyOK: true}
		sm := &sourceManager{server: stub, src: src, lastCompleteSnapshot: &snapshot.Manifest{ID: "s1"}, verifyPol: policy.VerifySchedulingPolicy{
			SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: 86400},
		}}

		got := sm.findClosestNextVerifyTimeReadLocked()
		require.NotNil(t, got)
		require.False(t, got.After(time.Now()), "interval already elapsed twice over, so it's due now")
	})

	t.Run("never verified before still schedules from now", func(t *testing.T) {
		stub := &stubSourceManagerServer{} // lastVerifyOK: false
		sm := &sourceManager{server: stub, src: src, lastCompleteSnapshot: &snapshot.Manifest{ID: "s1"}, verifyPol: policy.VerifySchedulingPolicy{
			SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: 86400},
		}}

		got := sm.findClosestNextVerifyTimeReadLocked()
		require.NotNil(t, got)
		require.False(t, got.After(time.Now()), "a zero previous time has already elapsed any interval")
	})

	t.Run("nothing to verify yet never schedules", func(t *testing.T) {
		stub := &stubSourceManagerServer{}
		sm := &sourceManager{server: stub, src: src, verifyPol: policy.VerifySchedulingPolicy{
			SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: 86400},
		}}

		require.Nil(t, sm.findClosestNextVerifyTimeReadLocked(), "no complete snapshot: nothing to verify, don't busy-loop offering it anyway")
	})
}

// TestFindClosestNextVerifyTimeRetryDueTime covers the retry-tier branch directly: an active verifyRetry
// cycle takes over the due-time computation instead of the natural schedule, until it clears.
func TestFindClosestNextVerifyTimeRetryDueTime(t *testing.T) {
	src := snapshot.SourceInfo{Host: "h", UserName: "u", Path: "/x"}
	rt := retryTierSettingsFromPreferences(serverapi.UIPreferences{RetryTierThresholdHours: 1, OftenRetryIntervalMinutes: 1})
	lastAttempt := time.Now()

	stub := &stubSourceManagerServer{rt: rt}
	sm := &sourceManager{
		server: stub, src: src, lastCompleteSnapshot: &snapshot.Manifest{ID: "s1"},
		verifyPol:               policy.VerifySchedulingPolicy{SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: 86400}},
		lastAttemptedVerifyTime: lastAttempt,
		verifyRetry:             retryState{often: true, attemptsUsed: 1},
	}

	got := sm.findClosestNextVerifyTimeReadLocked()
	require.NotNil(t, got)
	require.True(t, lastAttempt.Add(time.Minute).Equal(*got), "an active retry cycle uses lastAttempted+delay, not the natural daily schedule")
}
