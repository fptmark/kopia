package server

import "time"

// defaultStorageStallTimeout is used when the StorageStallTimeoutSeconds UI preference is unset (0): the
// same 30s default uitask.Manager itself falls back to, spelled out here so a bad/negative stored value
// degrades to the same safe default rather than disabling the watchdog outright.
const defaultStorageStallTimeout = 30 * time.Second

// storageStallTimeout is read fresh for every running task (see uitask.Manager.StallTimeout), so changing
// the preference in the GUI takes effect on the very next Snapshot/Verify/Maintenance without a server
// restart.
func (s *Server) storageStallTimeout() time.Duration {
	p, err := getUIPreferencesOrEmpty(s)
	if err != nil || p.StorageStallTimeoutSeconds <= 0 {
		return defaultStorageStallTimeout
	}

	return time.Duration(p.StorageStallTimeoutSeconds) * time.Second
}

// defaultWakeGrace is used when the WakeGraceSeconds UI preference is unset (0) or invalid, and whenever s is
// nil (a verifier built without a Server, as some tests do). Replaces a previous hardcoded 90-minute
// constant that was never measured against how long a connection actually takes to settle after a real
// sleep/wake -- 5 minutes is a deliberately conservative interim value pending that measurement, not a
// considered final answer.
const defaultWakeGrace = 5 * time.Minute

// wakeGraceDuration is how long, after the verifier detects a gap consistent with the machine having just
// woken from sleep, background work stays deferred and stale-snapshot reporting stays quiet. Read fresh on
// every detected gap (see verifier.tick), so changing the preference in the GUI takes effect on the next
// wake without a server restart.
func (s *Server) wakeGraceDuration() time.Duration {
	if s == nil {
		return defaultWakeGrace
	}

	p, err := getUIPreferencesOrEmpty(s)
	if err != nil || p.WakeGraceSeconds <= 0 {
		return defaultWakeGrace
	}

	return time.Duration(p.WakeGraceSeconds) * time.Second
}
