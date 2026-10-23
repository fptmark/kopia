package notifyhub

import (
	"fmt"
	"strings"
	"time"

	"github.com/kopia/kopia/internal/units"
)

// SourceSummary is what happened to one source's snapshots in a period.
type SourceSummary struct {
	Source    string // folder
	Snapshots int
	Files     int64
}

// Summary is the data of a periodic summary. Like Event it holds counts, sources and times only.
type Summary struct {
	Freq        string
	Sources     []SourceSummary
	Failed      int
	WithSkipped int
	MostSkipped int64
	MaintRuns   int
	MaintFailed int
	RepoBytes   int64
	RepoGrowth  int64
	HaveRepo    bool
	HaveGrowth  bool
	// Health is the result of the last full health check: "passed", "failing" or "not run".
	Health string
}

// RenderSummary returns the title and text of a periodic summary.
func RenderSummary(s Summary) (title, body string) {
	period := map[string]string{FreqDaily: "last 24 hours", FreqWeekly: "last 7 days", FreqMonthly: "last month"}[s.Freq]
	if period == "" {
		period = "recent"
	}

	var l []string

	if len(s.Sources) == 0 {
		l = append(l, "No snapshots completed.")
	} else {
		l = append(l, "Snapshots completed:")

		for _, src := range s.Sources {
			l = append(l, fmt.Sprintf("  %v: %d snapshots, %v files", src.Source, src.Snapshots, number(src.Files)))
		}
	}

	l = append(l, fmt.Sprintf("Failed snapshots: %d", s.Failed))

	if s.WithSkipped > 0 {
		l = append(l, fmt.Sprintf("Snapshots with skipped files: %d (most: %v files)", s.WithSkipped, number(s.MostSkipped)))
	} else {
		l = append(l, "Snapshots with skipped files: 0")
	}

	l = append(l, fmt.Sprintf("Maintenance: %d runs, %d problems", s.MaintRuns, s.MaintFailed))

	if s.HaveRepo {
		repo := "Repository: " + units.BytesString(s.RepoBytes)
		if s.HaveGrowth {
			sign := "+"
			if s.RepoGrowth < 0 {
				sign = "-"
			}

			g := s.RepoGrowth
			if g < 0 {
				g = -g
			}

			repo += fmt.Sprintf(" (%v%v)", sign, units.BytesString(g))
		}

		l = append(l, repo)
	}

	health := s.Health
	if health == "" {
		health = "not run"
	}

	l = append(l, "Last full check: "+health)

	return "Backup summary, " + period, strings.Join(l, "\n")
}

// Period returns how far back a summary of this frequency reaches.
func Period(freq string) time.Duration {
	switch freq {
	case FreqWeekly:
		return 7 * 24 * time.Hour
	case FreqMonthly:
		return 30 * 24 * time.Hour
	}

	return 24 * time.Hour
}
