//go:build !darwin

package localfs

import (
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPlatformSpecificIsDatalessAlwaysFalse(t *testing.T) {
	fi, err := os.Stat(t.TempDir())
	require.NoError(t, err)
	require.False(t, platformSpecificIsDataless(fi))
}
