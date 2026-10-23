package notifyhub_test

import (
	"context"
	"errors"
	"os"
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

func (f *fakeProvider) titles() []string {
	f.mu.Lock()
	defer f.mu.Unlock()

	var out []string
	for _, s := range f.got {
		out = append(out, s.dest+":"+s.title)
	}

	return out
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

func dest(id string, failures []notifyhub.EventID, success string) notifyhub.Destination {
	d := notifyhub.NewDestination(id, notifyhub.TypeMac, id, "")
	d.Failures = failures
	d.Success = notifyhub.Success{Freq: success, Time: "08:00"}

	return d
}

func TestEmitSendsFailuresOnlyToDestinationsThatSelectedThem(t *testing.T) {
	p := &fakeProvider{}
	h, log := newHub(t, []notifyhub.Destination{
		dest("all", notifyhub.FailureEvents, notifyhub.FreqOff),
		dest("only-health", []notifyhub.EventID{notifyhub.EventHealth}, notifyhub.FreqOff),
		dest("none", nil, notifyhub.FreqNow),
	}, p)

	h.Emit(context.Background(), notifyhub.Event{ID: notifyhub.EventFailed, Source: "/Users/me"})
	h.Wait()

	require.Equal(t, []sent{{"all", "Snapshot failed", "/Users/me could not be backed up."}}, p.got)
	require.Len(t, *log, 1)
	require.Equal(t, "sent", (*log)[0].Status)
	require.Equal(t, "failed", (*log)[0].Event)
}

func TestSuccessIsImmediateOnlyWhenChosen(t *testing.T) {
	p := &fakeProvider{}
	h, _ := newHub(t, []notifyhub.Destination{
		dest("now", nil, notifyhub.FreqNow),
		dest("off", notifyhub.FailureEvents, notifyhub.FreqOff),
		dest("daily", notifyhub.FailureEvents, notifyhub.FreqDaily),
	}, p)

	h.Emit(context.Background(), notifyhub.Event{ID: notifyhub.EventDone, Source: "/Users/me", Files: 662141, Elapsed: 16 * time.Second})
	h.Wait()

	require.Equal(t, []sent{{"now", "Snapshot completed", "/Users/me: 662,141 files, 0 skipped, 16s."}}, p.got)
}

func TestARepeatedFailureIsSentOnceThenRemindedAfterTheRepeatPeriod(t *testing.T) {
	now := time.Date(2026, 10, 22, 9, 0, 0, 0, time.Local)
	p := &fakeProvider{}
	h, _ := newHub(t, []notifyhub.Destination{dest("d", notifyhub.FailureEvents, notifyhub.FreqOff)}, p)
	h.Now = func() time.Time { return now }

	fail := func(src string) {
		h.Emit(context.Background(), notifyhub.Event{ID: notifyhub.EventFailed, Source: src})
		h.Wait()
	}

	fail("/Users/me")

	for range 5 {
		now = now.Add(time.Hour)
		fail("/Users/me") // the hourly snapshot fails again
	}

	require.Len(t, p.got, 1, "the same failure is not repeated every hour")

	fail("/Applications")
	require.Len(t, p.got, 2, "another source is its own failure")

	now = now.Add(7 * time.Hour) // 12 hours after the first
	fail("/Users/me")
	require.Len(t, p.got, 3, "a failure that lasts is sent again after the default 12 hours")
}

func settingsHub(t *testing.T, hours int, ds []notifyhub.Destination, p *fakeProvider) (*notifyhub.Hub, *time.Time) {
	t.Helper()

	h, _ := newHub(t, ds, p)
	require.NoError(t, notifyhub.SaveSettings(h.Path, notifyhub.Settings{RepeatHours: hours, Destinations: ds}))

	now := time.Date(2026, 10, 22, 9, 0, 0, 0, time.Local)
	h.Now = func() time.Time { return now }

	return h, &now
}

func TestTheRepeatPeriodIsTheUsersChoice(t *testing.T) {
	for _, tc := range []struct {
		hours       int
		after       time.Duration
		wantMessage int
	}{
		{1, 61 * time.Minute, 2},
		{1, 59 * time.Minute, 1},
		{24, 13 * time.Hour, 1},
		{24, 25 * time.Hour, 2},
	} {
		p := &fakeProvider{}
		h, now := settingsHub(t, tc.hours, []notifyhub.Destination{dest("d", notifyhub.FailureEvents, notifyhub.FreqOff)}, p)

		ev := notifyhub.Event{ID: notifyhub.EventMaint, Problem: notifyhub.ProblemMaintFailed}
		h.Emit(context.Background(), ev)
		h.Wait()

		*now = now.Add(tc.after)
		h.Emit(context.Background(), ev)
		h.Wait()

		require.Len(t, p.got, tc.wantMessage, "%d hours, after %v", tc.hours, tc.after)
	}
}

func TestTheRepeatRuleAppliesToEveryFailureTypeIncludingTheWatchdog(t *testing.T) {
	p := &fakeProvider{}
	h, now := settingsHub(t, 12, []notifyhub.Destination{dest("d", notifyhub.FailureEvents, notifyhub.FreqOff)}, p)
	ctx := context.Background()

	events := []notifyhub.Event{
		{ID: notifyhub.EventHealth, Checks: []notifyhub.HealthCheck{notifyhub.CheckRecent, notifyhub.CheckSkips}},
		{ID: notifyhub.EventSkipped, Source: "/a", Skipped: 3, Files: 10},
		{ID: notifyhub.EventMaint, Problem: notifyhub.ProblemRepoUnreachable},
		{ID: notifyhub.EventWatchdog, Problem: notifyhub.ProblemServerDown},
	}

	for range 3 {
		for _, e := range events {
			h.Emit(ctx, e)
		}

		h.Wait() // the clock is only moved while nothing is being delivered
		*now = now.Add(10 * time.Minute)
	}

	require.Len(t, p.got, 4, "each failure once, however often it is reported")

	*now = now.Add(12 * time.Hour)

	for _, e := range events {
		h.Emit(ctx, e)
	}

	h.Wait()
	require.Len(t, p.got, 8, "and again after the period")
}

func TestAChangedProblemIsNewsAndIsSentAtOnce(t *testing.T) {
	p := &fakeProvider{}
	h, _ := settingsHub(t, 12, []notifyhub.Destination{dest("d", notifyhub.FailureEvents, notifyhub.FreqOff)}, p)
	ctx := context.Background()

	h.Emit(ctx, notifyhub.Event{ID: notifyhub.EventHealth, Checks: []notifyhub.HealthCheck{notifyhub.CheckRecent}})
	h.Emit(ctx, notifyhub.Event{ID: notifyhub.EventHealth, Checks: []notifyhub.HealthCheck{notifyhub.CheckRecent}})
	h.Wait()
	require.Len(t, p.got, 1)

	h.Emit(ctx, notifyhub.Event{ID: notifyhub.EventHealth, Checks: []notifyhub.HealthCheck{notifyhub.CheckSkips, notifyhub.CheckRecent}})
	h.Emit(ctx, notifyhub.Event{ID: notifyhub.EventHealth, Checks: []notifyhub.HealthCheck{notifyhub.CheckRecent, notifyhub.CheckSkips}}) // same set, other order
	h.Wait()
	require.Len(t, p.got, 2, "a different set of failing checks is sent, in any order once")
}

func TestTheRuleIsPerDestination(t *testing.T) {
	p := &fakeProvider{}
	a := dest("a", notifyhub.FailureEvents, notifyhub.FreqOff)
	b := dest("b", notifyhub.FailureEvents, notifyhub.FreqOff)
	h, _ := settingsHub(t, 12, []notifyhub.Destination{a}, p)
	ctx := context.Background()
	ev := notifyhub.Event{ID: notifyhub.EventWatchdog, Problem: notifyhub.ProblemServerDown}

	h.Emit(ctx, ev)
	h.Wait()
	require.Equal(t, []string{"a:Backup server is not running"}, p.titles())

	// a destination added while the problem goes on hears of it at its next report, not after 12 hours
	require.NoError(t, notifyhub.SaveSettings(h.Path, notifyhub.Settings{RepeatHours: 12, Destinations: []notifyhub.Destination{a, b}}))
	h.Emit(ctx, ev)
	h.Wait()
	require.Equal(t, []string{"a:Backup server is not running", "b:Backup server is not running"}, p.titles())
}

func TestWhatWasSentSurvivesARestart(t *testing.T) {
	p := &fakeProvider{}
	h1, _ := settingsHub(t, 12, []notifyhub.Destination{dest("d", notifyhub.FailureEvents, notifyhub.FreqOff)}, p)
	store := &notifyhub.MemoryRepeat{}
	h1.Repeat = store

	ev := notifyhub.Event{ID: notifyhub.EventFailed, Source: "/Users/me"}
	h1.Emit(context.Background(), ev)
	h1.Wait()

	// a new process with the same store (the persistent one in the server) does not repeat the message
	h2 := &notifyhub.Hub{Path: h1.Path, Providers: h1.Providers, Repeat: store, Now: h1.Now}
	h2.Emit(context.Background(), ev)
	h2.Wait()
	require.Len(t, p.got, 1)

	// and still knows whom to tell when it ends
	h2.Emit(context.Background(), notifyhub.Event{ID: notifyhub.EventDone, Source: "/Users/me"})
	h2.Wait()
	require.Equal(t, []string{"d:Snapshot failed", "d:Snapshot works again"}, p.titles())
}

func TestACompletedSnapshotEndsTheFailureAndSaysSo(t *testing.T) {
	p := &fakeProvider{}
	h, _ := newHub(t, []notifyhub.Destination{dest("d", notifyhub.FailureEvents, notifyhub.FreqOff)}, p)
	ctx := context.Background()

	done := func(skipped int64) {
		h.Emit(ctx, notifyhub.Event{ID: notifyhub.EventDone, Source: "/Users/me", Files: 10, Skipped: skipped})
		h.Wait()
	}

	done(0)
	require.Empty(t, p.got, "a success with nothing to end is silent")

	h.Emit(ctx, notifyhub.Event{ID: notifyhub.EventFailed, Source: "/Users/me"})
	h.Wait()
	done(0)
	require.Equal(t, []string{"d:Snapshot failed", "d:Snapshot works again"}, p.titles())

	done(0)
	require.Len(t, p.got, 2, "recovery is reported once")

	// skipped files: a snapshot that still skips files does not end the problem
	h.Emit(ctx, notifyhub.Event{ID: notifyhub.EventSkipped, Source: "/Users/me", Skipped: 6, Files: 10})
	h.Wait()
	done(6)
	require.Len(t, p.got, 3)
	done(0)
	require.Equal(t, "d:No more skipped files", p.titles()[3])

	// after recovery the next failure is reported at once, not held back
	h.Emit(ctx, notifyhub.Event{ID: notifyhub.EventFailed, Source: "/Users/me"})
	h.Wait()
	require.Len(t, p.got, 5)
}

func TestRecoveryGoesOnlyWhereFailuresGo(t *testing.T) {
	p := &fakeProvider{}
	h, _ := newHub(t, []notifyhub.Destination{
		dest("all", notifyhub.FailureEvents, notifyhub.FreqOff),
		dest("health", []notifyhub.EventID{notifyhub.EventHealth}, notifyhub.FreqOff),
	}, p)
	ctx := context.Background()

	h.Emit(ctx, notifyhub.Event{ID: notifyhub.EventFailed, Source: "/a"})
	h.Emit(ctx, notifyhub.Event{ID: notifyhub.EventDone, Source: "/a"})
	h.Wait()

	require.Equal(t, []string{"all:Snapshot failed", "all:Snapshot works again"}, p.titles())
}

func TestTheEndOfAProblemIsSentOnlyToThoseWhoHeardOfIt(t *testing.T) {
	p := &fakeProvider{}
	a := dest("heard", notifyhub.FailureEvents, notifyhub.FreqOff)
	b := dest("late", notifyhub.FailureEvents, notifyhub.FreqOff)
	h, _ := settingsHub(t, 12, []notifyhub.Destination{a}, p)
	ctx := context.Background()

	h.Emit(ctx, notifyhub.Event{ID: notifyhub.EventHealth, Checks: []notifyhub.HealthCheck{notifyhub.CheckRecent}})
	h.Wait()

	require.NoError(t, notifyhub.SaveSettings(h.Path, notifyhub.Settings{RepeatHours: 12, Destinations: []notifyhub.Destination{a, b}}))
	h.Emit(ctx, notifyhub.Event{ID: notifyhub.EventHealth, Recovered: true})
	h.Wait()

	require.Equal(t, []string{"heard:Backup problem", "heard:Backup is healthy again"}, p.titles())

	h.Emit(ctx, notifyhub.Event{ID: notifyhub.EventHealth, Recovered: true})
	h.Wait()
	require.Len(t, p.got, 2, "the end is sent once")
}

func TestFailedSendIsRetriedThenLogged(t *testing.T) {
	var waits []time.Duration

	p := &fakeProvider{failures: 2}
	h, log := newHub(t, []notifyhub.Destination{dest("d", notifyhub.FailureEvents, notifyhub.FreqOff)}, p)
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
	h, log := newHub(t, []notifyhub.Destination{dest("d", notifyhub.FailureEvents, notifyhub.FreqOff)}, p)

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
	require.NoError(t, os.WriteFile(bad, []byte("{broken"), 0o600))
	h = &notifyhub.Hub{Path: bad, Logf: func(f string, a ...any) { logged = append(logged, f) }}
	h.Emit(context.Background(), notifyhub.Event{ID: notifyhub.EventFailed})
	h.Wait()
	require.Len(t, logged, 1)
}

func TestSendTestReportsFailuresAndLogsAsTest(t *testing.T) {
	p := &fakeProvider{failures: 1}
	h, log := newHub(t, []notifyhub.Destination{dest("a", nil, "off"), dest("b", nil, "off")}, p)

	err := h.SendTest(context.Background(), "")
	require.ErrorContains(t, err, "Messages is not running")
	require.Len(t, p.got, 1)
	require.Equal(t, "test", (*log)[0].Event)

	require.NoError(t, h.SendTest(context.Background(), "b"))
	require.ErrorContains(t, h.SendTest(context.Background(), "nope"), "no destination")
}

// The privacy rule: whatever a producer knows, a message carries only counts, times and the source folder.
func TestMessagesNeverCarrySensitiveText(t *testing.T) {
	secrets := []string{"passport.pdf", "library/mail", "backup@fulcrum.local", "192.168.0.214", "dial tcp", "no route to host", "password"}

	events := []notifyhub.Event{
		{ID: notifyhub.EventHealth, Checks: []notifyhub.HealthCheck{notifyhub.CheckReadable, notifyhub.CheckRecent, notifyhub.CheckSkips, notifyhub.CheckSample, notifyhub.CheckRestore}, Since: time.Now()},
		{ID: notifyhub.EventHealth, Recovered: true},
		{ID: notifyhub.EventFailed, Source: "/Users/me"},
		{ID: notifyhub.EventFailed, Source: "/Users/me", Recovered: true},
		{ID: notifyhub.EventSkipped, Source: "/Users/me", Skipped: 6, Files: 662141},
		{ID: notifyhub.EventSkipped, Source: "/Users/me", Recovered: true},
		{ID: notifyhub.EventDone, Source: "/Users/me", Files: 5, Elapsed: time.Second},
		{ID: notifyhub.EventMaint, Problem: notifyhub.ProblemRepoUnreachable, Since: time.Now()},
		{ID: notifyhub.EventMaint, Problem: notifyhub.ProblemMaintFailed},
		{ID: notifyhub.EventMaint, Recovered: true},
		{ID: notifyhub.EventMaint, Recovered: true, Problem: notifyhub.ProblemMaintFailed},
		{ID: notifyhub.EventWatchdog, Problem: notifyhub.ProblemServerDown, Since: time.Now()},
		{ID: notifyhub.EventWatchdog, Problem: notifyhub.ProblemStaleCheck},
		{ID: notifyhub.EventWatchdog, Recovered: true},
		{ID: notifyhub.EventWatchdog, Recovered: true, Problem: notifyhub.ProblemStaleCheck},
	}

	for _, e := range events {
		title, body := notifyhub.Render(e)
		require.NotEmpty(t, title)
		require.NotEmpty(t, body)

		for _, s := range secrets {
			require.NotContains(t, strings.ToLower(title+" "+body), s, "%v", e)
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

	good := func() notifyhub.Destination { return notifyhub.NewDestination("a", notifyhub.TypeMac, "a", "") }
	bad := func(mod func(*notifyhub.Destination)) error {
		d := good()
		mod(&d)

		return notifyhub.Validate([]notifyhub.Destination{d})
	}

	require.NoError(t, bad(func(*notifyhub.Destination) {}))
	require.Error(t, bad(func(d *notifyhub.Destination) { d.ID = "" }))
	require.Error(t, notifyhub.Validate([]notifyhub.Destination{good(), good()}))
	require.Error(t, bad(func(d *notifyhub.Destination) { d.Type = "fax" }))
	require.Error(t, bad(func(d *notifyhub.Destination) { d.Type = notifyhub.TypeIMessage }))
	require.Error(t, bad(func(d *notifyhub.Destination) { d.Failures = []notifyhub.EventID{"done"} }))
	require.Error(t, bad(func(d *notifyhub.Destination) { d.Success.Freq = "hourly" }))
	require.Error(t, bad(func(d *notifyhub.Destination) { d.Success = notifyhub.Success{Freq: "daily", Time: "8am"} }))
	require.Error(t, bad(func(d *notifyhub.Destination) {
		d.Success = notifyhub.Success{Freq: "weekly", Weekday: 7, Time: "08:00"}
	}))
	require.Error(t, bad(func(d *notifyhub.Destination) { d.Success = notifyhub.Success{Freq: "monthly", DOM: 29, Time: "08:00"} }))
	require.NoError(t, bad(func(d *notifyhub.Destination) { d.Success = notifyhub.Success{Freq: "monthly", DOM: 0, Time: "23:55"} }))
	require.NoError(t, bad(func(d *notifyhub.Destination) { d.Success = notifyhub.Success{Freq: "now"} }), "immediate needs no time")
}

func TestDefaultsAndFirstStart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "d.json")

	require.NoError(t, notifyhub.EnsureDefaults(path, "+1 555 0100"))

	ds, err := notifyhub.Load(path)
	require.NoError(t, err)
	require.Len(t, ds, 2)
	require.Equal(t, "+1 555 0100", ds[1].Target)
	require.Equal(t, notifyhub.FailureEvents, ds[1].Failures)
	require.Equal(t, notifyhub.FreqOff, ds[1].Success.Freq)

	// an existing file, even one the user emptied, is left alone
	require.NoError(t, notifyhub.Save(path, nil))
	require.NoError(t, notifyhub.EnsureDefaults(path, "+1 555 0100"))
	ds, err = notifyhub.Load(path)
	require.NoError(t, err)
	require.Empty(t, ds)
}

func TestFileFromTheFirstVersionIsUpgraded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "d.json")
	old := `{"destinations":[
	  {"id":"mac","type":"mac","name":"This Mac","events":{"failed":"now","health":"now","maint":"now","watchdog":"now"}},
	  {"id":"iphone","type":"imessage","name":"iPhone","target":"+1 555 0100","events":{"health":"now","skipped":"roll","failed":"now"},
	   "rollup":{"freq":"weekly","weekday":2,"time":"07:30"}}]}`
	require.NoError(t, os.WriteFile(path, []byte(old), 0o600))

	ds, err := notifyhub.Load(path)
	require.NoError(t, err)
	require.Equal(t, []notifyhub.EventID{"health", "failed", "maint", "watchdog"}, ds[0].Failures)
	require.Equal(t, notifyhub.FreqOff, ds[0].Success.Freq)
	require.Equal(t, []notifyhub.EventID{"health", "failed", "skipped"}, ds[1].Failures)
	require.Equal(t, notifyhub.Success{Freq: "weekly", Weekday: 2, Time: "07:30"}, ds[1].Success, "a roll-up becomes the success summary")
	require.NoError(t, notifyhub.Validate(ds))

	require.NoError(t, notifyhub.Upgrade(path))
	b, _ := os.ReadFile(path)
	require.NotContains(t, string(b), `"events"`)
	require.Contains(t, string(b), `"failures"`)

	again, err := notifyhub.Load(path)
	require.NoError(t, err)
	require.Equal(t, ds, again)
}

func TestEmailDestinationNeedsAnAddressAndKeepsItsAccount(t *testing.T) {
	d := notifyhub.NewDestination("e", notifyhub.TypeEmail, "Email", "")
	require.Error(t, notifyhub.Validate([]notifyhub.Destination{d}))

	d.Target = "someone-at-example"
	require.Error(t, notifyhub.Validate([]notifyhub.Destination{d}))

	d.Target = "me@example.com"
	require.NoError(t, notifyhub.Validate([]notifyhub.Destination{d}))

	d.From = "me@work.example"
	path := filepath.Join(t.TempDir(), "d.json")
	require.NoError(t, notifyhub.Save(path, []notifyhub.Destination{d}))

	got, err := notifyhub.Load(path)
	require.NoError(t, err)
	require.Equal(t, "me@work.example", got[0].From)

	// and an email destination hears what it chose, like any other
	p := &fakeProvider{}
	h, _ := newHub(t, []notifyhub.Destination{d}, p)
	h.Providers[notifyhub.TypeEmail] = p
	h.Emit(context.Background(), notifyhub.Event{ID: notifyhub.EventFailed, Source: "/Users/me"})
	h.Wait()
	require.Equal(t, []string{"e:Snapshot failed"}, p.titles())
}

func TestRepeatPeriodDefaultsPersistsAndIsValidated(t *testing.T) {
	path := filepath.Join(t.TempDir(), "d.json")

	set, err := notifyhub.LoadSettings(path)
	require.NoError(t, err)
	require.Equal(t, 12, set.RepeatHours, "no file: the default")

	require.NoError(t, notifyhub.SaveSettings(path, notifyhub.Settings{RepeatHours: 6, Destinations: notifyhub.Defaults("")}))
	set, _ = notifyhub.LoadSettings(path)
	require.Equal(t, 6, set.RepeatHours)

	// saving destinations alone keeps the period
	require.NoError(t, notifyhub.Save(path, nil))
	set, _ = notifyhub.LoadSettings(path)
	require.Equal(t, 6, set.RepeatHours)

	// a file without the setting (the earlier format) gets the default
	require.NoError(t, os.WriteFile(path, []byte(`{"destinations":[]}`), 0o600))
	set, _ = notifyhub.LoadSettings(path)
	require.Equal(t, 12, set.RepeatHours)

	require.NoError(t, notifyhub.ValidateSettings(notifyhub.Settings{RepeatHours: 1}))
	require.NoError(t, notifyhub.ValidateSettings(notifyhub.Settings{RepeatHours: 720}))
	require.Error(t, notifyhub.ValidateSettings(notifyhub.Settings{RepeatHours: 0}))
	require.Error(t, notifyhub.ValidateSettings(notifyhub.Settings{RepeatHours: 721}))
	require.Error(t, notifyhub.ValidateSettings(notifyhub.Settings{RepeatHours: 12, Destinations: []notifyhub.Destination{{ID: ""}}}))
}

func TestTheEndOfOneProblemDoesNotEndAnother(t *testing.T) {
	p := &fakeProvider{}
	h, _ := settingsHub(t, 12, []notifyhub.Destination{dest("d", notifyhub.FailureEvents, notifyhub.FreqOff)}, p)
	ctx := context.Background()

	h.Emit(ctx, notifyhub.Event{ID: notifyhub.EventMaint, Problem: notifyhub.ProblemRepoUnreachable})
	h.Emit(ctx, notifyhub.Event{ID: notifyhub.EventMaint, Problem: notifyhub.ProblemMaintFailed})
	h.Wait()

	h.Emit(ctx, notifyhub.Event{ID: notifyhub.EventMaint, Recovered: true, Problem: notifyhub.ProblemMaintFailed})
	h.Wait()
	require.Len(t, p.got, 3)
	require.Equal(t, "d:Maintenance works again", p.titles()[2])

	h.Emit(ctx, notifyhub.Event{ID: notifyhub.EventMaint, Recovered: true, Problem: notifyhub.ProblemRepoUnreachable})
	h.Wait()
	require.Equal(t, "d:Repository is reachable again", p.titles()[3])
}
