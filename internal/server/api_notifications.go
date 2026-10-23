package server

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"sync"

	"github.com/kopia/kopia/internal/notifyhub"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/internal/taskstore"
)

// notificationDestinations is the body of the destinations calls.
type notificationDestinations struct {
	Destinations []notifyhub.Destination `json:"destinations"`
}

type notificationPreview struct {
	Immediate []notifyhub.Message `json:"immediate"`
}

var notificationFileMutex sync.Mutex //nolint:gochecknoglobals

func notificationHub(rc requestContext) (*notifyhub.Hub, *apiError) {
	if srv, ok := rc.srv.(*Server); ok && srv.notifyHub != nil {
		return srv.notifyHub, nil
	}

	return nil, requestError(serverapi.ErrorNotConnected, "notifications are not set up")
}

func handleNotificationDestinationsGet(_ context.Context, rc requestContext) (any, *apiError) {
	h, apiErr := notificationHub(rc)
	if apiErr != nil {
		return nil, apiErr
	}

	ds, err := notifyhub.Load(h.Path)
	if err != nil {
		return nil, internalServerError(err)
	}

	if ds == nil {
		ds = []notifyhub.Destination{}
	}

	return notificationDestinations{Destinations: ds}, nil
}

func handleNotificationDestinationsPut(_ context.Context, rc requestContext) (any, *apiError) {
	h, apiErr := notificationHub(rc)
	if apiErr != nil {
		return nil, apiErr
	}

	var in notificationDestinations
	if err := json.Unmarshal(rc.body, &in); err != nil {
		return nil, requestError(serverapi.ErrorMalformedRequest, "malformed request")
	}

	if err := notifyhub.Validate(in.Destinations); err != nil {
		return nil, requestError(serverapi.ErrorMalformedRequest, err.Error())
	}

	notificationFileMutex.Lock()
	defer notificationFileMutex.Unlock()

	if err := notifyhub.Save(h.Path, in.Destinations); err != nil {
		return nil, internalServerError(err)
	}

	return serverapi.Empty{}, nil
}

func handleNotificationDestinationTest(ctx context.Context, rc requestContext) (any, *apiError) {
	h, apiErr := notificationHub(rc)
	if apiErr != nil {
		return nil, apiErr
	}

	if err := h.SendTest(ctx, rc.muxVar("id")); err != nil {
		return nil, internalServerError(err)
	}

	return serverapi.Empty{}, nil
}

func handleNotificationPreview(_ context.Context, rc requestContext) (any, *apiError) {
	h, apiErr := notificationHub(rc)
	if apiErr != nil {
		return nil, apiErr
	}

	ds, err := notifyhub.Load(h.Path)
	if err != nil {
		return nil, internalServerError(err)
	}

	id := rc.queryParam("destination")

	for _, d := range ds {
		if d.ID == id {
			home, herr := os.UserHomeDir()
			if herr != nil {
				home = "/Users/me"
			}

			return notificationPreview{Immediate: notifyhub.SampleImmediate(d, home)}, nil
		}
	}

	return nil, requestError(serverapi.ErrorNotFound, "no such destination")
}

func handleNotificationLog(_ context.Context, rc requestContext) (any, *apiError) {
	srv, ok := rc.srv.(*Server)
	if !ok || srv.options.TaskHistory == nil {
		return []taskstore.NotificationEntry{}, nil
	}

	limit, _ := strconv.Atoi(rc.queryParam("limit"))

	entries, err := srv.options.TaskHistory.Notifications(limit)
	if err != nil {
		return nil, internalServerError(err)
	}

	return entries, nil
}
