package notifyhub

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"

	"github.com/pkg/errors"

	"github.com/kopia/kopia/internal/atomicfile"
)

// Destination types.
const (
	TypeIMessage = "imessage"
	TypeMac      = "mac"
)

// IMessageDestinationID is the id of the destination that follows the iMessage recipient preference.
const IMessageDestinationID = "iphone"

// Rollup is the schedule of a destination's periodic summary (used by the roll-up scheduler).
type Rollup struct {
	Freq    string `json:"freq"` // daily, weekly or monthly
	Weekday int    `json:"weekday,omitempty"`
	DOM     int    `json:"dom,omitempty"`
	Time    string `json:"time"` // 24-hour HH:MM
}

// Destination is one place notifications go, with the events it hears about.
type Destination struct {
	ID     string           `json:"id"`
	Type   string           `json:"type"`
	Name   string           `json:"name"`
	Target string           `json:"target,omitempty"`
	Events map[EventID]Mode `json:"events"`
	Rollup *Rollup          `json:"rollup,omitempty"`
}

// ModeFor returns how the destination hears about an event. Health and watchdog alerts are never batched.
func (d Destination) ModeFor(id EventID) Mode {
	m := d.Events[id]

	switch m {
	case ModeNow:
		return ModeNow
	case ModeRoll:
		if id == EventHealth || id == EventWatchdog {
			return ModeOff
		}

		return ModeRoll
	case ModeOff:
		return ModeOff
	}

	return ModeOff
}

type file struct {
	Destinations []Destination `json:"destinations"`
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

		for id, m := range d.Events {
			if m != ModeOff && m != ModeNow && m != ModeRoll {
				return errors.Errorf("destination %q: event %q has unknown mode %q", d.ID, id, m)
			}
		}
	}

	return nil
}

// Load reads the destinations file. A missing file is an empty list.
func Load(path string) ([]Destination, error) {
	b, err := os.ReadFile(path) //nolint:gosec
	if os.IsNotExist(err) {
		return nil, nil
	}

	if err != nil {
		return nil, errors.Wrap(err, "unable to read notification destinations")
	}

	var f file
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, errors.Wrap(err, "notification destinations file is not valid JSON")
	}

	return f.Destinations, nil
}

// Save writes the destinations file atomically.
func Save(path string, ds []Destination) error {
	if ds == nil {
		ds = []Destination{}
	}

	b, err := json.MarshalIndent(file{Destinations: ds}, "", "  ")
	if err != nil {
		return errors.Wrap(err, "unable to encode notification destinations")
	}

	return errors.Wrap(atomicfile.Write(path, bytes.NewReader(append(b, '\n'))), "unable to write notification destinations")
}

// Defaults are the destinations a new setup starts with: what the health check did before destinations
// existed (a macOS notification, plus an iMessage when a recipient was set).
func Defaults(imessageTo string) []Destination {
	all := map[EventID]Mode{EventHealth: ModeNow, EventFailed: ModeNow, EventSkipped: ModeNow, EventMaint: ModeNow, EventWatchdog: ModeNow}
	mac := map[EventID]Mode{EventHealth: ModeNow, EventFailed: ModeNow, EventMaint: ModeNow, EventWatchdog: ModeNow}

	ds := []Destination{{ID: "mac", Type: TypeMac, Name: "This Mac", Events: mac}}

	if to := strings.TrimSpace(imessageTo); to != "" {
		ds = append(ds, Destination{ID: IMessageDestinationID, Type: TypeIMessage, Name: "iPhone", Target: to, Events: all})
	}

	return ds
}

// EnsureDefaults creates the destinations file when there is none, so existing behavior carries over.
func EnsureDefaults(path, imessageTo string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	}

	return Save(path, Defaults(imessageTo))
}

// SetIMessageTarget keeps the iPhone destination in step with the recipient preference: it is created or
// updated when a recipient is set and removed when it is cleared.
func SetIMessageTarget(path, to string) error {
	to = strings.TrimSpace(to)

	ds, err := Load(path)
	if err != nil {
		return err
	}

	var out []Destination

	found := false

	for _, d := range ds {
		if d.ID != IMessageDestinationID {
			out = append(out, d)
			continue
		}

		found = true

		if to != "" {
			d.Target = to
			out = append(out, d)
		}
	}

	if !found && to != "" {
		for _, d := range Defaults(to) {
			if d.ID == IMessageDestinationID {
				out = append(out, d)
			}
		}
	}

	return Save(path, out)
}
