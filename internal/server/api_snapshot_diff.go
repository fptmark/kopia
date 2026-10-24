package server

import (
	"context"
	"path"

	"github.com/pkg/errors"

	"github.com/kopia/kopia/fs"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/repo"
	"github.com/kopia/kopia/repo/manifest"
	"github.com/kopia/kopia/repo/object"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/snapshotfs"
)

// maxSnapshotDiffEntries limits the entries returned; the totals still count everything.
const maxSnapshotDiffEntries = 5000

type snapshotDiffer struct {
	resp *serverapi.SnapshotDiffResponse
}

func handleSnapshotDiff(ctx context.Context, rc requestContext) (any, *apiError) {
	from, to := manifest.ID(rc.queryParam("from")), manifest.ID(rc.queryParam("to"))
	if from == "" || to == "" {
		return nil, requestError(serverapi.ErrorMalformedRequest, "from and to are required")
	}

	manifests, err := snapshot.LoadSnapshots(ctx, rc.rep, []manifest.ID{from, to})
	if err != nil {
		return nil, internalServerError(err)
	}

	if len(manifests) != 2 {
		return nil, requestError(serverapi.ErrorNotFound, "snapshot not found")
	}

	m1, m2 := manifests[0], manifests[1]
	if m1.ID != from {
		m1, m2 = m2, m1
	}

	if m1.Source != m2.Source {
		return nil, requestError(serverapi.ErrorMalformedRequest, "snapshots are from different sources")
	}

	dir1, err := snapshotRootDir(rc.rep, m1)
	if err != nil {
		return nil, internalServerError(err)
	}

	dir2, err := snapshotRootDir(rc.rep, m2)
	if err != nil {
		return nil, internalServerError(err)
	}

	d := &snapshotDiffer{resp: &serverapi.SnapshotDiffResponse{
		Source:  m1.Source,
		From:    convertSnapshotManifest(m1),
		To:      convertSnapshotManifest(m2),
		Entries: []*serverapi.SnapshotDiffEntry{},
	}}

	if err := d.compareEntries(ctx, dir1, dir2, ""); err != nil {
		return nil, internalServerError(err)
	}

	return d.resp, nil
}

// snapshotRootDir returns the root of a snapshot as a directory.
func snapshotRootDir(rep repo.Repository, m *snapshot.Manifest) (fs.Directory, error) {
	root, err := snapshotfs.SnapshotRoot(rep, m)
	if err != nil {
		return nil, errors.Wrap(err, "unable to open the snapshot")
	}

	dir, ok := root.(fs.Directory)
	if !ok {
		return nil, errors.New("snapshot root is not a directory")
	}

	return dir, nil
}

func objectIDOf(e fs.Entry) string {
	if h, ok := e.(object.HasObjectID); ok {
		return h.ObjectID().String()
	}

	return ""
}

func (d *snapshotDiffer) add(e *serverapi.SnapshotDiffEntry) {
	if len(d.resp.Entries) >= maxSnapshotDiffEntries {
		d.resp.Truncated = true
		return
	}

	d.resp.Entries = append(d.resp.Entries, e)
}

// totals returns the size and number of files under a directory, or the size of a file.
func totals(ctx context.Context, e fs.Entry) (size, files int64) {
	if dir, ok := e.(fs.DirectoryWithSummary); ok {
		if s, err := dir.Summary(ctx); err == nil && s != nil {
			return s.TotalFileSize, s.TotalFileCount
		}

		return 0, 0
	}

	if e.IsDir() {
		return 0, 0
	}

	return e.Size(), 1
}

// compareEntries compares the same directory in two snapshots. A subdirectory with the same object ID
// in both is identical and is not read.
func (d *snapshotDiffer) compareEntries(ctx context.Context, dir1, dir2 fs.Directory, dirPath string) error {
	entries1, err := fs.GetAllEntries(ctx, dir1)
	if err != nil {
		return errors.Wrapf(err, "unable to read %v", dirPath)
	}

	entries2, err := fs.GetAllEntries(ctx, dir2)
	if err != nil {
		return errors.Wrapf(err, "unable to read %v", dirPath)
	}

	byName := make(map[string]fs.Entry, len(entries1))
	for _, e := range entries1 {
		byName[e.Name()] = e
	}

	for _, e2 := range entries2 {
		p := path.Join(dirPath, e2.Name())

		e1 := byName[e2.Name()]
		delete(byName, e2.Name())

		if err := d.compareEntry(ctx, e1, e2, p); err != nil {
			return err
		}
	}

	// whatever is left was removed
	for _, e1 := range entries1 {
		if _, ok := byName[e1.Name()]; ok {
			d.removed(ctx, e1, path.Join(dirPath, e1.Name()))
		}
	}

	return nil
}

func (d *snapshotDiffer) added(ctx context.Context, e fs.Entry, p string) {
	size, files := totals(ctx, e)
	d.resp.Added += files
	d.resp.AddedBytes += size
	d.add(&serverapi.SnapshotDiffEntry{Path: p, Change: "added", IsDir: e.IsDir(), NewSize: size, Files: dirFiles(e, files)})
}

func (d *snapshotDiffer) removed(ctx context.Context, e fs.Entry, p string) {
	size, files := totals(ctx, e)
	d.resp.Removed += files
	d.resp.RemovedBytes += size
	d.add(&serverapi.SnapshotDiffEntry{Path: p, Change: "removed", IsDir: e.IsDir(), OldSize: size, Files: dirFiles(e, files)})
}

func dirFiles(e fs.Entry, files int64) int64 {
	if e.IsDir() {
		return files
	}

	return 0
}

func (d *snapshotDiffer) compareEntry(ctx context.Context, e1, e2 fs.Entry, p string) error {
	switch {
	case e1 == nil:
		d.added(ctx, e2, p)
		return nil

	case e1.IsDir() != e2.IsDir():
		d.removed(ctx, e1, p)
		d.added(ctx, e2, p)

		return nil

	case e1.IsDir():
		if id1 := objectIDOf(e1); id1 != "" && id1 == objectIDOf(e2) {
			return nil
		}

		d1, ok1 := e1.(fs.Directory)
		d2, ok2 := e2.(fs.Directory)

		if !ok1 || !ok2 {
			return nil
		}

		return d.compareEntries(ctx, d1, d2, p)
	}

	// files and other non-directories
	if id1 := objectIDOf(e1); id1 != "" && id1 == objectIDOf(e2) {
		return nil
	}

	if objectIDOf(e1) == "" && e1.Size() == e2.Size() && e1.ModTime().Equal(e2.ModTime()) {
		return nil
	}

	d.resp.Modified++
	d.resp.ModifiedDeltaBytes += e2.Size() - e1.Size()
	d.add(&serverapi.SnapshotDiffEntry{Path: p, Change: "modified", OldSize: e1.Size(), NewSize: e2.Size()})

	return nil
}
