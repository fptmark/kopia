package server

import (
	"context"
	"io"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pkg/errors"

	"github.com/kopia/kopia/fs"
	"github.com/kopia/kopia/internal/taskstore"
	"github.com/kopia/kopia/repo"
	"github.com/kopia/kopia/repo/blob"
	"github.com/kopia/kopia/repo/content"
	"github.com/kopia/kopia/repo/object"
)

const (
	verifyWorkers      = 8
	verifyQueueLength  = 4096
	verifyFailuresKept = 10000
	// failures are written to the task log up to this many, so the Tasks page shows them too.
	verifyFailuresLogged = 500
	verifyProgressEvery  = time.Second
	// newDataSlack widens the time window of "what this snapshot wrote" a little on both sides.
	newDataSlack = 10 * time.Second
)

// snapVerifyStats counts the work of a verification so far.
type snapVerifyStats struct {
	// Total is how many files (or pieces of stored data) there are to check, when that is known up front.
	Total     int64
	Files     int64
	Bytes     int64
	ReadFiles int64
	ReadBytes int64
	Errors    int64
}

// snapVerifyResult is what a verification found. Every failure is counted; the first verifyFailuresKept are kept.
type snapVerifyResult struct {
	snapVerifyStats
	Failures []taskstore.VerificationFailure
}

// treeRoot is a snapshot (or part of one) to read back, with the path it is reported under.
type treeRoot struct {
	Path  string
	Entry fs.Entry
}

type snapVerifyOptions struct {
	// Percent is the share of the files read back in full: 100 reads every one, 1 about a hundredth.
	Percent float64
	// ExpectedFiles is the number of files in the trees, for progress; 0 when unknown.
	ExpectedFiles int64
	// BlobMap lists the pack blobs in storage, so each content can be checked to be in a pack that is there
	// and long enough. Nil skips that check.
	BlobMap  map[blob.ID]blob.Metadata
	Progress func(snapVerifyStats)
}

// snapVerify reads a snapshot back. Unlike snapshotfs.Verifier it keeps the path of every failure and never
// stops early, so the result says how much is damaged and where.
type snapVerify struct {
	rep  repo.Repository
	opts snapVerifyOptions
	seen sync.Map

	files, bytes, readFiles, readBytes, errs, total atomic.Int64

	mu       sync.Mutex
	failures []taskstore.VerificationFailure

	lastProgress atomic.Int64
}

type verifyJob struct {
	entry fs.Entry
	path  string
}

// verifyTrees reads back the given snapshot trees. Directories are walked once each, however often they
// occur; files that share stored data are checked once.
func verifyTrees(ctx context.Context, rep repo.Repository, roots []treeRoot, opts snapVerifyOptions) snapVerifyResult {
	v := &snapVerify{rep: rep, opts: opts}
	v.total.Store(opts.ExpectedFiles)

	jobs := make(chan verifyJob, verifyQueueLength)

	var wg sync.WaitGroup

	for range verifyWorkers {
		wg.Go(func() {
			for j := range jobs {
				if ctx.Err() == nil {
					v.checkFile(ctx, j)
				}
			}
		})
	}

	for _, r := range roots {
		v.walk(ctx, r.Entry, r.Path, jobs)
	}

	close(jobs)
	wg.Wait()

	return v.result()
}

func (v *snapVerify) stats() snapVerifyStats {
	return snapVerifyStats{
		Total: v.total.Load(), Files: v.files.Load(), Bytes: v.bytes.Load(), ReadFiles: v.readFiles.Load(), ReadBytes: v.readBytes.Load(), Errors: v.errs.Load(),
	}
}

func (v *snapVerify) result() snapVerifyResult {
	v.mu.Lock()
	defer v.mu.Unlock()

	return snapVerifyResult{snapVerifyStats: v.stats(), Failures: append([]taskstore.VerificationFailure(nil), v.failures...)}
}

func (v *snapVerify) fail(ctx context.Context, path string, err error) {
	n := v.errs.Add(1)

	if n <= verifyFailuresLogged {
		userLog(ctx).Errorf("%v: %v", path, err)
	}

	v.mu.Lock()
	defer v.mu.Unlock()

	if len(v.failures) < verifyFailuresKept {
		v.failures = append(v.failures, taskstore.VerificationFailure{Path: path, Error: err.Error()})
	}
}

func (v *snapVerify) report() {
	if v.opts.Progress == nil {
		return
	}

	now := time.Now().UnixNano()
	last := v.lastProgress.Load()

	if now-last < int64(verifyProgressEvery) || !v.lastProgress.CompareAndSwap(last, now) {
		return
	}

	v.opts.Progress(v.stats())
}

// firstVisit reports true the first time it sees a stored object.
func (v *snapVerify) firstVisit(id object.ID) bool {
	_, loaded := v.seen.LoadOrStore(id.String(), struct{}{})

	return !loaded
}

func (v *snapVerify) walk(ctx context.Context, e fs.Entry, path string, jobs chan<- verifyJob) {
	if ctx.Err() != nil {
		return
	}

	dir, ok := e.(fs.Directory)
	if !ok {
		select {
		case jobs <- verifyJob{entry: e, path: path}:
		case <-ctx.Done():
		}

		return
	}

	if h, ok := e.(object.HasObjectID); ok && !v.firstVisit(h.ObjectID()) {
		return
	}

	err := fs.IterateEntries(ctx, dir, func(ctx context.Context, c fs.Entry) error {
		v.walk(ctx, c, path+"/"+c.Name(), jobs)

		return nil
	})
	if err != nil && ctx.Err() == nil {
		v.fail(ctx, path, errors.Wrap(err, "unable to list the folder"))
	}
}

func (v *snapVerify) checkFile(ctx context.Context, j verifyJob) {
	defer v.report()

	v.files.Add(1)
	v.bytes.Add(j.entry.Size())

	h, ok := j.entry.(object.HasObjectID)
	if !ok {
		return
	}

	oid := h.ObjectID()
	if !v.firstVisit(oid) {
		return
	}

	contentIDs, err := v.rep.VerifyObject(ctx, oid)
	if err != nil {
		v.fail(ctx, j.path, errors.Wrap(err, "the stored data is incomplete"))

		return
	}

	if err := v.checkPacks(ctx, contentIDs); err != nil {
		v.fail(ctx, j.path, err)

		return
	}

	if v.opts.Percent < 100 && 100*rand.Float64() >= v.opts.Percent { //nolint:gosec
		return
	}

	r, err := v.rep.OpenObject(ctx, oid)
	if err != nil {
		v.fail(ctx, j.path, errors.Wrap(err, "unable to open the stored data"))

		return
	}

	defer r.Close() //nolint:errcheck

	n, err := io.Copy(io.Discard, r)
	if err != nil {
		v.fail(ctx, j.path, errors.Wrap(err, "unable to read the stored data back"))

		return
	}

	v.readFiles.Add(1)
	v.readBytes.Add(n)
}

// checkPacks confirms each content lies inside a pack blob that is in storage.
func (v *snapVerify) checkPacks(ctx context.Context, ids []content.ID) error {
	if v.opts.BlobMap == nil {
		return nil
	}

	for _, id := range ids {
		ci, err := v.rep.ContentInfo(ctx, id)
		if err != nil {
			return errors.Wrapf(err, "content %v is not in the index", id)
		}

		if err := checkPack(v.opts.BlobMap, ci); err != nil {
			return err
		}
	}

	return nil
}

func checkPack(blobs map[blob.ID]blob.Metadata, ci content.Info) error {
	bm, found := blobs[ci.PackBlobID]
	if !found {
		return errors.Errorf("pack blob %v is missing from storage", ci.PackBlobID)
	}

	if end := int64(ci.PackOffset) + int64(ci.PackedLength); end > bm.Length {
		return errors.Errorf("pack blob %v is %d bytes but its data runs to byte %d", ci.PackBlobID, bm.Length, end)
	}

	return nil
}

// verifyNewContents reads back every piece of stored data written between from and to: what a snapshot added
// to the repository (data it shared with earlier snapshots is not written again). Each pack blob is looked up in
// storage and each content is read, decrypted and checked against its hash.
func verifyNewContents(ctx context.Context, dr repo.DirectRepository, from, to time.Time, progress func(snapVerifyStats)) (snapVerifyResult, error) {
	cr := dr.ContentReader()
	from, to = from.Add(-newDataSlack), to.Add(newDataSlack)

	var infos []content.Info

	if err := cr.IterateContents(ctx, content.IterateOptions{Parallel: 1}, func(ci content.Info) error {
		if t := ci.Timestamp(); !t.Before(from) && !t.After(to) {
			infos = append(infos, ci)
		}

		return nil
	}); err != nil {
		return snapVerifyResult{}, errors.Wrap(err, "unable to list the stored data")
	}

	v := &snapVerify{opts: snapVerifyOptions{Progress: progress}}
	v.total.Store(int64(len(infos)))

	// one lookup per pack blob
	packs := map[blob.ID]blob.Metadata{}
	bad := map[blob.ID]bool{}

	for _, ci := range infos {
		if _, done := packs[ci.PackBlobID]; done || bad[ci.PackBlobID] {
			continue
		}

		bm, err := dr.BlobReader().GetMetadata(ctx, ci.PackBlobID)
		if err != nil {
			bad[ci.PackBlobID] = true

			v.fail(ctx, "pack "+string(ci.PackBlobID), errors.Wrap(err, "not found in storage"))

			continue
		}

		packs[ci.PackBlobID] = bm
	}

	jobs := make(chan content.Info, verifyQueueLength)

	var wg sync.WaitGroup

	for range verifyWorkers {
		wg.Go(func() {
			for ci := range jobs {
				if ctx.Err() != nil {
					continue
				}

				v.files.Add(1)

				if err := checkPack(packs, ci); err != nil {
					v.fail(ctx, "content "+ci.ContentID.String(), err)
					v.report()

					continue
				}

				data, err := cr.GetContent(ctx, ci.ContentID)
				if err != nil {
					v.fail(ctx, "content "+ci.ContentID.String()+" in pack "+string(ci.PackBlobID), errors.Wrap(err, "unable to read the stored data back"))
					v.report()

					continue
				}

				v.bytes.Add(int64(len(data)))
				v.readFiles.Add(1)
				v.readBytes.Add(int64(len(data)))
				v.report()
			}
		})
	}

	for _, ci := range infos {
		if bad[ci.PackBlobID] {
			continue
		}

		select {
		case jobs <- ci:
		case <-ctx.Done():
		}
	}

	close(jobs)
	wg.Wait()

	return v.result(), nil
}
