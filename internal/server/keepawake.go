package server

import (
	"context"
)

// keepAwake prevents the machine from sleeping while a snapshot runs, according to
// the KeepAwake UI preference, and returns a function that releases the hold.
// It is a no-op on platforms that do not support it.
func (s *Server) keepAwake(ctx context.Context) func() {
	p, err := getUIPreferencesOrEmpty(s)
	if err != nil {
		userLog(ctx).Errorf("unable to read keep-awake preference: %v", err)
		return func() {}
	}

	return preventSleep(ctx, p.KeepAwake)
}
