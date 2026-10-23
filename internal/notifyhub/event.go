// Package notifyhub delivers notifications about backups to the destinations the user configured.
//
// Producers describe what happened with a typed Event. The only free text an Event can carry is the source
// folder of a snapshot; everything else is a fixed set of codes, so a message can never contain a file name,
// an error text or a host name.
package notifyhub

import "time"

// EventID names a kind of event; destinations choose how they hear about each one.
type EventID string

// Events a destination can subscribe to.
const (
	EventHealth   EventID = "health"
	EventFailed   EventID = "failed"
	EventSkipped  EventID = "skipped"
	EventMaint    EventID = "maint"
	EventWatchdog EventID = "watchdog"
)

// AllEvents lists the events in display order.
var AllEvents = []EventID{EventHealth, EventFailed, EventSkipped, EventMaint, EventWatchdog} //nolint:gochecknoglobals

// Mode is how a destination hears about an event.
type Mode string

// Delivery modes.
const (
	ModeOff  Mode = "off"
	ModeNow  Mode = "now"
	ModeRoll Mode = "roll"
)

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

	// Source is the folder a snapshot was taken of (failed, skipped).
	Source string
	// Files and Skipped are counts (skipped).
	Files, Skipped int64
	// Checks are the failing health checks (health).
	Checks []HealthCheck
	// Problem is the failure (maint, watchdog).
	Problem Problem
	// Since is when the problem started (health, maint, watchdog).
	Since time.Time
	// Recovered reports the end of a problem (health, maint, watchdog).
	Recovered bool
}
