package server

import (
	"net/http"
	"net/http/httptest"
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
		"/exclusions", "/spec",
	} {
		require.True(t, s.isKnownUIRoute(p), p)
	}

	for _, p := range []string{"/nope", "/api/v1/sources", "/restor", "/nextdoor", "/next", "/next/snapshots"} {
		require.False(t, s.isKnownUIRoute(p), p)
	}
}

// Addresses from the time the rebuilt UI lived under /next still work.
func TestOldNextAddressesAreSentToThePageWithoutThePrefix(t *testing.T) {
	for from, want := range map[string]string{
		"/next":                            "/",
		"/next/":                           "/",
		"/next/snapshots":                  "/snapshots",
		"/next/snapshots/diff?from=a&to=b": "/snapshots/diff?from=a&to=b",
	} {
		r := httptest.NewRequest(http.MethodGet, from, http.NoBody)

		got, ok := legacyUIRedirect(r)
		require.True(t, ok, from)
		require.Equal(t, want, got, from)
	}

	for _, p := range []string{"/", "/snapshots", "/nextdoor", "/api/v1/next"} {
		_, ok := legacyUIRedirect(httptest.NewRequest(http.MethodGet, p, http.NoBody))
		require.False(t, ok, p)
	}
}
