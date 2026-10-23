//go:build !darwin

package notifyhub

import "context"

// SystemProviders has no senders outside macOS.
func SystemProviders() map[string]Provider { return nil }

// MailAccounts has no Mail app outside macOS.
func MailAccounts(context.Context) ([]MailAccount, error) { return []MailAccount{}, nil }
