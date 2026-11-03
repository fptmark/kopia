//go:build darwin

package localfs

import (
	"os"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type fakeFileInfo struct {
	sys any
}

func (f fakeFileInfo) Name() string       { return "x" }
func (f fakeFileInfo) Size() int64        { return 0 }
func (f fakeFileInfo) Mode() os.FileMode  { return 0 }
func (f fakeFileInfo) ModTime() time.Time { return time.Time{} }
func (f fakeFileInfo) IsDir() bool        { return false }
func (f fakeFileInfo) Sys() any           { return f.sys }

func TestPlatformSpecificIsDataless(t *testing.T) {
	require.True(t, platformSpecificIsDataless(fakeFileInfo{sys: &syscall.Stat_t{Flags: statFlagDataless}}))
	require.True(t, platformSpecificIsDataless(fakeFileInfo{sys: &syscall.Stat_t{Flags: statFlagDataless | 0x20}}),
		"the dataless bit alongside other flags must still be detected")
	require.False(t, platformSpecificIsDataless(fakeFileInfo{sys: &syscall.Stat_t{Flags: 0}}))
	require.False(t, platformSpecificIsDataless(fakeFileInfo{sys: &syscall.Stat_t{Flags: 0x20}}),
		"an unrelated flag (UF_NODUMP) must not be mistaken for dataless")
	require.False(t, platformSpecificIsDataless(fakeFileInfo{sys: nil}), "no Stat_t available: not dataless")
}

// TestPlatformSpecificIsDatalessOnARealFile guards against a typo in the bit value: an ordinary file on disk
// must never be reported dataless.
func TestPlatformSpecificIsDatalessOnARealFile(t *testing.T) {
	fi, err := os.Stat(t.TempDir())
	require.NoError(t, err)
	require.False(t, platformSpecificIsDataless(fi))
}
