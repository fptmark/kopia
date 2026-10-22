package server

import (
	"context"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pkg/errors"

	"github.com/kopia/kopia/fs"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/repo"
	"github.com/kopia/kopia/repo/object"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/snapshotfs"
)

const (
	defaultSearchMaxResults = 5000
	searchDirReaders        = 16
)

// searchVersion is one distinct (source, path, object) found by a search.
type searchVersion struct {
	res serverapi.SearchResult
}

func (v *searchVersion) touch(t time.Time) {
	if v.res.SnapshotCount == 0 || t.Before(v.res.FirstSeen) {
		v.res.FirstSeen = t
	}

	if t.After(v.res.LastSeen) {
		v.res.LastSeen = t
	}

	v.res.SnapshotCount++
}

// globToRegexp converts a wildcard pattern (* and ?) to a case-insensitive regular expression that must
// match the whole string. It reports whether the pattern is matched against the full path (it contains
// a slash) instead of the name.
func globToRegexp(pattern string) (re *regexp.Regexp, pathMode bool, err error) {
	pattern = strings.TrimSpace(pattern)
	if pattern == "" {
		return nil, false, errors.New("search pattern is empty")
	}

	pathMode = strings.Contains(pattern, "/")
	pattern = strings.TrimPrefix(pattern, "/")

	var sb strings.Builder

	sb.WriteString("(?is)^")

	for _, r := range pattern {
		switch r {
		case '*':
			sb.WriteString(".*")
		case '?':
			sb.WriteString(".")
		default:
			sb.WriteString(regexp.QuoteMeta(string(r)))
		}
	}

	sb.WriteString("$")

	re, err = regexp.Compile(sb.String())

	return re, pathMode, errors.Wrap(err, "invalid search pattern")
}

type snapshotSearcher struct {
	rep         repo.Repository
	re          *regexp.Regexp
	pathMode    bool
	includeDirs bool
	maxResults  int
	cancel      context.CancelFunc

	sem chan struct{}

	mu        sync.Mutex
	versions  map[string]*searchVersion
	visited   map[string][]*searchVersion // directory (source, path, object) -> matches found below it
	truncated bool

	snapshotsTotal atomic.Int64
	snapshotsDone  atomic.Int64
	directories    atomic.Int64
	entries        atomic.Int64
}

func newSnapshotSearcher(rep repo.Repository, req serverapi.SearchRequest, cancel context.CancelFunc) (*snapshotSearcher, error) {
	re, pathMode, err := globToRegexp(req.Pattern)
	if err != nil {
		return nil, err
	}

	maxResults := req.MaxResults
	if maxResults <= 0 {
		maxResults = defaultSearchMaxResults
	}

	return &snapshotSearcher{
		rep:         rep,
		re:          re,
		pathMode:    pathMode,
		includeDirs: req.IncludeDirs,
		maxResults:  maxResults,
		cancel:      cancel,
		sem:         make(chan struct{}, searchDirReaders),
		versions:    map[string]*searchVersion{},
		visited:     map[string][]*searchVersion{},
	}, nil
}

func (s *snapshotSearcher) progress() serverapi.SearchProgress {
	return serverapi.SearchProgress{
		SnapshotsTotal: int(s.snapshotsTotal.Load()),
		SnapshotsDone:  int(s.snapshotsDone.Load()),
		Directories:    s.directories.Load(),
		Entries:        s.entries.Load(),
	}
}

// results returns the versions found so far, ordered by path and then most recent first.
func (s *snapshotSearcher) results() ([]serverapi.SearchResult, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]serverapi.SearchResult, 0, len(s.versions))
	for _, v := range s.versions {
		out = append(out, v.res)
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].Source != out[j].Source {
			return out[i].Source < out[j].Source
		}

		if out[i].Path != out[j].Path {
			return out[i].Path < out[j].Path
		}

		return out[i].LastSeen.After(out[j].LastSeen)
	})

	return out, s.truncated
}

// selectSnapshots picks the snapshots to search: those in the time range (and source, if given),
// newest first.
func selectSnapshots(manifests []*snapshot.Manifest, req serverapi.SearchRequest) []*snapshot.Manifest {
	var out []*snapshot.Manifest

	for _, m := range manifests {
		if m.RootEntry == nil {
			continue
		}

		if req.SourcePath != "" && m.Source.Path != req.SourcePath {
			continue
		}

		t := m.StartTime.ToTime()
		if !req.From.IsZero() && t.Before(req.From) {
			continue
		}

		if !req.To.IsZero() && t.After(req.To) {
			continue
		}

		out = append(out, m)
	}

	sort.Slice(out, func(i, j int) bool { return out[i].StartTime > out[j].StartTime })

	return out
}

// search walks the given snapshots. A directory that has the same object ID at the same path as in a
// snapshot already walked is not read again: the matches found below it earlier are simply seen
// again in this snapshot, which keeps the cost proportional to what actually changed.
func (s *snapshotSearcher) search(ctx context.Context, manifests []*snapshot.Manifest) error {
	s.snapshotsTotal.Store(int64(len(manifests)))

	for _, m := range manifests {
		if err := ctx.Err(); err != nil {
			return errors.Wrap(err, "search canceled")
		}

		root, err := snapshotfs.SnapshotRoot(s.rep, m)
		if err != nil {
			return errors.Wrapf(err, "unable to open snapshot %v", m.ID)
		}

		dir, ok := root.(fs.Directory)
		if !ok {
			continue
		}

		if _, err := s.walk(ctx, m.Source.String(), m.StartTime.ToTime(), dir, "", m.RootObjectID()); err != nil {
			return err
		}

		s.snapshotsDone.Add(1)
	}

	return nil
}

type dirChild struct {
	name  string
	isDir bool
	size  int64
	mtime time.Time
	oid   object.ID
	dir   fs.Directory
}

func (s *snapshotSearcher) readDir(ctx context.Context, dir fs.Directory) ([]dirChild, error) {
	s.sem <- struct{}{}
	defer func() { <-s.sem }()

	var children []dirChild

	err := fs.IterateEntries(ctx, dir, func(_ context.Context, e fs.Entry) error {
		c := dirChild{name: e.Name(), isDir: e.IsDir(), size: e.Size(), mtime: e.ModTime()}

		if h, ok := e.(object.HasObjectID); ok {
			c.oid = h.ObjectID()
		}

		if d, ok := e.(fs.Directory); ok {
			c.dir = d
		}

		children = append(children, c)

		return nil
	})

	return children, errors.Wrap(err, "unable to read directory")
}

func (s *snapshotSearcher) walk(ctx context.Context, source string, snapTime time.Time, dir fs.Directory, relPath string, oid object.ID) ([]*searchVersion, error) {
	key := source + "\x00" + relPath + "\x00" + oid.String()

	s.mu.Lock()
	if known, ok := s.visited[key]; ok {
		s.mu.Unlock()

		for _, v := range known {
			s.mu.Lock()
			v.touch(snapTime)
			s.mu.Unlock()
		}

		return known, nil
	}
	s.mu.Unlock()

	if err := ctx.Err(); err != nil {
		return nil, errors.Wrap(err, "search canceled")
	}

	children, err := s.readDir(ctx, dir)
	if err != nil {
		// an unreadable directory must not fail the whole search
		return nil, nil //nolint:nilerr
	}

	s.directories.Add(1)
	s.entries.Add(int64(len(children)))

	var (
		found   []*searchVersion
		foundMu sync.Mutex
		wg      sync.WaitGroup
	)

	for _, c := range children {
		childPath := c.name
		if relPath != "" {
			childPath = relPath + "/" + c.name
		}

		if (!c.isDir || s.includeDirs) && s.matches(c.name, childPath) {
			if v := s.record(source, childPath, c, snapTime); v != nil {
				found = append(found, v)
			}
		}

		if c.isDir && c.dir != nil {
			wg.Add(1)

			go func(c dirChild, childPath string) {
				defer wg.Done()

				below, _ := s.walk(ctx, source, snapTime, c.dir, childPath, c.oid)

				foundMu.Lock()
				found = append(found, below...)
				foundMu.Unlock()
			}(c, childPath)
		}
	}

	wg.Wait()

	s.mu.Lock()
	s.visited[key] = found
	s.mu.Unlock()

	return found, nil
}

func (s *snapshotSearcher) matches(name, path string) bool {
	if s.pathMode {
		return s.re.MatchString(path)
	}

	return s.re.MatchString(name)
}

func (s *snapshotSearcher) record(source, path string, c dirChild, snapTime time.Time) *searchVersion {
	key := source + "\x00" + path + "\x00" + c.oid.String()

	s.mu.Lock()
	defer s.mu.Unlock()

	v, ok := s.versions[key]
	if !ok {
		if len(s.versions) >= s.maxResults {
			s.truncated = true
			s.cancel()

			return nil
		}

		v = &searchVersion{res: serverapi.SearchResult{
			Source:   source,
			Path:     path,
			Name:     c.name,
			IsDir:    c.isDir,
			Size:     c.size,
			ModTime:  c.mtime,
			ObjectID: c.oid.String(),
		}}
		s.versions[key] = v
	}

	v.touch(snapTime)

	return v
}

// snapshotRanges summarizes which snapshots exist: overall and per source, ordered by source.
func snapshotRanges(manifests []*snapshot.Manifest) *serverapi.SearchRangeResponse {
	res := &serverapi.SearchRangeResponse{Sources: []serverapi.SearchSourceRange{}}
	bySource := map[string]*serverapi.SearchSourceRange{}

	for _, m := range manifests {
		if m.RootEntry == nil {
			continue
		}

		t := m.StartTime.ToTime()

		if res.Count == 0 || t.Before(res.First) {
			res.First = t
		}

		if t.After(res.Last) {
			res.Last = t
		}

		res.Count++

		key := m.Source.String()

		r, ok := bySource[key]
		if !ok {
			r = &serverapi.SearchSourceRange{Source: key, Path: m.Source.Path, First: t, Last: t}
			bySource[key] = r
		}

		r.Count++

		if t.Before(r.First) {
			r.First = t
		}

		if t.After(r.Last) {
			r.Last = t
		}
	}

	for _, r := range bySource {
		res.Sources = append(res.Sources, *r)
	}

	sort.Slice(res.Sources, func(i, j int) bool { return res.Sources[i].Source < res.Sources[j].Source })

	return res
}
