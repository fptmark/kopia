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
