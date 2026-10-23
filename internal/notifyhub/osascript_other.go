//go:build !darwin

package notifyhub

// SystemProviders has no senders outside macOS.
func SystemProviders() map[string]Provider { return nil }
