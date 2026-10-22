//go:build !darwin

package server

import "context"

func preventSleep(_ context.Context, _ string) func() {
	return func() {}
}
