// Package notifyhub delivers notifications about backups to the destinations the user configured.
//
// Producers describe what happened with a typed Event. The only free text an Event can carry is the source
// folder of a snapshot; everything else is a fixed set of codes, so a message can never contain a file name,
// an error text or a host name.
package notifyhub

import "time"

// EventID names a kind of event.
type EventID string

// Failure events are what a destination's failure types select; EventDone is a completed snapshot, which
// the success setting of a destination controls.
const (
	EventHealth   EventID = "health"
	EventFailed   EventID = "failed"
	EventSkipped  EventID = "skipped"
	EventMaint    EventID = "maint"
	EventWatchdog EventID = "watchdog"
	EventDone     EventID = "done"
)

// FailureEvents lists the failure types in display order.
var FailureEvents = []EventID{EventHealth, EventFailed, EventSkipped, EventMaint, EventWatchdog} //nolint:gochecknoglobals

// HealthCheck identifies a failing health check without carrying any of its detail text.
type HealthCheck int

// Health checks.
const (
	CheckReadable HealthCheck = iota + 1
	CheckRecent
	CheckSkips
	CheckSample
	CheckRestore
)

// Problem is a fixed code for a failure of the backup system itself.
type Problem string

// Problems.
const (
	ProblemRepoUnreachable Problem = "repo-unreachable"
	ProblemMaintFailed     Problem = "maint-failed"
	ProblemServerDown      Problem = "server-down"
	ProblemStaleCheck      Problem = "stale-check"
)

// Event is something that happened. Only the fields of its kind are used.
type Event struct {
	ID EventID

	// Source is the folder a snapshot was taken of (failed, skipped, done).
	Source string
	// Files and Skipped are counts (skipped, done).
	Files, Skipped int64
	// Elapsed is how long a snapshot took (done).
	Elapsed time.Duration
	// Checks are the failing health checks (health).
	Checks []HealthCheck
	// Problem is the failure (maint, watchdog).
	Problem Problem
	// Since is when the problem started (health, maint, watchdog, and failed or skipped once the problem is over).
	Since time.Time
	// Recovered reports the end of a problem (health, maint, watchdog, and failed or skipped once the problem is over).
	Recovered bool
}
