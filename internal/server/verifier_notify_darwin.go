//go:build darwin

package server

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

const verifyNotifyTimeout = 60 * time.Second

type macNotifier struct {
	srv serverInterface
}

func newVerifyNotifier(s *Server) verifyNotifier {
	return &macNotifier{srv: s}
}

// Notify shows a macOS notification and, when the verifierIMessageTo preference is set, sends an iMessage
// to that phone number or Apple ID (it reaches the phone through the user's own Apple account).
func (n *macNotifier) Notify(ctx context.Context, title, body string) {
	runOSAScript(ctx, []string{
		"on run argv",
		"display notification (item 2 of argv) with title (item 1 of argv)",
		"end run",
	}, title, body)

	p, err := getUIPreferencesOrEmpty(n.srv)
	if err != nil {
		userLog(ctx).Errorf("unable to read preferences for the iMessage recipient: %v", err)
		return
	}

	to := strings.TrimSpace(p.VerifierIMessageTo)
	if to == "" {
		return
	}

	runOSAScript(ctx, []string{
		"on run argv",
		"tell application \"Messages\"",
		"set theService to 1st service whose service type = iMessage",
		"set theBuddy to buddy (item 1 of argv) of theService",
		"send (item 2 of argv) to theBuddy",
		"end tell",
		"end run",
	}, to, title+": "+body)
}

// runOSAScript runs the script lines with args passed as argv (never spliced into the script text).
func runOSAScript(ctx context.Context, script []string, args ...string) {
	ctx, cancel := context.WithTimeout(ctx, verifyNotifyTimeout)
	defer cancel()

	var cmdArgs []string
	for _, l := range script {
		cmdArgs = append(cmdArgs, "-e", l)
	}

	cmdArgs = append(cmdArgs, args...)

	if out, err := exec.CommandContext(ctx, "osascript", cmdArgs...).CombinedOutput(); err != nil { //nolint:gosec
		userLog(ctx).Errorf("osascript failed: %v: %s", err, strings.TrimSpace(string(out)))
	}
}
