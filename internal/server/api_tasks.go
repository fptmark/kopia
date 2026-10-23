package server

import (
	"context"
	"net/url"
	"strconv"
	"time"

	"github.com/kopia/kopia/internal/ignoreerr"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/internal/uitask"
)

func parseTaskQuery(v url.Values) (uitask.TaskQuery, *apiError) {
	q := uitask.TaskQuery{
		Status: v.Get("status"),
		Kind:   v.Get("kind"),
		Text:   v.Get("q"),
	}

	for name, dst := range map[string]*time.Time{"from": &q.From, "to": &q.To} {
		if s := v.Get(name); s != "" {
			t, err := time.Parse(time.RFC3339, s)
			if err != nil {
				return q, requestError(serverapi.ErrorMalformedRequest, "invalid "+name+" time")
			}

			*dst = t
		}
	}

	if s := v.Get("before"); s != "" {
		seq, ok := uitask.ParseTaskID(s)
		if !ok {
			return q, requestError(serverapi.ErrorMalformedRequest, "invalid before task")
		}

		q.BeforeSeq = seq
	}

	if s := v.Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 0 {
			return q, requestError(serverapi.ErrorMalformedRequest, "invalid limit")
		}

		q.Limit = n
	}

	return q, nil
}

func handleTaskList(ctx context.Context, rc requestContext) (any, *apiError) {
	q, aerr := parseTaskQuery(rc.req.URL.Query())
	if aerr != nil {
		return nil, aerr
	}

	tasks, total, err := rc.srv.taskManager().QueryTasks(ctx, q)
	if err != nil {
		return nil, internalServerError(err)
	}

	if tasks == nil {
		tasks = []uitask.Info{}
	}

	for i := range tasks {
		hideIgnoredFailures(rc, &tasks[i])
	}

	resp := serverapi.TaskListResponse{Tasks: tasks, Total: total}

	if h := rc.srv.getOptions().TaskHistory; h != nil {
		resp.History = true

		if kinds, err := h.Kinds(); err == nil {
			resp.Kinds = kinds
		}
	}

	return resp, nil
}

func handleTaskInfo(_ context.Context, rc requestContext) (any, *apiError) {
	taskID := rc.muxVar("taskID")

	t, ok := rc.srv.taskManager().GetTask(taskID)
	if !ok {
		return nil, notFoundError("task not found")
	}

	hideIgnoredFailures(rc, &t)

	return t, nil
}

// hideIgnoredFailures moves the failed files that ignore rules hide out of the task's failed count.
func hideIgnoredFailures(rc requestContext, t *uitask.Info) {
	srv, ok := rc.srv.(*Server)
	if !ok || srv.ignored == nil || t.FailedFiles == 0 || len(srv.ignored.Rules()) == 0 {
		return
	}

	h := srv.getOptions().TaskHistory
	if h == nil {
		return
	}

	src, err := h.SnapshotSource(t.TaskID)
	if err != nil {
		return
	}

	errs, err := h.SnapshotErrors(t.TaskID)
	if err != nil {
		return
	}

	n := 0

	for _, e := range errs {
		if srv.ignored.Ignored(sourcePath(src), e.Path, e.Error) {
			n++
		}
	}

	n = min(n, t.FailedFiles)
	t.FailedFiles -= n
	t.IgnoredFiles = n
}

func handleTaskSummary(_ context.Context, rc requestContext) (any, *apiError) {
	return rc.srv.taskManager().TaskSummary(), nil
}

func handleTaskLogs(_ context.Context, rc requestContext) (any, *apiError) {
	taskID := rc.muxVar("taskID")

	return serverapi.TaskLogResponse{
		Logs: rc.srv.taskManager().TaskLog(taskID),
	}, nil
}

// handleTaskErrors lists the files that failed in a snapshot task, as recorded when it ran.
func handleTaskErrors(_ context.Context, rc requestContext) (any, *apiError) {
	resp := serverapi.TaskErrorsResponse{Errors: []serverapi.TaskError{}}

	h := rc.srv.getOptions().TaskHistory
	if h == nil {
		return resp, nil
	}

	errs, err := h.SnapshotErrors(rc.muxVar("taskID"))
	if err != nil {
		return nil, internalServerError(err)
	}

	src, _ := h.SnapshotSource(rc.muxVar("taskID"))
	resp.Source = sourcePath(src)
	resp.UserName, resp.Host = sourceUserHost(src)

	var ignored *ignoreerr.Store
	if srv, ok := rc.srv.(*Server); ok {
		ignored = srv.ignored
	}

	for _, e := range errs {
		resp.Errors = append(resp.Errors, serverapi.TaskError{
			Path: e.Path, Error: e.Error,
			Kind:    ignoreerr.KindOf(e.Error),
			Ignored: ignored.Ignored(resp.Source, e.Path, e.Error),
		})
	}

	return resp, nil
}

func handleTaskCancel(_ context.Context, rc requestContext) (any, *apiError) {
	rc.srv.taskManager().CancelTask(rc.muxVar("taskID"))

	return &serverapi.Empty{}, nil
}

// handleStorageUsageHistory lists the repository sizes recorded by earlier calculations.
func handleStorageUsageHistory(_ context.Context, rc requestContext) (any, *apiError) {
	h := rc.srv.getOptions().TaskHistory
	if h == nil {
		return []any{}, nil
	}

	hist, err := h.StorageUsageHistory(500) //nolint:mnd
	if err != nil {
		return nil, internalServerError(err)
	}

	return hist, nil
}
