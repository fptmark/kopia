package server

import (
	"bytes"
	"context"
	"encoding/json"
	"os"

	"github.com/natefinch/atomic"
	"github.com/pkg/errors"

	"github.com/kopia/kopia/internal/serverapi"
)

func getUIPreferencesOrEmpty(s serverInterface) (serverapi.UIPreferences, error) {
	p := serverapi.UIPreferences{}

	if s.getOptions().UIPreferencesFile == "" {
		return p, nil
	}

	f, err := os.Open(s.getOptions().UIPreferencesFile)
	if os.IsNotExist(err) {
		return p, nil
	}

	if err != nil {
		return p, errors.Wrap(err, "unable to open UI preferences file")
	}

	defer f.Close() //nolint:errcheck

	if err := json.NewDecoder(f).Decode(&p); err != nil {
		return p, errors.Wrap(err, "invalid UI preferences file")
	}

	return p, nil
}

func handleGetUIPreferences(_ context.Context, rc requestContext) (any, *apiError) {
	p, err := getUIPreferencesOrEmpty(rc.srv)
	if err != nil {
		return nil, internalServerError(err)
	}

	return &p, nil
}

// mergeUIPreferences overlays the preferences a client sent on the stored ones. A setting the client did not send
// keeps its stored value: a page that was opened before a setting existed, or that was still loading, does not
// know about it and must not erase it.
func mergeUIPreferences(stored, sent []byte) ([]byte, error) {
	var in map[string]json.RawMessage
	if err := json.Unmarshal(sent, &in); err != nil {
		return nil, errors.Wrap(err, "malformed preferences")
	}

	out := map[string]json.RawMessage{}

	if len(stored) > 0 {
		// a damaged stored file is replaced by what was sent
		_ = json.Unmarshal(stored, &out)
		if out == nil {
			out = map[string]json.RawMessage{}
		}
	}

	for k, v := range in {
		out[k] = v
	}

	b, err := json.Marshal(out)

	return b, errors.Wrap(err, "unable to encode preferences")
}

func handleSetUIPreferences(_ context.Context, rc requestContext) (any, *apiError) {
	var p serverapi.UIPreferences

	// verify the JSON is valid by unmarshaling it
	if err := json.Unmarshal(rc.body, &p); err != nil {
		return nil, requestError(serverapi.ErrorMalformedRequest, "malformed request")
	}

	file := rc.srv.getOptions().UIPreferencesFile

	stored, err := os.ReadFile(file) //nolint:gosec
	if err != nil && !os.IsNotExist(err) {
		return nil, internalServerError(err)
	}

	merged, err := mergeUIPreferences(stored, rc.body)
	if err != nil {
		return nil, requestError(serverapi.ErrorMalformedRequest, "malformed request")
	}

	if err := atomic.WriteFile(file, bytes.NewReader(merged)); err != nil {
		return nil, internalServerError(err)
	}

	return serverapi.Empty{}, nil
}
