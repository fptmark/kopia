package notifyhub

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Provider delivers one message to a destination.
type Provider interface {
	Send(ctx context.Context, d Destination, title, body string) error
}

// Entry is the outcome of delivering one notification, for the audit log.
type Entry struct {
	At          time.Time
	Destination string
	Event       string
	Mode        string // now or summary
	Status      string // sent or failed
	Attempts    int
	Error       string
}

// RollupState remembers when each destination last received its summary.
type RollupState interface {
	LastRollup(destination string) (time.Time, bool, error)
	SetLastRollup(destination string, at time.Time) error
}

// DefaultRetryDelays are the waits before the second, third and fourth attempt.
var DefaultRetryDelays = []time.Duration{10 * time.Second, time.Minute, 5 * time.Minute} //nolint:gochecknoglobals

// DefaultRepeatEvery is how long the same snapshot failure is held back after it was reported.
const DefaultRepeatEvery = 12 * time.Hour

// Hub applies each destination's settings to events and delivers the messages.
type Hub struct {
	// Path is the destinations file; it is read on every event so edits apply immediately.
	Path      string
	Providers map[string]Provider
	// Record, when set, receives the outcome of every delivery.
	Record func(Entry)
	// Logf, when set, receives problems that are not tied to one delivery.
	Logf func(format string, args ...any)

	// State and Digest drive the periodic summaries; without them none are sent.
	State  RollupState
	Digest func(ctx context.Context, from, to time.Time, freq string) (Summary, error)

	RetryDelays []time.Duration
	// RepeatEvery overrides DefaultRepeatEvery.
	RepeatEvery time.Duration
	// Sleep waits between attempts (replaced in tests).
	Sleep func(ctx context.Context, d time.Duration)
	Now   func() time.Time

	wg sync.WaitGroup

	mu sync.Mutex
	// reported holds when each snapshot failure (by kind and source) was last sent, so one that repeats
	// every hour is sent once, with a reminder, and its end is reported.
	reported map[string]time.Time
}

func (h *Hub) logf(format string, args ...any) {
	if h.Logf != nil {
		h.Logf(format, args...)
	}
}

func (h *Hub) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}

	return time.Now()
}

func (h *Hub) sleep(ctx context.Context, d time.Duration) {
	if h.Sleep != nil {
		h.Sleep(ctx, d)
		return
	}

	t := time.NewTimer(d)
	defer t.Stop()

	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

func (h *Hub) repeatEvery() time.Duration {
	if h.RepeatEvery > 0 {
		return h.RepeatEvery
	}

	return DefaultRepeatEvery
}

// hears reports whether a destination wants this event.
func hears(d Destination, e Event) bool {
	if e.ID == EventDone {
		return d.Success.Freq == FreqNow
	}

	return d.HearsFailure(e.ID)
}

// Emit sends the event to every destination that wants it. It returns at once; delivery and retries
// continue in the background, and a failed delivery never affects the caller.
//
// A snapshot failure that was already reported within RepeatEvery is not sent again. A completed snapshot
// ends the failure of its source and reports that.
func (h *Hub) Emit(ctx context.Context, e Event) {
	ds, err := Load(h.Path)
	if err != nil {
		h.logf("notifications: %v", err)
		return
	}

	ctx = context.WithoutCancel(ctx)

	for _, rec := range h.update(e) {
		h.dispatch(ctx, ds, rec)
	}

	if (e.ID == EventFailed || e.ID == EventSkipped) && !e.Recovered && !h.shouldReport(e) {
		return
	}

	h.dispatch(ctx, ds, e)
}

func reportKey(id EventID, source string) string { return string(id) + "|" + source }

// update ends the failures a completed snapshot resolves and returns the recovery events to send.
func (h *Hub) update(e Event) []Event {
	if e.ID != EventDone {
		return nil
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	var out []Event

	if _, ok := h.reported[reportKey(EventFailed, e.Source)]; ok {
		delete(h.reported, reportKey(EventFailed, e.Source))

		out = append(out, Event{ID: EventFailed, Source: e.Source, Recovered: true})
	}

	if _, ok := h.reported[reportKey(EventSkipped, e.Source)]; ok && e.Skipped == 0 {
		delete(h.reported, reportKey(EventSkipped, e.Source))

		out = append(out, Event{ID: EventSkipped, Source: e.Source, Recovered: true})
	}

	return out
}

// shouldReport records a snapshot failure and reports whether it is due to be sent.
func (h *Hub) shouldReport(e Event) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.reported == nil {
		h.reported = map[string]time.Time{}
	}

	k := reportKey(e.ID, e.Source)
	now := h.now()

	if last, ok := h.reported[k]; ok && now.Sub(last) < h.repeatEvery() {
		return false
	}

	h.reported[k] = now

	return true
}

func (h *Hub) dispatch(ctx context.Context, ds []Destination, e Event) {
	title, body := Render(e)

	for _, d := range ds {
		if !hears(d, e) {
			continue
		}

		h.wg.Add(1)

		go func() {
			defer h.wg.Done()

			h.deliver(ctx, d, string(e.ID), "now", title, body)
		}()
	}
}

// Wait blocks until every delivery started by Emit or CheckSummaries has finished.
func (h *Hub) Wait() { h.wg.Wait() }

func (h *Hub) deliver(ctx context.Context, d Destination, event, mode, title, body string) {
	delays := h.RetryDelays
	if delays == nil {
		delays = DefaultRetryDelays
	}

	var err error

	attempts := 0

	for {
		attempts++

		if err = h.sendOnce(ctx, d, title, body); err == nil || attempts > len(delays) {
			break
		}

		h.sleep(ctx, delays[attempts-1])
	}

	e := Entry{At: h.now(), Destination: d.ID, Event: event, Mode: mode, Status: "sent", Attempts: attempts}
	if err != nil {
		e.Status, e.Error = "failed", err.Error()
		h.logf("notifications: %v to %v failed after %d attempts: %v", event, d.Name, attempts, err)
	}

	if h.Record != nil {
		h.Record(e)
	}
}

func (h *Hub) sendOnce(ctx context.Context, d Destination, title, body string) error {
	p, ok := h.Providers[d.Type]
	if !ok {
		return fmt.Errorf("no sender for destination type %q", d.Type)
	}

	return p.Send(ctx, d, title, body)
}

// SendTest sends a test message to one destination (or to all when id is empty) and reports failures, with
// one attempt each. It is recorded in the log as event "test".
func (h *Hub) SendTest(ctx context.Context, id string) error {
	ds, err := Load(h.Path)
	if err != nil {
		return err
	}

	title, body := TestMessage()

	var failures []string

	sent := 0

	for _, d := range ds {
		if id != "" && d.ID != id {
			continue
		}

		sent++

		e := Entry{At: h.now(), Destination: d.ID, Event: "test", Mode: "now", Status: "sent", Attempts: 1}

		if err := h.sendOnce(ctx, d, title, body); err != nil {
			e.Status, e.Error = "failed", err.Error()
			failures = append(failures, d.Name+": "+err.Error())
		}

		if h.Record != nil {
			h.Record(e)
		}
	}

	if sent == 0 {
		return errors.New("there is no destination to send to")
	}

	if len(failures) > 0 {
		return errors.New(strings.Join(failures, "; "))
	}

	return nil
}

// RunSummaries sends periodic summaries when they fall due, until ctx ends.
func (h *Hub) RunSummaries(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()

	for {
		h.CheckSummaries(ctx)

		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// CheckSummaries sends the summary of every destination whose scheduled time has passed since it last
// received one. After sleep or downtime a missed summary is sent once, covering the whole period.
func (h *Hub) CheckSummaries(ctx context.Context) {
	if h.State == nil || h.Digest == nil {
		return
	}

	ds, err := Load(h.Path)
	if err != nil {
		h.logf("notifications: %v", err)
		return
	}

	now := h.now()
	ctx = context.WithoutCancel(ctx)

	for _, d := range ds {
		if !d.Success.Scheduled() {
			continue
		}

		last, ok, err := h.State.LastRollup(d.ID)
		if err != nil {
			h.logf("notifications: %v", err)
			continue
		}

		if !ok {
			// a new schedule starts counting now: the first summary is the next due time
			if err := h.State.SetLastRollup(d.ID, now); err != nil {
				h.logf("notifications: %v", err)
			}

			continue
		}

		if !LatestDue(d.Success, now).After(last) {
			continue
		}

		// remember it before sending so a slow or failing send cannot cause a second summary
		if err := h.State.SetLastRollup(d.ID, now); err != nil {
			h.logf("notifications: %v", err)
			continue
		}

		s, err := h.Digest(ctx, last, now, d.Success.Freq)
		if err != nil {
			h.logf("notifications: unable to build the summary for %v: %v", d.Name, err)
			continue
		}

		s.Freq = d.Success.Freq
		title, body := RenderSummary(s)

		h.wg.Add(1)

		go func() {
			defer h.wg.Done()

			h.deliver(ctx, d, "summary", "summary", title, body)
		}()
	}
}
