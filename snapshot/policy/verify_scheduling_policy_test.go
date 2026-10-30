package policy_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/snapshot/policy"
)

func TestVerifySchedulingPolicyNextVerifyTimeReusesSchedulingPolicyMath(t *testing.T) {
	p := policy.VerifySchedulingPolicy{
		SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: 3600},
	}

	now := time.Date(2026, time.October, 27, 12, 0, 0, 0, time.Local)
	previous := now.Add(-90 * time.Minute)

	got, ok := p.NextVerifyTime(previous, now)
	require.True(t, ok)
	require.Equal(t, now, got, "interval already elapsed, so the next verify is due right now")

	// an empty policy (nothing configured, the default) never becomes due
	_, ok = (&policy.VerifySchedulingPolicy{}).NextVerifyTime(previous, now)
	require.False(t, ok)
}

func TestVerifySchedulingPolicyEffectiveModeAndPercent(t *testing.T) {
	cases := []struct {
		name        string
		pol         policy.VerifySchedulingPolicy
		wantMode    string
		wantPercent float64
	}{
		{name: "unset defaults to a sample", wantMode: policy.VerifyModeSample, wantPercent: 10},
		{
			name:        "sample with an explicit percent",
			pol:         policy.VerifySchedulingPolicy{Mode: policy.VerifyModeSample, Percent: 25},
			wantMode:    policy.VerifyModeSample,
			wantPercent: 25,
		},
		{
			name:        "full ignores any percent",
			pol:         policy.VerifySchedulingPolicy{Mode: policy.VerifyModeFull, Percent: 25},
			wantMode:    policy.VerifyModeFull,
			wantPercent: 100,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.wantMode, tc.pol.EffectiveMode())
			require.Equal(t, tc.wantPercent, tc.pol.EffectivePercent())
		})
	}
}

func TestValidateVerifySchedulingPolicy(t *testing.T) {
	cases := []struct {
		name    string
		pol     policy.VerifySchedulingPolicy
		wantErr bool
	}{
		{name: "empty is valid"},
		{name: "sample with a percent in range", pol: policy.VerifySchedulingPolicy{Mode: policy.VerifyModeSample, Percent: 50}},
		{name: "full needs no percent", pol: policy.VerifySchedulingPolicy{Mode: policy.VerifyModeFull}},
		{
			name:    "unknown mode",
			pol:     policy.VerifySchedulingPolicy{Mode: "new"},
			wantErr: true,
		},
		{
			name:    "sample percent at or above 100",
			pol:     policy.VerifySchedulingPolicy{Mode: policy.VerifyModeSample, Percent: 100},
			wantErr: true,
		},
		{
			name:    "sample percent at or below 0",
			pol:     policy.VerifySchedulingPolicy{Mode: policy.VerifyModeSample, Percent: -5},
			wantErr: true,
		},
		{
			name: "manual skips mode/percent validation",
			pol:  policy.VerifySchedulingPolicy{SchedulingPolicy: policy.SchedulingPolicy{Manual: true}, Mode: "bogus"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := policy.ValidateVerifySchedulingPolicy(tc.pol)
			if tc.wantErr {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
		})
	}
}

func TestVerifySchedulingPolicyMergeInheritsIndependentlyOfSnapshotSchedule(t *testing.T) {
	var merged policy.VerifySchedulingPolicy

	var def policy.VerifySchedulingPolicyDefinition

	src := policy.VerifySchedulingPolicy{
		SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: 86400},
		Mode:             policy.VerifyModeSample,
		Percent:          25,
	}

	merged.Merge(src, &def, policy.GlobalPolicySourceInfo)

	require.Equal(t, int64(86400), merged.SchedulingPolicy.IntervalSeconds)
	require.Equal(t, policy.VerifyModeSample, merged.Mode)
	require.InDelta(t, 25, merged.Percent, 0.01)

	// a value already set locally is not overwritten by the parent/default being merged in
	mineFirst := policy.VerifySchedulingPolicy{Percent: 5}
	mineFirst.Merge(src, &def, policy.GlobalPolicySourceInfo)
	require.InDelta(t, 5, mineFirst.Percent, 0.01, "the more specific policy's own value wins")
}
