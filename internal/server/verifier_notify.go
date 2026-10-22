package server

import "context"

// verifyNotifier tells the user about a backup problem outside the web UI.
type verifyNotifier interface {
	Notify(ctx context.Context, title, body string)
}
