package server

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/kopia/kopia/internal/clock"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/internal/taskstore"
)

func (s *Server) currentVerifier() *verifier {
	return s.verify.Load()
}

// describeFailingVerification turns one failing taskstore.Verification into the banner's short badge and its
// full-reason tooltip.
func describeFailingVerification(v taskstore.Verification) (badge, detail string) {
	if v.Mode == taskstore.VerifyModeNew {
		detail = "The data this snapshot added doesn't read back."
		if v.Error != "" {
			detail += " " + v.Error
		}

		return "New data", detail
	}

	scope := "every file"
	if v.Mode == taskstore.VerifyModeSample {
		scope = fmt.Sprintf("a %v%% sample of the files", v.Percent)
	}

	return fmt.Sprintf("%d failed", v.ErrorCount),
		fmt.Sprintf("%d of %d files failed to read back during a check of %s.", v.ErrorCount, v.Files, scope)
}

func failingSnapshots(h *taskstore.Store) []serverapi.FailingSnapshot {
	out := []serverapi.FailingSnapshot{}

	if h == nil {
		return out
	}

	vs, err := h.FailingVerifications()
	if err != nil {
		return out
	}

	for _, v := range vs {
		badge, detail := describeFailingVerification(v)
		out = append(out, serverapi.FailingSnapshot{
			ID: v.ID, SnapshotID: v.SnapshotID, Source: v.Source, Mode: v.Mode, Percent: v.Percent,
			FinishedAt: v.FinishedAt, Files: v.Files, ReadBytes: v.ReadBytes, ErrorCount: v.ErrorCount,
			TaskID: v.TaskID, Badge: badge, Detail: detail,
		})
	}

	return out
}

func handleVerifyStatus(_ context.Context, rc requestContext) (any, *apiError) {
	srv, ok := rc.srv.(*Server)
	if !ok {
		return serverapi.VerifyStatus{State: "unknown", Checks: []serverapi.VerifyCheck{}, FailingSnapshots: []serverapi.FailingSnapshot{}}, nil
	}

	st := serverapi.VerifyStatus{State: "unknown", Checks: []serverapi.VerifyCheck{}}
	if v := srv.currentVerifier(); v != nil {
		st = v.getStatus()
	}

	st.FailingSnapshots = failingSnapshots(srv.options.TaskHistory)
	st.ClearedTaskIDs = clearedTaskIDs(srv.options.TaskHistory)

	return st, nil
}

func clearedTaskIDs(h *taskstore.Store) []string {
	if h == nil {
		return []string{}
	}

	ids, err := h.RecentlyClearedTaskIDs(clock.Now().Add(-verifyNewDataWindow))
	if err != nil {
		return []string{}
	}

	return ids
}

type verifyDismissRequest struct {
	IDs []int64 `json:"ids"`
}

// handleVerifyDismiss hides the given failing verifications from the banner until a newer verification of the
// same source and mode replaces them; it does not change the stored verification result itself.
func handleVerifyDismiss(_ context.Context, rc requestContext) (any, *apiError) {
	srv, ok := rc.srv.(*Server)
	if !ok || srv.options.TaskHistory == nil {
		return nil, requestError(serverapi.ErrorNotConnected, "verification history is not available")
	}

	var req verifyDismissRequest
	if err := json.Unmarshal(rc.body, &req); err != nil {
		return nil, requestError(serverapi.ErrorMalformedRequest, "malformed request body")
	}

	if err := srv.options.TaskHistory.DismissVerifications(req.IDs); err != nil {
		return nil, internalServerError(err)
	}

	return serverapi.Empty{}, nil
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
