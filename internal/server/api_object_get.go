package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/kopia/kopia/internal/clock"
	"github.com/kopia/kopia/internal/ignoreerr"
	"github.com/kopia/kopia/repo/object"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/snapshotfs"
)

func handleObjectGet(ctx context.Context, rc requestContext) {
	oidstr := rc.muxVar("objectID")

	if !requireUIUser(ctx, rc) {
		http.Error(rc.w, "access denied", http.StatusForbidden)
		return
	}

	oid, err := object.ParseID(oidstr)
	if err != nil {
		http.Error(rc.w, "invalid object id", http.StatusBadRequest)
		return
	}

	obj, err := rc.rep.OpenObject(ctx, oid)
	if errors.Is(err, object.ErrObjectNotFound) {
		http.Error(rc.w, "object not found", http.StatusNotFound)
		return
	}

	if snapshotfs.IsDirectoryID(oid) {
		rc.w.Header().Set("Content-Type", "application/json")
	}

	fname := oid.String()
	if p := rc.queryParam("fname"); p != "" {
		fname = p
		rc.w.Header().Set("Content-Disposition", "attachment; filename=\""+p+"\"")
	}

	mtime := clock.Now()

	if p := rc.queryParam("mtime"); p != "" {
		if m, err := time.Parse(time.RFC3339Nano, p); err == nil {
			mtime = m
		}
	}

	// a folder opened with the source it belongs to is shown with the ignore rules applied to its failures
	if source := rc.queryParam("source"); source != "" && snapshotfs.IsDirectoryID(oid) {
		if srv, ok := rc.srv.(*Server); ok {
			if data, err := io.ReadAll(obj); err == nil {
				http.ServeContent(rc.w, rc.req, fname, mtime, bytes.NewReader(withIgnoredDirectoryFailures(srv.ignored, source, data)))
				return
			}
		}
	}

	http.ServeContent(rc.w, rc.req, fname, mtime, obj)
}

// withIgnoredDirectoryFailures applies the ignore rules to the failures counted in a directory listing, as the
// snapshot list does; the listing is returned as it is when it cannot be read or nothing is covered.
func withIgnoredDirectoryFailures(rules *ignoreerr.Store, source string, data []byte) []byte {
	var dm snapshot.DirManifest
	if err := json.Unmarshal(data, &dm); err != nil {
		return data
	}

	changed := false

	for _, e := range dm.Entries {
		if sum := withIgnoredFailures(rules, source, e.DirSummary); sum != e.DirSummary {
			e.DirSummary = sum
			changed = true
		}
	}

	if !changed {
		return data
	}

	out, err := json.Marshal(&dm)
	if err != nil {
		return data
	}

	return out
}
