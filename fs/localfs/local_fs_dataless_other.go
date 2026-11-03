//go:build !darwin

package localfs

import "os"

// Only macOS has the dataless/cloud-placeholder concept (see local_fs_dataless_darwin.go) -- other platforms
// have nothing to detect here.
func platformSpecificIsDataless(_ os.FileInfo) bool {
	return false
}
