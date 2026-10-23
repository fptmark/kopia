//go:build darwin

package notifyhub

import (
	"context"
	"os/exec"
	"strings"
	"time"

	"github.com/pkg/errors"
)

const osascriptTimeout = 60 * time.Second

// SystemProviders sends macOS notifications and iMessages through osascript.
func SystemProviders() map[string]Provider {
	return map[string]Provider{TypeMac: macProvider{}, TypeIMessage: iMessageProvider{}}
}

type macProvider struct{}

func (macProvider) Send(ctx context.Context, _ Destination, title, body string) error {
	return runOSAScript(ctx, []string{
		"on run argv",
		"display notification (item 2 of argv) with title (item 1 of argv)",
		"end run",
	}, title, body)
}

type iMessageProvider struct{}

func (iMessageProvider) Send(ctx context.Context, d Destination, title, body string) error {
	return runOSAScript(ctx, []string{
		"on run argv",
		"tell application \"Messages\"",
		"set theService to 1st service whose service type = iMessage",
		"set theBuddy to buddy (item 1 of argv) of theService",
		"send (item 2 of argv) to theBuddy",
		"end tell",
		"end run",
	}, strings.TrimSpace(d.Target), title+": "+body)
}

// runOSAScript runs the script lines with args passed as argv (never spliced into the script text).
func runOSAScript(ctx context.Context, script []string, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, osascriptTimeout)
	defer cancel()

	var cmdArgs []string
	for _, l := range script {
		cmdArgs = append(cmdArgs, "-e", l)
	}

	cmdArgs = append(cmdArgs, args...)

	if out, err := exec.CommandContext(ctx, "osascript", cmdArgs...).CombinedOutput(); err != nil { //nolint:gosec
		return errors.Errorf("osascript failed: %v: %s", err, strings.TrimSpace(string(out)))
	}

	return nil
}
