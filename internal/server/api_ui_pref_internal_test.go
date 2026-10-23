package server

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/notifyhub"
)

func TestMergeUIPreferencesKeepsSettingsTheClientDoesNotKnow(t *testing.T) {
	stored := []byte(`{"theme":"dark","keepAwake":"ac","verifierIMessageTo":"+15551234567"}`)

	// a page that predates the iMessage setting, or was still loading, sends only what it knows
	merged, err := mergeUIPreferences(stored, []byte(`{"theme":"light","keepAwake":"never","pageSize":20}`))
	require.NoError(t, err)

	var got map[string]any
	require.NoError(t, json.Unmarshal(merged, &got))
	require.Equal(t, "light", got["theme"], "what the client sent wins")
	require.Equal(t, "never", got["keepAwake"])
	require.EqualValues(t, 20, got["pageSize"])
	require.Equal(t, "+15551234567", got["verifierIMessageTo"], "what it did not send is kept")
}

func TestMergeUIPreferencesAllowsClearingASetting(t *testing.T) {
	merged, err := mergeUIPreferences([]byte(`{"verifierIMessageTo":"+15551234567"}`), []byte(`{"verifierIMessageTo":""}`))
	require.NoError(t, err)
	require.JSONEq(t, `{"verifierIMessageTo":""}`, string(merged), "an explicit empty value really clears it")
}

func TestMergeUIPreferencesHandlesMissingOrDamagedStoredFile(t *testing.T) {
	for _, stored := range [][]byte{nil, []byte(""), []byte("{broken"), []byte("null")} {
		merged, err := mergeUIPreferences(stored, []byte(`{"theme":"dark"}`))
		require.NoError(t, err)
		require.JSONEq(t, `{"theme":"dark"}`, string(merged))
	}

	_, err := mergeUIPreferences(nil, []byte(`not json`))
	require.Error(t, err)
}

func TestSavingTheRecipientPreferenceUpdatesTheIPhoneDestination(t *testing.T) {
	dir := t.TempDir()
	prefs := filepath.Join(dir, "ui-preferences.json")
	dests := filepath.Join(dir, "notification-destinations.json")

	s := &Server{options: Options{UIPreferencesFile: prefs}}
	s.setupNotifications(context.Background())

	put := func(body string) {
		_, apiErr := handleSetUIPreferences(context.Background(), requestContext{srv: s, body: []byte(body)})
		require.Nil(t, apiErr)
	}

	put(`{"verifierIMessageTo":"+1 555 0100"}`)

	ds, err := notifyhub.Load(dests)
	require.NoError(t, err)
	require.Len(t, ds, 2)
	require.Equal(t, "+1 555 0100", ds[1].Target)

	// a page that does not know the setting must not touch the destination
	put(`{"theme":"dark"}`)

	ds, _ = notifyhub.Load(dests)
	require.Len(t, ds, 2)

	put(`{"verifierIMessageTo":""}`)

	ds, _ = notifyhub.Load(dests)
	require.Len(t, ds, 1, "clearing the recipient removes the iPhone destination")
}
