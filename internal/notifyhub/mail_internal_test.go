package notifyhub

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseMailAccounts(t *testing.T) {
	got := parseMailAccounts("Gmail\tmark@gmail.com,mark.alt@gmail.com\niCloud\tmark@icloud.com\n\nBroken line without a tab\n\t\n")

	require.Equal(t, []MailAccount{
		{Name: "Gmail", Addresses: []string{"mark@gmail.com", "mark.alt@gmail.com"}},
		{Name: "iCloud", Addresses: []string{"mark@icloud.com"}},
	}, got)

	require.Equal(t, []MailAccount{}, parseMailAccounts(""), "no accounts is an empty list, not null")
	require.Equal(t, []MailAccount{{Name: "Work", Addresses: []string{}}}, parseMailAccounts("Work\t\r\n"))
}

// The text of a message must never become part of the script: it travels as argv.
func TestMailScriptTakesTextAsArguments(t *testing.T) {
	script := strings.Join(mailSendScript, "\n")

	for _, i := range []string{"item 1 of argv", "item 2 of argv", "item 3 of argv", "item 4 of argv"} {
		require.Contains(t, script, i)
	}

	require.NotContains(t, script, "Backup", "no message text is written into the script")
}
