package notifyhub

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"time"

	"github.com/pkg/errors"

	"github.com/kopia/kopia/internal/atomicfile"
)

// Destination types.
const (
	TypeIMessage = "imessage"
	TypeMac      = "mac"
)

// IMessageDestinationID is the id of the destination created from the iMessage recipient preference.
const IMessageDestinationID = "iphone"

// How often a destination hears about successful backups.
const (
	FreqOff     = "off"
	FreqNow     = "now" // one message per completed snapshot
	FreqDaily   = "daily"
	FreqWeekly  = "weekly"
	FreqMonthly = "monthly"
)

// Success says whether and when a destination hears about successful backups. Daily, weekly and monthly
// send one summary at Time (24-hour "HH:MM"), on Weekday (0 is Monday) or DOM (1-28, or 0 for the last day).
type Success struct {
	Freq    string `json:"freq"`
	Weekday int    `json:"weekday,omitempty"`
	DOM     int    `json:"dom,omitempty"`
	Time    string `json:"time,omitempty"`
}

// Scheduled reports whether the destination gets a periodic summary.
func (s Success) Scheduled() bool {
	return s.Freq == FreqDaily || s.Freq == FreqWeekly || s.Freq == FreqMonthly
}

// Destination is one place notifications go. Failures it hears about are always sent immediately.
type Destination struct {
	ID       string    `json:"id"`
	Type     string    `json:"type"`
	Name     string    `json:"name"`
	Target   string    `json:"target,omitempty"`
	Failures []EventID `json:"failures"`
	Success  Success   `json:"success"`
}

// HearsFailure reports whether the destination is told about this failure type.
func (d Destination) HearsFailure(id EventID) bool {
	for _, f := range d.Failures {
		if f == id {
			return true
		}
	}

	return false
}

// DefaultSuccessTime is the time of day a new periodic summary is sent.
const DefaultSuccessTime = "08:00"

func knownFailure(id EventID) bool {
	for _, f := range FailureEvents {
		if f == id {
			return true
		}
	}

	return false
}

// Validate rejects a list that could not be used.
func Validate(ds []Destination) error {
	seen := map[string]bool{}

	for _, d := range ds {
		if d.ID == "" || seen[d.ID] {
			return errors.Errorf("destination id %q is empty or used twice", d.ID)
		}

		seen[d.ID] = true

		if d.Type != TypeIMessage && d.Type != TypeMac {
			return errors.Errorf("destination %q has unknown type %q", d.ID, d.Type)
		}

		if d.Type == TypeIMessage && strings.TrimSpace(d.Target) == "" {
			return errors.Errorf("destination %q needs a phone number or Apple ID", d.ID)
		}

		for _, f := range d.Failures {
			if !knownFailure(f) {
				return errors.Errorf("destination %q: unknown failure type %q", d.ID, f)
			}
		}

		if err := validateSuccess(d.ID, d.Success); err != nil {
			return err
		}
	}

	return nil
}

func validateSuccess(id string, s Success) error {
	switch s.Freq {
	case FreqOff, FreqNow:
		return nil
	case FreqDaily, FreqWeekly, FreqMonthly:
	default:
		return errors.Errorf("destination %q: success setting %q is not off, now, daily, weekly or monthly", id, s.Freq)
	}

	if _, err := time.Parse("15:04", s.Time); err != nil {
		return errors.Errorf("destination %q: summary time %q is not HH:MM", id, s.Time)
	}

	if s.Weekday < 0 || s.Weekday > 6 || s.DOM < 0 || s.DOM > 28 {
		return errors.Errorf("destination %q: summary day is out of range", id)
	}

	return nil
}

type file struct {
	Destinations []Destination `json:"destinations"`
}

// legacyDestination is the first file format: a mode per event and one summary schedule.
type legacyDestination struct {
	Destination
	Events map[EventID]string `json:"events"`
	Rollup *struct {
		Freq    string `json:"freq"`
		Weekday int    `json:"weekday"`
		DOM     int    `json:"dom"`
		Time    string `json:"time"`
	} `json:"rollup"`
}

// upgrade turns a destination from the first file format into the current one: every event that was on
// (immediately or in a roll-up) becomes a failure type, and a roll-up schedule becomes the success summary.
func (l legacyDestination) upgrade() Destination {
	d := l.Destination
	d.Failures = []EventID{}
	d.Success = Success{Freq: FreqOff}

	rolled := false

	for _, id := range FailureEvents {
		switch l.Events[id] {
		case "now":
			d.Failures = append(d.Failures, id)
		case "roll":
			d.Failures = append(d.Failures, id)
			rolled = true
		}
	}

	switch {
	case l.Events["done"] == "now":
		d.Success.Freq = FreqNow
	case (rolled || l.Events["done"] == "roll") && l.Rollup != nil:
		d.Success = Success{Freq: l.Rollup.Freq, Weekday: l.Rollup.Weekday, DOM: l.Rollup.DOM, Time: l.Rollup.Time}
	}

	return d
}

func load(path string) (ds []Destination, upgraded bool, err error) {
	b, err := os.ReadFile(path) //nolint:gosec
	if os.IsNotExist(err) {
		return nil, false, nil
	}

	if err != nil {
		return nil, false, errors.Wrap(err, "unable to read notification destinations")
	}

	var raw struct {
		Destinations []legacyDestination `json:"destinations"`
	}

	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, false, errors.Wrap(err, "notification destinations file is not valid JSON")
	}

	for _, l := range raw.Destinations {
		if l.Events != nil && l.Failures == nil && l.Success.Freq == "" {
			ds = append(ds, l.upgrade())
			upgraded = true

			continue
		}

		d := l.Destination
		if d.Failures == nil {
			d.Failures = []EventID{}
		}

		if d.Success.Freq == "" {
			d.Success.Freq = FreqOff
		}

		ds = append(ds, d)
	}

	return ds, upgraded, nil
}

// Load reads the destinations file. A missing file is an empty list; a file in the first format is read
// as if it had been upgraded.
func Load(path string) ([]Destination, error) {
	ds, _, err := load(path)

	return ds, err
}

// Save writes the destinations file atomically.
func Save(path string, ds []Destination) error {
	out := make([]Destination, 0, len(ds))

	for _, d := range ds {
		if d.Failures == nil {
			d.Failures = []EventID{}
		}

		out = append(out, d)
	}

	b, err := json.MarshalIndent(file{Destinations: out}, "", "  ")
	if err != nil {
		return errors.Wrap(err, "unable to encode notification destinations")
	}

	return errors.Wrap(atomicfile.Write(path, bytes.NewReader(append(b, '\n'))), "unable to write notification destinations")
}

// Upgrade rewrites a destinations file in the first format into the current one.
func Upgrade(path string) error {
	ds, upgraded, err := load(path)
	if err != nil || !upgraded {
		return err
	}

	return Save(path, ds)
}

// NewDestination returns a destination with the settings a new one starts with: every failure type, no
// success messages.
func NewDestination(id, typ, name, target string) Destination {
	return Destination{
		ID: id, Type: typ, Name: name, Target: target,
		Failures: append([]EventID(nil), FailureEvents...),
		Success:  Success{Freq: FreqOff, Time: DefaultSuccessTime},
	}
}

// Defaults are the destinations a new setup starts with: a macOS notification, plus an iMessage when a
// recipient was already set.
func Defaults(imessageTo string) []Destination {
	ds := []Destination{NewDestination("mac", TypeMac, "This Mac", "")}

	if to := strings.TrimSpace(imessageTo); to != "" {
		ds = append(ds, NewDestination(IMessageDestinationID, TypeIMessage, "iPhone", to))
	}

	return ds
}

// EnsureDefaults creates the destinations file when there is none.
func EnsureDefaults(path, imessageTo string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	}

	return Save(path, Defaults(imessageTo))
}
