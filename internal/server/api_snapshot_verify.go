package server

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/internal/taskstore"
	"github.com/kopia/kopia/repo/manifest"
	"github.com/kopia/kopia/snapshot"
)

const maxSnapshotsPerVerifyRequest = 500

type snapshotsVerifyRequest struct {
	SnapshotIDs []string `json:"snapshotIds"`
	// Mode is full (every file), sample (Percent of the files) or new (the data each snapshot added).
	Mode    string  `json:"mode"`
	Percent float64 `json:"percent"`
}

type snapshotsVerifyResponse struct {
	Started []string `json:"started"`
	// Skipped are snapshots whose verification of this kind is already queued or running.
	Skipped []string `json:"skipped"`
}

func verifyServer(rc requestContext) (*Server, *apiError) {
	if srv, ok := rc.srv.(*Server); ok && srv.taskmgr != nil {
		return srv, nil
	}

	return nil, requestError(serverapi.ErrorNotConnected, "verification is not available")
}

// handleSnapshotsVerify queues a read-back of each given snapshot, one Verify task each, run one at a time.
func handleSnapshotsVerify(ctx context.Context, rc requestContext) (any, *apiError) {
	srv, apiErr := verifyServer(rc)
	if apiErr != nil {
		return nil, apiErr
	}

	var req snapshotsVerifyRequest
	if err := json.Unmarshal(rc.body, &req); err != nil {
		return nil, requestError(serverapi.ErrorMalformedRequest, "malformed request body")
	}

	if len(req.SnapshotIDs) == 0 || len(req.SnapshotIDs) > maxSnapshotsPerVerifyRequest {
		return nil, requestError(serverapi.ErrorMalformedRequest, "send between 1 and 500 snapshots")
	}

	switch req.Mode {
	case taskstore.VerifyModeFull:
		req.Percent = 100
	case taskstore.VerifyModeNew:
		req.Percent = 100
	case taskstore.VerifyModeSample:
		if req.Percent <= 0 || req.Percent >= 100 {
			return nil, requestError(serverapi.ErrorMalformedRequest, "a sample is more than 0 and less than 100 percent")
		}
	default:
		return nil, requestError(serverapi.ErrorMalformedRequest, "mode is full, sample or new")
	}

	ids := make([]manifest.ID, 0, len(req.SnapshotIDs))
	for _, id := range req.SnapshotIDs {
		ids = append(ids, manifest.ID(id))
	}

	manifests, err := snapshot.LoadSnapshots(ctx, rc.rep, ids)
	if err != nil {
		return nil, internalServerError(err)
	}

	if len(manifests) != len(ids) {
		return nil, requestError(serverapi.ErrorNotFound, "a snapshot was not found")
	}

	snapshot.SortByTime(manifests, false)

	out := &snapshotsVerifyResponse{Started: []string{}, Skipped: []string{}}

	for _, m := range manifests {
		if m.IncompleteReason != "" || m.RootEntry == nil {
			return nil, requestError(serverapi.ErrorMalformedRequest, "an incomplete snapshot cannot be verified")
		}

		if srv.startSnapshotVerify(ctx, rc.rep, m, req.Mode, req.Percent) {
			out.Started = append(out.Started, string(m.ID))
		} else {
			out.Skipped = append(out.Skipped, string(m.ID))
		}
	}

	return out, nil
}

type snapshotVerificationsRequest struct {
	SnapshotIDs []string `json:"snapshotIds"`
}

type snapshotVerificationsResponse struct {
	// Verifications are the newest finished ones: per snapshot, one full or sample and one of new data.
	Verifications []taskstore.Verification `json:"verifications"`
	Running       []runningVerify          `json:"running"`
}

// handleSnapshotVerifications reports what is known about the health of the given snapshots.
func handleSnapshotVerifications(_ context.Context, rc requestContext) (any, *apiError) {
	srv, apiErr := verifyServer(rc)
	if apiErr != nil {
		return nil, apiErr
	}

	var req snapshotVerificationsRequest
	if err := json.Unmarshal(rc.body, &req); err != nil {
		return nil, requestError(serverapi.ErrorMalformedRequest, "malformed request body")
	}

	out := &snapshotVerificationsResponse{Verifications: []taskstore.Verification{}, Running: srv.snapVerifs.list(req.SnapshotIDs)}

	if h := srv.getOptions().TaskHistory; h != nil && len(req.SnapshotIDs) > 0 {
		var err error

		out.Verifications, err = h.LatestVerifications(req.SnapshotIDs)
		if err != nil {
			return nil, internalServerError(err)
		}
	}

	return out, nil
}

type verificationFailuresResponse struct {
	Verification taskstore.Verification          `json:"verification"`
	Failures     []taskstore.VerificationFailure `json:"failures"`
}

// handleVerificationFailures lists the files that failed to read back in one verification.
func handleVerificationFailures(_ context.Context, rc requestContext) (any, *apiError) {
	srv, apiErr := verifyServer(rc)
	if apiErr != nil {
		return nil, apiErr
	}

	h := srv.getOptions().TaskHistory
	if h == nil {
		return nil, requestError(serverapi.ErrorNotFound, "no verification history")
	}

	id, err := strconv.ParseInt(rc.muxVar("id"), 10, 64)
	if err != nil {
		return nil, requestError(serverapi.ErrorMalformedRequest, "invalid verification id")
	}

	v, found, err := h.GetVerification(id)
	if err != nil {
		return nil, internalServerError(err)
	}

	if !found {
		return nil, requestError(serverapi.ErrorNotFound, "verification not found")
	}

	limit, _ := strconv.Atoi(rc.queryParam("limit"))

	failures, err := h.VerificationFailures(id, limit)
	if err != nil {
		return nil, internalServerError(err)
	}

	return &verificationFailuresResponse{Verification: v, Failures: failures}, nil
}
