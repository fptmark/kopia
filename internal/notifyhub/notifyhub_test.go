package notifyhub_test

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/notifyhub"
)

type sent struct{ dest, title, body string }

type fakeProvider struct {
	mu       sync.Mutex
	got      []sent
	failures int // fail this many sends first
	calls    int
}

func (f *fakeProvider) Send(_ context.Context, d notifyhub.Destination, title, body string) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.calls++

	if f.failures > 0 {
		f.failures--
		return errors.New("Messages is not running")
	}

	f.got = append(f.got, sent{d.ID, title, body})

	return nil
}

func newHub(t *testing.T, ds []notifyhub.Destination, p *fakeProvider) (*notifyhub.Hub, *[]notifyhub.Entry) {
	t.Helper()

	path := filepath.Join(t.TempDir(), "notification-destinations.json")
	require.NoError(t, notifyhub.Save(path, ds))

	var (
		mu  sync.Mutex
		log []notifyhub.Entry
	)

	h := &notifyhub.Hub{
		Path:      path,
		Providers: map[string]notifyhub.Provider{notifyhub.TypeIMessage: p, notifyhub.TypeMac: p},
		Record: func(e notifyhub.Entry) {
			mu.Lock()
			defer mu.Unlock()
			log = append(log, e)
		},
		Sleep: func(context.Context, time.Duration) {},
	}

	return h, &log
}

func dest(id string, events map[notifyhub.EventID]notifyhub.Mode) notifyhub.Destination {
	return notifyhub.Destination{ID: id, Type: notifyhub.TypeMac, Name: id, Events: events}
}

func TestEmitRoutesByDestinationMode(t *testing.T) {
	p := &fakeProvider{}
	h, log := newHub(t, []notifyhub.Destination{
		dest("now", map[notifyhub.EventID]notifyhub.Mode{notifyhub.EventFailed: notifyhub.ModeNow}),
		dest("off", map[notifyhub.EventID]notifyhub.Mode{notifyhub.EventFailed: notifyhub.ModeOff}),
		dest("roll", map[notifyhub.EventID]notifyhub.Mode{notifyhub.EventFailed: notifyhub.ModeRoll}),
		dest("unset", nil),
	}, p)

	h.Emit(context.Background(), notifyhub.Event{ID: notifyhub.EventFailed, Source: "/Users/me"})
	h.Wait()

	require.Equal(t, []sent{{"now", "Snapshot failed", "/Users/me could not be backed up."}}, p.got)
	require.Len(t, *log, 1)
	require.Equal(t, "sent", (*log)[0].Status)
	require.Equal(t, "failed", (*log)[0].Event)
}

func TestHealthAndWatchdogAreNeverBatched(t *testing.T) {
	p := &fakeProvider{}
	h, _ := newHub(t, []notifyhub.Destination{
		dest("d", map[notifyhub.EventID]notifyhub.Mode{notifyhub.EventHealth: notifyhub.ModeRoll, notifyhub.EventWatchdog: notifyhub.ModeRoll}),
	}, p)

	h.Emit(context.Background(), notifyhub.Event{ID: notifyhub.EventHealth, Checks: []notifyhub.HealthCheck{notifyhub.CheckRecent}})
	h.Emit(context.Background(), notifyhub.Event{ID: notifyhub.EventWatchdog, Problem: notifyhub.ProblemServerDown})
	h.Wait()

	require.Empty(t, p.got)
}

func TestFailedSendIsRetriedThenLogged(t *testing.T) {
	var waits []time.Duration

	p := &fakeProvider{failures: 2}
	h, log := newHub(t, []notifyhub.Destination{dest("d", map[notifyhub.EventID]notifyhub.Mode{notifyhub.EventMaint: notifyhub.ModeNow})}, p)
	h.Sleep = func(_ context.Context, d time.Duration) { waits = append(waits, d) }

	h.Emit(context.Background(), notifyhub.Event{ID: notifyhub.EventMaint, Problem: notifyhub.ProblemMaintFailed})
	h.Wait()

	require.Equal(t, []time.Duration{10 * time.Second, time.Minute}, waits)
	require.Len(t, p.got, 1)
	require.Equal(t, 3, (*log)[0].Attempts)
	require.Equal(t, "sent", (*log)[0].Status)
}

func TestSendGivesUpAfterFourAttemptsAndRecordsTheError(t *testing.T) {
	p := &fakeProvider{failures: 100}
	h, log := newHub(t, []notifyhub.Destination{dest("d", map[notifyhub.EventID]notifyhub.Mode{notifyhub.EventMaint: notifyhub.ModeNow})}, p)

	h.Emit(context.Background(), notifyhub.Event{ID: notifyhub.EventMaint, Problem: notifyhub.ProblemMaintFailed})
	h.Wait()

	require.Equal(t, 4, p.calls)
	require.Equal(t, "failed", (*log)[0].Status)
	require.Contains(t, (*log)[0].Error, "Messages is not running")
}

func TestEmitWithoutOrWithBrokenFileDoesNothingAndDoesNotPanic(t *testing.T) {
	var logged []string

	h := &notifyhub.Hub{Path: filepath.Join(t.TempDir(), "none.json"), Logf: func(f string, a ...any) { logged = append(logged, f) }}
	h.Emit(context.Background(), notifyhub.Event{ID: notifyhub.EventFailed})
	h.Wait()
	require.Empty(t, logged)

	bad := filepath.Join(t.TempDir(), "bad.json")
	require.NoError(t, writeFile(bad, "{broken"))
	h = &notifyhub.Hub{Path: bad, Logf: func(f string, a ...any) { logged = append(logged, f) }}
	h.Emit(context.Background(), notifyhub.Event{ID: notifyhub.EventFailed})
	h.Wait()
	require.Len(t, logged, 1)
}

func TestSendTestReportsFailuresAndLogsAsTest(t *testing.T) {
	p := &fakeProvider{failures: 1}
	h, log := newHub(t, []notifyhub.Destination{dest("a", nil), dest("b", nil)}, p)

	err := h.SendTest(context.Background(), "")
	require.ErrorContains(t, err, "Messages is not running")
	require.Len(t, p.got, 1)
	require.Equal(t, "test", (*log)[0].Event)

	require.NoError(t, h.SendTest(context.Background(), "b"))
	require.ErrorContains(t, h.SendTest(context.Background(), "nope"), "no destination")
}

// The privacy rule: whatever a producer knows, a message carries only counts, times and the source folder.
func TestMessagesNeverCarrySensitiveText(t *testing.T) {
	secrets := []string{"passport.pdf", "Library/Mail", "backup@fulcrum.local", "192.168.0.214", "dial tcp", "no route to host", "password"}

	events := []notifyhub.Event{
		{ID: notifyhub.EventHealth, Checks: []notifyhub.HealthCheck{notifyhub.CheckReadable, notifyhub.CheckRecent, notifyhub.CheckSkips, notifyhub.CheckSample, notifyhub.CheckRestore}, Since: time.Now()},
		{ID: notifyhub.EventHealth, Recovered: true},
		{ID: notifyhub.EventFailed, Source: "/Users/me"},
		{ID: notifyhub.EventSkipped, Source: "/Users/me", Skipped: 6, Files: 662141},
		{ID: notifyhub.EventMaint, Problem: notifyhub.ProblemRepoUnreachable, Since: time.Now()},
		{ID: notifyhub.EventMaint, Problem: notifyhub.ProblemMaintFailed},
		{ID: notifyhub.EventMaint, Recovered: true},
		{ID: notifyhub.EventWatchdog, Problem: notifyhub.ProblemServerDown, Since: time.Now()},
		{ID: notifyhub.EventWatchdog, Problem: notifyhub.ProblemStaleCheck},
		{ID: notifyhub.EventWatchdog, Recovered: true},
	}

	for _, e := range events {
		title, body := notifyhub.Render(e)
		require.NotEmpty(t, title)
		require.NotEmpty(t, body)

		for _, s := range secrets {
			require.NotContains(t, strings.ToLower(title+" "+body), strings.ToLower(s), "%v", e)
		}
	}
}

func TestRenderedText(t *testing.T) {
	_, body := notifyhub.Render(notifyhub.Event{ID: notifyhub.EventSkipped, Source: "/Users/me", Skipped: 6, Files: 662141})
	require.Equal(t, "/Users/me: finished with 6 skipped files of 662,141.", body)

	_, body = notifyhub.Render(notifyhub.Event{ID: notifyhub.EventSkipped, Source: "/a", Skipped: 1, Files: 999})
	require.Contains(t, body, "of 999.")

	_, body = notifyhub.Render(notifyhub.Event{ID: notifyhub.EventHealth, Checks: []notifyhub.HealthCheck{notifyhub.CheckRecent, notifyhub.CheckSkips}})
	require.Equal(t, "Problem: snapshots are out of date; too many files were skipped.", body)
}

func TestValidate(t *testing.T) {
	require.NoError(t, notifyhub.Validate(notifyhub.Defaults("+1 555 0100")))
	require.Error(t, notifyhub.Validate([]notifyhub.Destination{{ID: "", Type: notifyhub.TypeMac}}))
	require.Error(t, notifyhub.Validate([]notifyhub.Destination{{ID: "a", Type: notifyhub.TypeMac}, {ID: "a", Type: notifyhub.TypeMac}}))
	require.Error(t, notifyhub.Validate([]notifyhub.Destination{{ID: "a", Type: "fax"}}))
	require.Error(t, notifyhub.Validate([]notifyhub.Destination{{ID: "a", Type: notifyhub.TypeIMessage}}))
	require.Error(t, notifyhub.Validate([]notifyhub.Destination{{ID: "a", Type: notifyhub.TypeMac, Events: map[notifyhub.EventID]notifyhub.Mode{"failed": "sometimes"}}}))
}

func TestDefaultsAndMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "d.json")

	require.NoError(t, notifyhub.EnsureDefaults(path, "+1 555 0100"))

	ds, err := notifyhub.Load(path)
	require.NoError(t, err)
	require.Len(t, ds, 2)
	require.Equal(t, "+1 555 0100", ds[1].Target)
	require.Equal(t, notifyhub.ModeNow, ds[1].ModeFor(notifyhub.EventSkipped))
	require.Equal(t, notifyhub.ModeOff, ds[0].ModeFor(notifyhub.EventSkipped), "the Mac popup is not told about skipped files")

	// idempotent: an existing file, even one the user emptied, is left alone
	require.NoError(t, notifyhub.Save(path, nil))
	require.NoError(t, notifyhub.EnsureDefaults(path, "+1 555 0100"))
	ds, err = notifyhub.Load(path)
	require.NoError(t, err)
	require.Empty(t, ds)
}

func TestSetIMessageTargetCreatesUpdatesAndRemoves(t *testing.T) {
	path := filepath.Join(t.TempDir(), "d.json")
	require.NoError(t, notifyhub.EnsureDefaults(path, ""))

	ds, _ := notifyhub.Load(path)
	require.Len(t, ds, 1)

	require.NoError(t, notifyhub.SetIMessageTarget(path, " +1 555 0100 "))
	ds, _ = notifyhub.Load(path)
	require.Len(t, ds, 2)
	require.Equal(t, "+1 555 0100", ds[1].Target)

	// the user's choice of events survives a change of number
	ds[1].Events[notifyhub.EventSkipped] = notifyhub.ModeOff
	require.NoError(t, notifyhub.Save(path, ds))
	require.NoError(t, notifyhub.SetIMessageTarget(path, "me@example.com"))
	ds, _ = notifyhub.Load(path)
	require.Equal(t, "me@example.com", ds[1].Target)
	require.Equal(t, notifyhub.ModeOff, ds[1].ModeFor(notifyhub.EventSkipped))

	require.NoError(t, notifyhub.SetIMessageTarget(path, ""))
	ds, _ = notifyhub.Load(path)
	require.Len(t, ds, 1)
}

func TestValidateRollup(t *testing.T) {
	ok := func(r notifyhub.Rollup) error {
		return notifyhub.Validate([]notifyhub.Destination{{ID: "a", Type: notifyhub.TypeMac, Rollup: &r}})
	}

	require.NoError(t, ok(notifyhub.Rollup{Freq: "daily", Time: "08:05"}))
	require.NoError(t, ok(notifyhub.Rollup{Freq: "monthly", DOM: 0, Time: "23:55"}))
	require.NoError(t, ok(notifyhub.Rollup{Freq: "weekly", Weekday: 6, Time: "00:00"}))
	require.Error(t, ok(notifyhub.Rollup{Freq: "hourly", Time: "08:00"}))
	require.Error(t, ok(notifyhub.Rollup{Freq: "daily", Time: "8am"}))
	require.Error(t, ok(notifyhub.Rollup{Freq: "daily", Time: "25:00"}))
	require.Error(t, ok(notifyhub.Rollup{Freq: "weekly", Weekday: 7, Time: "08:00"}))
	require.Error(t, ok(notifyhub.Rollup{Freq: "monthly", DOM: 29, Time: "08:00"}))
}
