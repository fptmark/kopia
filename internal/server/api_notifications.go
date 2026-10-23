package server

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/kopia/kopia/internal/clock"
	"github.com/kopia/kopia/internal/notifyhub"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/internal/taskstore"
)

// notificationDestinations is the body of the destinations calls.
type notificationDestinations struct {
	// RepeatSeconds is how long a failure that goes on is held back between messages to one destination.
	RepeatSeconds int                     `json:"repeatSeconds"`
	Destinations  []notifyhub.Destination `json:"destinations"`
}

type notificationPreview struct {
	Immediate []notifyhub.Message `json:"immediate"`
	// Summary is the periodic summary the destination would get, from the latest real data (nil when none).
	Summary *notifyhub.Message `json:"summary"`
}

// mailAccountsTimeout allows for the Mail app to start.
const mailAccountsTimeout = 30 * time.Second

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

	set, err := notifyhub.LoadSettings(h.Path)
	if err != nil {
		return nil, internalServerError(err)
	}

	if set.Destinations == nil {
		set.Destinations = []notifyhub.Destination{}
	}

	return notificationDestinations{RepeatSeconds: set.RepeatSeconds, Destinations: set.Destinations}, nil
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

	notificationFileMutex.Lock()
	defer notificationFileMutex.Unlock()

	// a client that does not send the repeat period keeps the one in the file
	if in.RepeatSeconds == 0 {
		cur, err := notifyhub.LoadSettings(h.Path)
		if err != nil {
			return nil, internalServerError(err)
		}

		in.RepeatSeconds = cur.RepeatSeconds
	}

	set := notifyhub.Settings{RepeatSeconds: in.RepeatSeconds, Destinations: in.Destinations}
	if err := notifyhub.ValidateSettings(set); err != nil {
		return nil, requestError(serverapi.ErrorMalformedRequest, err.Error())
	}

	if err := notifyhub.SaveSettings(h.Path, set); err != nil {
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

func handleNotificationPreview(ctx context.Context, rc requestContext) (any, *apiError) {
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

			p := notificationPreview{Immediate: notifyhub.SampleImmediate(d, home)}

			if srv, ok := rc.srv.(*Server); ok && d.Success.Scheduled() {
				now := clock.Now()

				if sum, serr := srv.buildSummary(ctx, now.Add(-notifyhub.Period(d.Success.Freq)), now, d.Success.Freq); serr == nil {
					sum.Freq = d.Success.Freq
					title, body := notifyhub.RenderSummary(sum)
					p.Summary = &notifyhub.Message{Title: title, Body: body}
				}
			}

			return p, nil
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

// listMailAccounts is replaced in tests.
var listMailAccounts = notifyhub.MailAccounts //nolint:gochecknoglobals

type mailAccounts struct {
	Accounts []notifyhub.MailAccount `json:"accounts"`
}

// handleMailAccounts lists the accounts in the Mail app, so an email destination can choose which one sends.
func handleMailAccounts(ctx context.Context, _ requestContext) (any, *apiError) {
	ctx, cancel := context.WithTimeout(ctx, mailAccountsTimeout)
	defer cancel()

	accts, err := listMailAccounts(ctx)
	if err != nil {
		return nil, internalServerError(err)
	}

	return mailAccounts{Accounts: accts}, nil
}
