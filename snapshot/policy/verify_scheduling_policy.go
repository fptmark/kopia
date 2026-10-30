package policy

import (
	"time"

	"github.com/pkg/errors"

	"github.com/kopia/kopia/snapshot"
)

// Verify modes a periodic verify can run: a share of the files, or every file. "new" (the data a snapshot
// just added) is not one of these -- that is a per-snapshot check, not a schedule of its own.
const (
	VerifyModeSample = "sample"
	VerifyModeFull   = "full"
)

// VerifySchedulingPolicy describes when a source's most recent snapshot is periodically read back and
// checked, and how much of it to check. It has its own schedule, independent of the snapshot schedule above,
// reusing the exact same time-of-day/cron/interval shape and math as a named field (not embedded: every other
// nested policy struct in this package uses a named field, and ensureTypesMatch in policy_merge_test.go
// requires the same field name and json tag on both sides of Policy/Definition).
type VerifySchedulingPolicy struct {
	SchedulingPolicy SchedulingPolicy `json:"scheduling,omitempty"`

	// Mode is VerifyModeSample (the default) or VerifyModeFull.
	Mode string `json:"mode,omitempty"`
	// Percent is the share of files read back when Mode is VerifyModeSample: more than 0, less than 100.
	Percent float64 `json:"percent,omitempty"`
}

// VerifySchedulingPolicyDefinition specifies which policy definition provided the value of a particular field.
type VerifySchedulingPolicyDefinition struct {
	SchedulingPolicy SchedulingPolicyDefinition `json:"scheduling,omitempty"`

	Mode    snapshot.SourceInfo `json:"mode,omitempty"`
	Percent snapshot.SourceInfo `json:"percent,omitempty"`
}

const defaultVerifyPercent = 10.0

// Merge applies default values from the provided policy.
func (p *VerifySchedulingPolicy) Merge(src VerifySchedulingPolicy, def *VerifySchedulingPolicyDefinition, si snapshot.SourceInfo) {
	p.SchedulingPolicy.Merge(src.SchedulingPolicy, &def.SchedulingPolicy, si)
	mergeString(&p.Mode, src.Mode, &def.Mode, si)
	mergeFloat64(&p.Percent, src.Percent, &def.Percent, si)
}

// ValidateVerifySchedulingPolicy returns an error if the policy's own scheduling fields are invalid, or if
// Mode/Percent don't make sense together.
func ValidateVerifySchedulingPolicy(p VerifySchedulingPolicy) error {
	if err := ValidateSchedulingPolicy(p.SchedulingPolicy); err != nil {
		return err
	}

	if p.SchedulingPolicy.Manual {
		return nil
	}

	switch p.Mode {
	case "", VerifyModeSample, VerifyModeFull:
	default:
		return errors.Errorf("invalid verify mode %q: must be %q or %q", p.Mode, VerifyModeSample, VerifyModeFull)
	}

	if p.Mode == VerifyModeSample && p.Percent != 0 && (p.Percent <= 0 || p.Percent >= 100) {
		return errors.New("verify percent must be more than 0 and less than 100")
	}

	return nil
}

// NextVerifyTime computes the next time this policy's schedule is due, given when the source was last
// verified (zero if never) and the current time -- the same time math SchedulingPolicy uses for snapshots.
func (p *VerifySchedulingPolicy) NextVerifyTime(previousVerifyTime, now time.Time) (time.Time, bool) {
	return p.SchedulingPolicy.NextSnapshotTime(previousVerifyTime, now)
}

// EffectiveMode and EffectivePercent are what a scheduled verify actually runs with, filling in the defaults
// an empty policy leaves unset.
func (p *VerifySchedulingPolicy) EffectiveMode() string {
	if p.Mode == "" {
		return VerifyModeSample
	}

	return p.Mode
}

func (p *VerifySchedulingPolicy) EffectivePercent() float64 {
	if p.Mode == VerifyModeFull {
		return 100
	}

	if p.Percent <= 0 {
		return defaultVerifyPercent
	}

	return p.Percent
}
