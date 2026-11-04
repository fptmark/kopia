package server

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/internal/uitask"
	"github.com/kopia/kopia/notification/notifydata"
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

func (s *stubSourceManagerServer) refreshScheduler(string) {}

func (s *stubSourceManagerServer) lastVerificationTime(snapshot.SourceInfo, string) (time.Time, bool) {
	return s.lastVerify, s.lastVerifyOK
}

func (s *stubSourceManagerServer) systemRecentlyUnstable() bool { return false }

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
		sm := &sourceManager{server: stub, src: src, verifyPol: policy.VerifySchedulingPolicy{
			SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: 86400},
		}}

		got := sm.findClosestNextVerifyTimeReadLocked()
		require.NotNil(t, got)
		require.False(t, got.After(time.Now()), "interval already elapsed twice over, so it's due now")
	})

	t.Run("never verified before still schedules from now", func(t *testing.T) {
		stub := &stubSourceManagerServer{} // lastVerifyOK: false
		sm := &sourceManager{server: stub, src: src, verifyPol: policy.VerifySchedulingPolicy{
			SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: 86400},
		}}

		got := sm.findClosestNextVerifyTimeReadLocked()
		require.NotNil(t, got)
		require.False(t, got.After(time.Now()), "a zero previous time has already elapsed any interval")
	})
}

// TestClassifyVerifyRetryTier mirrors classifySnapshotRetryTier's coverage (retry_tier_test.go /
// source_manager_retry_test.go) for the Verify side: classification must use the policy's own interval,
// not how overdue the source happens to be right now.
func TestClassifyVerifyRetryTier(t *testing.T) {
	src := snapshot.SourceInfo{Host: "h", UserName: "u", Path: "/x"}
	rt := retryTierSettingsFromPreferences(serverapi.UIPreferences{RetryTierThresholdHours: 1})
	now := time.Now()

	t.Run("short interval is often", func(t *testing.T) {
		stub := &stubSourceManagerServer{rt: rt}
		sm := &sourceManager{server: stub, src: src, verifyPol: policy.VerifySchedulingPolicy{
			SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: 1800}, // 30 min
		}}

		often, ok := sm.classifyVerifyRetryTier(rt, now)
		require.True(t, ok)
		require.True(t, often)
	})

	t.Run("daily time-of-day is occasional", func(t *testing.T) {
		stub := &stubSourceManagerServer{rt: rt}
		sm := &sourceManager{server: stub, src: src, verifyPol: policy.VerifySchedulingPolicy{
			SchedulingPolicy: policy.SchedulingPolicy{TimesOfDay: []policy.TimeOfDay{{Hour: 3}}},
		}}

		often, ok := sm.classifyVerifyRetryTier(rt, now)
		require.True(t, ok)
		require.False(t, often)
	})
}

func TestVerifyTriggerArgsNeedsACompleteSnapshot(t *testing.T) {
	sm := &sourceManager{verifyPol: policy.VerifySchedulingPolicy{Mode: policy.VerifyModeSample, Percent: 25}}

	_, _, _, ok := sm.verifyTriggerArgs()
	require.False(t, ok, "nothing to verify without a complete snapshot yet")

	m := &snapshot.Manifest{ID: "s1"}
	sm.lastCompleteSnapshot = m

	got, mode, percent, ok := sm.verifyTriggerArgs()
	require.True(t, ok)
	require.Same(t, m, got)
	require.Equal(t, policy.VerifyModeSample, mode)
	require.InDelta(t, 25, percent, 0.01)
}
