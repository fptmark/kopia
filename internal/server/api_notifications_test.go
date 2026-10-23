package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/gorilla/mux"
	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/notifyhub"
	"github.com/kopia/kopia/internal/taskstore"
)

func notificationServer(t *testing.T) *Server {
	t.Helper()

	hist, err := taskstore.Open(filepath.Join(t.TempDir(), "h.db"))
	require.NoError(t, err)
	t.Cleanup(func() { hist.Close() }) //nolint:errcheck

	s := &Server{options: Options{UIPreferencesFile: filepath.Join(t.TempDir(), "ui-preferences.json"), TaskHistory: hist}}
	s.setupNotifications(context.Background())
	require.NotNil(t, s.notifyHub)

	return s
}

func rcFor(s *Server, method, target, body string, vars map[string]string) requestContext {
	req := httptest.NewRequest(method, target, nil)
	req = mux.SetURLVars(req, vars)

	return requestContext{srv: s, req: req, body: []byte(body)}
}

type fakeSender struct{ got []string }

func (f *fakeSender) Send(_ context.Context, d notifyhub.Destination, title, _ string) error {
	f.got = append(f.got, d.ID+":"+title)
	return nil
}

func TestNotificationDestinationsRoundTripAndValidation(t *testing.T) {
	s := notificationServer(t)
	ctx := context.Background()

	out, apiErr := handleNotificationDestinationsGet(ctx, rcFor(s, http.MethodGet, "/", "", nil))
	require.Nil(t, apiErr)
	require.Len(t, out.(notificationDestinations).Destinations, 1, "the default This Mac destination")

	body := `{"destinations":[{"id":"a","type":"imessage","name":"Me","target":"+1 555 0100","events":{"failed":"now","skipped":"roll"},"rollup":{"freq":"weekly","weekday":2,"time":"07:30"}}]}`
	_, apiErr = handleNotificationDestinationsPut(ctx, rcFor(s, http.MethodPut, "/", body, nil))
	require.Nil(t, apiErr)

	out, _ = handleNotificationDestinationsGet(ctx, rcFor(s, http.MethodGet, "/", "", nil))
	b, _ := json.Marshal(out)
	require.JSONEq(t, body, string(b))

	for _, bad := range []string{
		`{"destinations":[{"id":"a","type":"fax","name":"x"}]}`,
		`{"destinations":[{"id":"a","type":"imessage","name":"x"}]}`,
		`{"destinations":[{"id":"a","type":"mac","name":"x","rollup":{"freq":"hourly","time":"08:00"}}]}`,
		`not json`,
	} {
		_, apiErr = handleNotificationDestinationsPut(ctx, rcFor(s, http.MethodPut, "/", bad, nil))
		require.NotNil(t, apiErr, bad)
	}

	out, _ = handleNotificationDestinationsGet(ctx, rcFor(s, http.MethodGet, "/", "", nil))
	require.Len(t, out.(notificationDestinations).Destinations, 1, "a rejected save changes nothing")

	// deleting the last destination is allowed and stays deleted
	_, apiErr = handleNotificationDestinationsPut(ctx, rcFor(s, http.MethodPut, "/", `{"destinations":[]}`, nil))
	require.Nil(t, apiErr)
	out, _ = handleNotificationDestinationsGet(ctx, rcFor(s, http.MethodGet, "/", "", nil))
	require.Empty(t, out.(notificationDestinations).Destinations)
}

func TestNotificationTestAndLogAndPreview(t *testing.T) {
	s := notificationServer(t)
	ctx := context.Background()
	f := &fakeSender{}
	s.notifyHub.Providers = map[string]notifyhub.Provider{notifyhub.TypeMac: f, notifyhub.TypeIMessage: f}

	_, apiErr := handleNotificationDestinationTest(ctx, rcFor(s, http.MethodPost, "/", "", map[string]string{"id": "mac"}))
	require.Nil(t, apiErr)
	require.Equal(t, []string{"mac:Backup test message"}, f.got)

	_, apiErr = handleNotificationDestinationTest(ctx, rcFor(s, http.MethodPost, "/", "", map[string]string{"id": "nope"}))
	require.NotNil(t, apiErr)

	// the send was recorded; the hub's record call is synchronous for tests
	time.Sleep(10 * time.Millisecond)

	out, apiErr := handleNotificationLog(ctx, rcFor(s, http.MethodGet, "/?limit=5", "", nil))
	require.Nil(t, apiErr)
	log := out.([]taskstore.NotificationEntry)
	require.Len(t, log, 1)
	require.Equal(t, "test", log[0].Event)

	out, apiErr = handleNotificationPreview(ctx, rcFor(s, http.MethodGet, "/?destination=mac", "", nil))
	require.Nil(t, apiErr)

	titles := []string{}
	for _, m := range out.(notificationPreview).Immediate {
		titles = append(titles, m.Title)
	}

	require.Contains(t, titles, "Snapshot failed")
	require.NotContains(t, titles, "Files skipped", "the Mac popup default is not told about skipped files")

	_, apiErr = handleNotificationPreview(ctx, rcFor(s, http.MethodGet, "/?destination=zzz", "", nil))
	require.NotNil(t, apiErr)
}
