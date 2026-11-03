//go:build darwin

package localfs

import (
	"os"
	"syscall"
)

// statFlagDataless is SF_DATALESS from <sys/stat.h>: macOS sets this bit in st_flags for a "dataless" file or
// directory -- one backed by a cloud/File Provider extension (iCloud Drive and similar services) whose
// content has not been materialized on local disk. Reading one triggers an on-demand download instead of
// returning real local content, which can turn a routine directory walk into a long wait on a slow or
// unreachable network. Go has no constant for this bit, so it's spelled out here; the value is stable ABI
// (part of the BSD stat(2) flags namespace Apple documents alongside the dataless-files feature).
const statFlagDataless = 0x40000000

// platformSpecificIsDataless reports whether fi is a dataless (not-on-disk) entry.
func platformSpecificIsDataless(fi os.FileInfo) bool {
	stat, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}

	return stat.Flags&statFlagDataless != 0
}
