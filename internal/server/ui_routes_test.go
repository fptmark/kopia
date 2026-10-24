package server

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// Every page of the web UI must be served when its address is opened directly (or the page is reloaded),
// not only when it is reached by clicking inside the app.
func TestEveryUIPageIsAKnownRoute(t *testing.T) {
	s := &Server{}

	for _, p := range []string{
		"/snapshots", "/snapshots/new", "/snapshots/single-source/", "/snapshots/dir/abc", "/snapshots/dir/abc/restore",
		"/restore", "/files", "/policies", "/policies/edit/", "/tasks", "/tasks/1a", "/repo", "/preferences", "/about",
		"/next", "/next/", "/next/snapshots", "/next/exclusions",
	} {
		require.True(t, s.isKnownUIRoute(p), p)
	}

	for _, p := range []string{"/nope", "/api/v1/sources", "/restor", "/nextdoor"} {
		require.False(t, s.isKnownUIRoute(p), p)
	}
}
