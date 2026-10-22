package server

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
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
