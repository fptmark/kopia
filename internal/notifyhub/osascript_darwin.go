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
	return map[string]Provider{TypeMac: macProvider{}, TypeIMessage: iMessageProvider{}, TypeEmail: emailProvider{}}
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

type emailProvider struct{}

func (emailProvider) Send(ctx context.Context, d Destination, title, body string) error {
	return runOSAScript(ctx, mailSendScript, title, body, strings.TrimSpace(d.Target), strings.TrimSpace(d.From))
}

// MailAccounts lists the enabled accounts in the Mail app (which starts it if it is not running).
func MailAccounts(ctx context.Context) ([]MailAccount, error) {
	out, err := runOSAScriptOutput(ctx, mailAccountsScript)
	if err != nil {
		return nil, err
	}

	return parseMailAccounts(out), nil
}

// runOSAScript runs the script lines with args passed as argv (never spliced into the script text).
func runOSAScript(ctx context.Context, script []string, args ...string) error {
	_, err := runOSAScriptOutput(ctx, script, args...)

	return err
}

func runOSAScriptOutput(ctx context.Context, script []string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, osascriptTimeout)
	defer cancel()

	var cmdArgs []string
	for _, l := range script {
		cmdArgs = append(cmdArgs, "-e", l)
	}

	cmdArgs = append(cmdArgs, args...)

	out, err := exec.CommandContext(ctx, "osascript", cmdArgs...).CombinedOutput() //nolint:gosec
	if err != nil {
		return "", errors.Errorf("osascript failed: %v: %s", err, strings.TrimSpace(string(out)))
	}

	return string(out), nil
}
