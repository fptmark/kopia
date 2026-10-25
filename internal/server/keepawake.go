package server

import (
	"context"
)

// keepAwake prevents the machine from sleeping while a snapshot, verify or health check runs, according to
// the KeepAwake UI preference, and returns a function that releases the hold.
// It is a no-op on platforms that do not support it.
func (s *Server) keepAwake(ctx context.Context) func() {
	p, err := getUIPreferencesOrEmpty(s)
	if err != nil {
		userLog(ctx).Errorf("unable to read keep-awake preference: %v", err)
		return func() {}
	}

	// an operation that is interrupted by sleep stalls on a dead NAS connection, so always hold at least idle sleep
	mode := p.KeepAwake
	if mode != "ac" {
		mode = "idle"
	}

	return preventSleep(ctx, mode)
}
