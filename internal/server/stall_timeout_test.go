package server

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestStorageStallTimeoutDefaultsWhenPreferenceIsUnsetOrInvalid(t *testing.T) {
	for _, body := range []string{
		``,                                   // no preferences file at all
		`{}`,                                 // file exists, field never set
		`{"storageStallTimeoutSeconds": 0}`,  // explicitly zero
		`{"storageStallTimeoutSeconds": -5}`, // nonsensical stored value
	} {
		s := &Server{options: Options{UIPreferencesFile: writePrefsFile(t, body)}}

		require.Equal(t, defaultStorageStallTimeout, s.storageStallTimeout(), "for body %q", body)
	}
}

func TestStorageStallTimeoutUsesTheStoredValue(t *testing.T) {
	s := &Server{options: Options{UIPreferencesFile: writePrefsFile(t, `{"storageStallTimeoutSeconds": 90}`)}}

	require.Equal(t, 90*time.Second, s.storageStallTimeout())
}

// writePrefsFile returns the path to a preferences file containing body, or "" (no file at all, matching an
// unconfigured UIPreferencesFile) when body is empty.
func writePrefsFile(t *testing.T, body string) string {
	t.Helper()

	if body == "" {
		return filepath.Join(t.TempDir(), "does-not-exist.json")
	}

	p := filepath.Join(t.TempDir(), "ui-preferences.json")
	require.NoError(t, os.WriteFile(p, []byte(body), 0o600))

	return p
}
