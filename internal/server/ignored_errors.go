package server

import (
	"context"
	"path/filepath"

	"github.com/kopia/kopia/internal/clock"
	"github.com/kopia/kopia/internal/ignoreerr"
)

func ignoredErrorsFile(prefsFile string) string {
	if prefsFile == "" {
		return ""
	}

	return filepath.Join(filepath.Dir(prefsFile), "ignored-errors.json")
}

// setupIgnoredErrors opens the rules for errors that are not reported. A rules file that cannot be read
// leaves every error reported, which is the safe way to fail.
func (s *Server) setupIgnoredErrors(ctx context.Context) {
	file := ignoredErrorsFile(s.options.UIPreferencesFile)
	if file == "" {
		return
	}

	store, err := ignoreerr.Open(file, clock.Now)
	if err != nil {
		userLog(ctx).Errorf("unable to read the ignored errors, all errors will be reported: %v", err)

		return
	}

	s.ignored = store
}

// ignoredErrors returns the rules (nil when there are none to read).
func (s *Server) ignoredErrors() *ignoreerr.Store {
	return s.ignored
}
