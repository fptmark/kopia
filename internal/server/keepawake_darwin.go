//go:build darwin

package server

import (
	"context"
	"os"
	"os/exec"
	"strconv"
)

// preventSleep runs caffeinate for as long as the returned function has not been called.
// mode "idle" blocks idle sleep on any power source, "ac" additionally blocks system sleep
// but only while on AC power. caffeinate also exits on its own if this process dies.
func preventSleep(ctx context.Context, mode string) func() {
	var flags string

	switch mode {
	case "idle":
		flags = "-i"
	case "ac":
		flags = "-is"
	default:
		return func() {}
	}

	cmd := exec.Command("caffeinate", flags, "-w", strconv.Itoa(os.Getpid())) //nolint:gosec,noctx
	if err := cmd.Start(); err != nil {
		userLog(ctx).Errorf("unable to run caffeinate: %v", err)
		return func() {}
	}

	userLog(ctx).Debugf("keeping system awake during snapshot (caffeinate %v)", flags)

	return func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}
}
