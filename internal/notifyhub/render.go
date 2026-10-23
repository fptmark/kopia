package notifyhub

import (
	"fmt"
	"strings"
	"time"
)

var checkLabels = map[HealthCheck]string{ //nolint:gochecknoglobals
	CheckReadable: "snapshots cannot be read",
	CheckRecent:   "snapshots are out of date",
	CheckSkips:    "too many files were skipped",
	CheckSample:   "stored data failed verification",
	CheckRestore:  "a test restore did not match",
}

// Render returns the title and text of an event. It is the single place messages are written.
func Render(e Event) (title, body string) {
	switch e.ID {
	case EventHealth:
		return renderHealth(e)
	case EventFailed:
		return "Snapshot failed", fmt.Sprintf("%v could not be backed up.", e.Source)
	case EventSkipped:
		return "Files skipped", fmt.Sprintf("%v: finished with %v skipped files of %v.", e.Source, number(e.Skipped), number(e.Files))
	case EventMaint:
		return renderMaint(e)
	case EventWatchdog:
		return renderWatchdog(e)
	}

	return "Backup notice", "Something happened that needs a look."
}

// TestMessage is what the "send a test message" button sends.
func TestMessage() (title, body string) {
	return "Backup test message", "This is a test of the backup alerts."
}

func renderHealth(e Event) (title, body string) {
	if e.Recovered {
		return "Backup is healthy again", "All backup health checks pass."
	}

	var parts []string

	for _, c := range e.Checks {
		if l, ok := checkLabels[c]; ok {
			parts = append(parts, l)
		}
	}

	text := "a check failed"
	if len(parts) > 0 {
		text = strings.Join(parts, "; ")
	}

	return "Backup problem", fmt.Sprintf("Problem%v: %v.", since(e.Since), text)
}

func renderMaint(e Event) (title, body string) {
	if e.Recovered {
		return "Repository is reachable again", "Backups can reach the repository."
	}

	if e.Problem == ProblemMaintFailed {
		return "Repository maintenance failed", "Maintenance did not complete."
	}

	return "Repository problem", fmt.Sprintf("Backups cannot reach the repository%v.", since(e.Since))
}

func renderWatchdog(e Event) (title, body string) {
	if e.Recovered {
		return "Backup server is running again", "The backup server answers and checks are current."
	}

	if e.Problem == ProblemStaleCheck {
		return "Backup checks are overdue", "No full backup check for over 26 hours."
	}

	return "Backup server is not running", fmt.Sprintf("Not running%v.", since(e.Since))
}

func since(t time.Time) string {
	if t.IsZero() {
		return ""
	}

	return " since " + t.Local().Format("3:04 PM")
}

// number formats a count with thousands separators.
func number(n int64) string {
	s := fmt.Sprint(n)

	for i := len(s) - 3; i > 0 && s[i-1] != '-'; i -= 3 {
		s = s[:i] + "," + s[i:]
	}

	return s
}
