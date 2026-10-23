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
	Mode        string
	Status      string // sent or failed
	Attempts    int
	Error       string
}

// DefaultRetryDelays are the waits before the second, third and fourth attempt.
var DefaultRetryDelays = []time.Duration{10 * time.Second, time.Minute, 5 * time.Minute} //nolint:gochecknoglobals

// Hub applies each destination's settings to events and delivers the messages.
type Hub struct {
	// Path is the destinations file; it is read on every event so edits apply immediately.
	Path      string
	Providers map[string]Provider
	// Record, when set, receives the outcome of every delivery.
	Record func(Entry)
	// Logf, when set, receives problems that are not tied to one delivery.
	Logf func(format string, args ...any)

	RetryDelays []time.Duration
	// Sleep waits between attempts (replaced in tests).
	Sleep func(ctx context.Context, d time.Duration)
	Now   func() time.Time

	wg sync.WaitGroup
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

// Emit sends the event to every destination that wants it immediately. It returns at once; delivery and
// retries continue in the background, and a failed delivery never affects the caller.
func (h *Hub) Emit(ctx context.Context, e Event) {
	ds, err := Load(h.Path)
	if err != nil {
		h.logf("notifications: %v", err)
		return
	}

	title, body := Render(e)
	ctx = context.WithoutCancel(ctx)

	for _, d := range ds {
		if d.ModeFor(e.ID) != ModeNow {
			continue
		}

		h.wg.Add(1)

		go func() {
			defer h.wg.Done()

			h.deliver(ctx, d, string(e.ID), string(ModeNow), title, body)
		}()
	}
}

// Wait blocks until every delivery started by Emit has finished.
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

		e := Entry{At: h.now(), Destination: d.ID, Event: "test", Mode: string(ModeNow), Status: "sent", Attempts: 1}

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
