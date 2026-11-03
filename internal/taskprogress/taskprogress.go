// Package taskprogress lets code at any depth -- a blob listing, a single Get/Put, a connection retry --
// report that it is still making progress against the repository, without needing the running uitask's
// Controller threaded all the way down through every function call. uitask.Manager installs a *Reporter into
// a running task's context; everything else just calls Tick/Report on whatever context it already has, which
// is a no-op when that context was not created by a tracked task (CLI usage, tests, repo/content code paths
// that run outside the server).
package taskprogress

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/kopia/kopia/internal/clock"
)

// reportThrottle caps how often a Reporter actually forwards text to onReport: callers (a blob-listing loop,
// for example) can call Report once per item without that turning into one UI/task-store write per item.
const reportThrottle = time.Second

// Reporter is the live state for one running task: when it last saw any operation complete (for stall
// detection) and, throttled, what it is currently doing (for the UI).
type Reporter struct {
	lastTick   atomic.Int64 // unix nanos; moves on every single operation
	lastReport atomic.Int64 // unix nanos; gates onReport's actual call rate
	onReport   func(string)
}

// New creates a Reporter whose throttled text ultimately goes to onReport (normally a
// uitask.Controller.ReportProgressInfo).
func New(onReport func(string)) *Reporter {
	r := &Reporter{onReport: onReport}
	r.lastTick.Store(clock.Now().UnixNano())

	return r
}

// Tick records that an operation just completed (successfully or not -- either way the storage is
// responding), resetting the stall clock.
func (r *Reporter) Tick() {
	r.lastTick.Store(clock.Now().UnixNano())
}

// StalledFor reports how long it has been since the last Tick, as of now.
func (r *Reporter) StalledFor(now time.Time) time.Duration {
	return now.Sub(time.Unix(0, r.lastTick.Load()))
}

// Report passes text to onReport, but at most once per reportThrottle: callers may call this as often as
// they like (once per item in a loop, for example).
func (r *Reporter) Report(text string) {
	now := clock.Now()

	last := r.lastReport.Load()
	if last != 0 && now.Sub(time.Unix(0, last)) < reportThrottle {
		return
	}

	if !r.lastReport.CompareAndSwap(last, now.UnixNano()) {
		return // another call just won the race and is reporting instead
	}

	r.onReport(text)
}

type ctxKey struct{}

// WithReporter attaches r to ctx, for Tick/Report (and FromContext) to find.
func WithReporter(ctx context.Context, r *Reporter) context.Context {
	return context.WithValue(ctx, ctxKey{}, r)
}

// FromContext returns the Reporter attached to ctx, or nil outside a tracked task.
func FromContext(ctx context.Context) *Reporter {
	r, _ := ctx.Value(ctxKey{}).(*Reporter)
	return r
}

// Tick records an operation against ctx's Reporter, if any; a no-op otherwise.
func Tick(ctx context.Context) {
	if r := FromContext(ctx); r != nil {
		r.Tick()
	}
}

// Report records throttled progress text against ctx's Reporter, if any; a no-op otherwise.
func Report(ctx context.Context, text string) {
	if r := FromContext(ctx); r != nil {
		r.Report(text)
	}
}
