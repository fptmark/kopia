package server

import (
	"context"

	"github.com/kopia/kopia/internal/serverapi"
)

func (s *Server) currentVerifier() *verifier {
	s.serverMutex.RLock()
	defer s.serverMutex.RUnlock()

	return s.verify
}

func handleVerifyStatus(_ context.Context, rc requestContext) (any, *apiError) {
	if srv, ok := rc.srv.(*Server); ok {
		if v := srv.currentVerifier(); v != nil {
			return v.getStatus(), nil
		}
	}

	return serverapi.VerifyStatus{State: "unknown", Checks: []serverapi.VerifyCheck{}}, nil
}

// handleVerifyRun starts the full health check in the background.
func handleVerifyRun(ctx context.Context, rc requestContext) (any, *apiError) {
	srv, ok := rc.srv.(*Server)
	if !ok || srv.currentVerifier() == nil {
		return nil, requestError(serverapi.ErrorNotConnected, "the health check is not running")
	}

	v := srv.currentVerifier()

	go v.runDeep(context.WithoutCancel(ctx), "manual")

	return serverapi.Empty{}, nil
}

// handleVerifyTestNotification sends a test message so the notification setup can be checked.
func handleVerifyTestNotification(ctx context.Context, rc requestContext) (any, *apiError) {
	srv, ok := rc.srv.(*Server)
	if !ok || srv.notifyHub == nil {
		return nil, requestError(serverapi.ErrorNotConnected, "notifications are not set up")
	}

	if err := srv.notifyHub.SendTest(ctx, ""); err != nil {
		return nil, internalServerError(err)
	}

	return serverapi.Empty{}, nil
}
