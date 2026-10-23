package notifyhub

import (
	"context"
	"errors"
	"fmt"
	"sort"
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

// RepeatStore remembers which failures each destination was told about, and when, so a failure that goes on
// is sent once per repeat period and its end is sent only to the destinations that heard of it.
type RepeatStore interface {
	LastSent(destination, kind, detail string) (time.Time, bool, error)
	SetSent(destination, kind, detail string, at time.Time) error
	// TakeSent forgets the failure (all details of the kind when detail is empty) and reports whether it was known.
	TakeSent(destination, kind, detail string) (bool, error)
}

type repeatKey struct{ destination, kind, detail string }

// MemoryRepeat is a RepeatStore that forgets everything when the process ends.
type MemoryRepeat struct {
	mu sync.Mutex
	m  map[repeatKey]time.Time
}

// LastSent implements RepeatStore.
func (r *MemoryRepeat) LastSent(destination, kind, detail string) (time.Time, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	t, ok := r.m[repeatKey{destination, kind, detail}]

	return t, ok, nil
}

// SetSent implements RepeatStore.
func (r *MemoryRepeat) SetSent(destination, kind, detail string, at time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.m == nil {
		r.m = map[repeatKey]time.Time{}
	}

	r.m[repeatKey{destination, kind, detail}] = at

	return nil
}

// TakeSent implements RepeatStore.
func (r *MemoryRepeat) TakeSent(destination, kind, detail string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	had := false

	for k := range r.m {
		if k.destination == destination && k.kind == kind && (detail == "" || k.detail == detail) {
			delete(r.m, k)

			had = true
		}
	}

	return had, nil
}

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
	// Repeat remembers what was sent; without it a repeated failure is only held back until the process ends.
	Repeat RepeatStore

	RetryDelays []time.Duration
	// Sleep waits between attempts (replaced in tests).
	Sleep func(ctx context.Context, d time.Duration)
	Now   func() time.Time

	wg sync.WaitGroup

	fallbackRepeat MemoryRepeat
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

func (h *Hub) repeat() RepeatStore {
	if h.Repeat != nil {
		return h.Repeat
	}

	return &h.fallbackRepeat
}

// hears reports whether a destination wants this event.
func hears(d Destination, e Event) bool {
	if e.ID == EventDone {
		return d.Success.Freq == FreqNow
	}

	return d.HearsFailure(e.ID)
}

// failureDetail is what makes a failure the same one again: the source of a snapshot, the failing checks, or
// the problem code. A different detail is news and is sent at once.
func failureDetail(e Event) string {
	switch e.ID {
	case EventFailed, EventSkipped:
		return e.Source
	case EventHealth:
		checks := make([]string, 0, len(e.Checks))
		for _, c := range e.Checks {
			checks = append(checks, fmt.Sprint(int(c)))
		}

		sort.Strings(checks)

		return strings.Join(checks, ",")
	}

	return string(e.Problem)
}

// Emit sends the event to every destination that wants it. It returns at once; delivery and retries
// continue in the background, and a failed delivery never affects the caller.
//
// A failure is sent to a destination once per repeat period, however often it is reported; the end of a
// failure is sent to the destinations that were told about it. A completed snapshot ends the failure of its
// source.
func (h *Hub) Emit(ctx context.Context, e Event) {
	set, err := LoadSettings(h.Path)
	if err != nil {
		h.logf("notifications: %v", err)
		return
	}

	ctx = context.WithoutCancel(ctx)
	ds := set.Destinations

	switch {
	case e.ID == EventDone:
		h.dispatch(ctx, ds, e)
		h.end(ctx, ds, Event{ID: EventFailed, Source: e.Source, Recovered: true})

		if e.Skipped == 0 {
			h.end(ctx, ds, Event{ID: EventSkipped, Source: e.Source, Recovered: true})
		}
	case e.Recovered:
		h.end(ctx, ds, e)
	default:
		h.dispatchFailure(ctx, ds, e, time.Duration(set.RepeatHours)*time.Hour)
	}
}

func (h *Hub) dispatchFailure(ctx context.Context, ds []Destination, e Event, period time.Duration) {
	kind, detail := string(e.ID), failureDetail(e)
	now := h.now()

	var to []Destination

	for _, d := range ds {
		if !hears(d, e) {
			continue
		}

		if last, ok, err := h.repeat().LastSent(d.ID, kind, detail); err != nil {
			h.logf("notifications: %v", err)
		} else if ok && now.Sub(last) < period {
			continue
		}

		if err := h.repeat().SetSent(d.ID, kind, detail, now); err != nil {
			h.logf("notifications: %v", err)
		}

		to = append(to, d)
	}

	h.dispatch(ctx, to, e)
}

// end sends the end of a failure to the destinations that were told about it, and forgets it.
func (h *Hub) end(ctx context.Context, ds []Destination, e Event) {
	detail := ""

	switch e.ID {
	case EventFailed, EventSkipped:
		detail = e.Source
	case EventMaint, EventWatchdog:
		detail = string(e.Problem) // the end of one problem does not end another
	}

	var to []Destination

	for _, d := range ds {
		if !hears(d, e) {
			continue
		}

		had, err := h.repeat().TakeSent(d.ID, string(e.ID), detail)
		if err != nil {
			h.logf("notifications: %v", err)
		}

		if had {
			to = append(to, d)
		}
	}

	h.dispatch(ctx, to, e)
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
