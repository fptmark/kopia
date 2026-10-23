package notifyhub

import "strings"

// MailAccount is an account set up in the Mail app.
type MailAccount struct {
	Name      string   `json:"name"`
	Addresses []string `json:"addresses"`
}

// mailSendScript composes and sends one message; the subject, text, recipient and sender (empty for Mail's
// default account) arrive as argv, never spliced into the script.
var mailSendScript = []string{ //nolint:gochecknoglobals
	"on run argv",
	"tell application \"Mail\"",
	"set m to make new outgoing message with properties {subject:(item 1 of argv), content:(item 2 of argv), visible:false}",
	"tell m",
	"make new to recipient at end of to recipients with properties {address:(item 3 of argv)}",
	"if (item 4 of argv) is not \"\" then set sender to (item 4 of argv)",
	"end tell",
	"send m",
	"end tell",
	"end run",
}

// mailAccountsScript prints one line per enabled account: its name, a tab, and its addresses separated by commas.
var mailAccountsScript = []string{ //nolint:gochecknoglobals
	"on run",
	"tell application \"Mail\"",
	"set res to \"\"",
	"repeat with a in every account",
	"if enabled of a then",
	"set AppleScript's text item delimiters to \",\"",
	"set addrs to (email addresses of a) as text",
	"set AppleScript's text item delimiters to \"\"",
	"set res to res & (name of a) & tab & addrs & linefeed",
	"end if",
	"end repeat",
	"return res",
	"end tell",
	"end run",
}

func parseMailAccounts(out string) []MailAccount {
	accounts := []MailAccount{}

	for _, line := range strings.Split(out, "\n") {
		name, addrs, ok := strings.Cut(strings.TrimRight(line, "\r"), "\t")
		if !ok || strings.TrimSpace(name) == "" {
			continue
		}

		a := MailAccount{Name: strings.TrimSpace(name), Addresses: []string{}}

		for _, addr := range strings.Split(addrs, ",") {
			if addr = strings.TrimSpace(addr); addr != "" {
				a.Addresses = append(a.Addresses, addr)
			}
		}

		accounts = append(accounts, a)
	}

	return accounts
}
