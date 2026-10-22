//go:build !darwin

package server

import "context"

type logNotifier struct{}

func newVerifyNotifier(*Server) verifyNotifier { return logNotifier{} }

func (logNotifier) Notify(ctx context.Context, title, body string) {
	userLog(ctx).Warnf("%v: %v", title, body)
}
