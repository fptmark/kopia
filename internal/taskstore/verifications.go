package taskstore

import (
	"database/sql"
	"strings"
	"time"

	"github.com/pkg/errors"

	"github.com/kopia/kopia/internal/uitask"
)

// Verification modes: "full" reads every file back, "sample" a share of them, "new" every piece of data a
// snapshot added to the repository.
const (
	VerifyModeFull   = "full"
	VerifyModeSample = "sample"
	VerifyModeNew    = "new"
)

// VerificationFailure is a file (or piece of stored data) that did not read back.
type VerificationFailure struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// Verification is the outcome of reading back one snapshot.
type Verification struct {
	ID         int64     `json:"id"`
	SnapshotID string    `json:"snapshotId"`
	Source     string    `json:"source"`
	Mode       string    `json:"mode"`
	Percent    float64   `json:"percent"`
	StartedAt  time.Time `json:"startedAt"`
	FinishedAt time.Time `json:"finishedAt"`
	OK         bool      `json:"ok"`
	Files      int64     `json:"files"`
	Bytes      int64     `json:"bytes"`
	ReadFiles  int64     `json:"readFiles"`
	ReadBytes  int64     `json:"readBytes"`
	ErrorCount int64     `json:"errorCount"`
	Error      string    `json:"error,omitempty"`
	TaskSeq    int       `json:"taskSeq,omitempty"`
	// TaskID is TaskSeq as the task is named in the UI and the API.
	TaskID      string `json:"taskId,omitempty"`
	FailureKept int64  `json:"failuresKept"`
	// ClearedSeq is the id of the previous verification of the same source and mode that this one found
	// passing again, 0 if this one didn't follow a failure (set by RecordVerification, not by the caller).
	ClearedSeq int64 `json:"clearedSeq,omitempty"`
}

// RecordVerification keeps a finished verification and its failures, and returns its id and, when this result
// is OK and the previous one of the same source and mode was not, that previous verification's id.
func (s *Store) RecordVerification(v Verification, failures []VerificationFailure) (id, clearedSeq int64, err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, 0, errors.Wrap(err, "unable to record verification")
	}

	defer tx.Rollback() //nolint:errcheck

	if v.OK {
		var priorSeq int64

		var priorOK int

		switch err := tx.QueryRow(
			`SELECT seq, ok FROM snapshot_verifications WHERE source = ? AND (mode = 'new') = (? = 'new')
			 ORDER BY seq DESC LIMIT 1`, v.Source, v.Mode).Scan(&priorSeq, &priorOK); {
		case err == nil:
			if priorOK == 0 {
				clearedSeq = priorSeq
			}
		case errors.Is(err, sql.ErrNoRows):
			// no previous verification of this source and mode: nothing to clear
		default:
			return 0, 0, errors.Wrap(err, "unable to record verification")
		}
	}

	res, err := tx.Exec(
		`INSERT INTO snapshot_verifications
		 (snapshot_id, source, mode, percent, started_at, finished_at, ok, files, bytes, read_files, read_bytes, error_count, error, task_seq, cleared_seq)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		v.SnapshotID, v.Source, v.Mode, v.Percent, v.StartedAt.UnixNano(), v.FinishedAt.UnixNano(), boolInt(v.OK),
		v.Files, v.Bytes, v.ReadFiles, v.ReadBytes, v.ErrorCount, v.Error, v.TaskSeq, clearedSeq)
	if err != nil {
		return 0, 0, errors.Wrap(err, "unable to record verification")
	}

	id, err = res.LastInsertId()
	if err != nil {
		return 0, 0, errors.Wrap(err, "unable to record verification")
	}

	if len(failures) > 0 {
		stmt, err := tx.Prepare(`INSERT INTO verification_failures (verification_seq, path, error) VALUES (?, ?, ?)`)
		if err != nil {
			return 0, 0, errors.Wrap(err, "unable to record verification failures")
		}

		defer stmt.Close() //nolint:errcheck

		for _, f := range failures {
			if _, err := stmt.Exec(id, f.Path, f.Error); err != nil {
				return 0, 0, errors.Wrap(err, "unable to record verification failures")
			}
		}
	}

	return id, clearedSeq, errors.Wrap(tx.Commit(), "unable to record verification")
}

func boolInt(b bool) int {
	if b {
		return 1
	}

	return 0
}

const verificationColumns = `v.seq, v.snapshot_id, v.source, v.mode, v.percent, v.started_at, v.finished_at, v.ok, v.files, v.bytes,
	v.read_files, v.read_bytes, v.error_count, v.error, v.task_seq, v.cleared_seq,
	(SELECT COUNT(*) FROM verification_failures f WHERE f.verification_seq = v.seq)`

type rowScanner interface{ Scan(...any) error }

func scanVerification(row rowScanner) (Verification, error) {
	var (
		v          Verification
		start, end int64
		ok         int
	)

	if err := row.Scan(&v.ID, &v.SnapshotID, &v.Source, &v.Mode, &v.Percent, &start, &end, &ok, &v.Files, &v.Bytes,
		&v.ReadFiles, &v.ReadBytes, &v.ErrorCount, &v.Error, &v.TaskSeq, &v.ClearedSeq, &v.FailureKept); err != nil {
		return v, errors.Wrap(err, "unable to read verification")
	}

	v.StartedAt = time.Unix(0, start).UTC()
	v.FinishedAt = time.Unix(0, end).UTC()
	v.OK = ok == 1

	if v.TaskSeq > 0 {
		v.TaskID = uitask.FormatTaskID(v.TaskSeq)
	}

	return v, nil
}

// LatestVerifications returns the newest verification of each of the given snapshots, for the full or sample
// mode and for the new-data mode separately (a snapshot can have one of each).
func (s *Store) LatestVerifications(snapshotIDs []string) ([]Verification, error) {
	if len(snapshotIDs) == 0 {
		return []Verification{}, nil
	}

	marks := strings.TrimSuffix(strings.Repeat("?,", len(snapshotIDs)), ",")
	args := make([]any, 0, len(snapshotIDs))

	for _, id := range snapshotIDs {
		args = append(args, id)
	}

	rows, err := s.db.Query(
		`SELECT `+verificationColumns+` FROM snapshot_verifications v
		 WHERE v.snapshot_id IN (`+marks+`)
		   AND v.seq = (SELECT MAX(w.seq) FROM snapshot_verifications w
		                WHERE w.snapshot_id = v.snapshot_id AND (w.mode = 'new') = (v.mode = 'new'))
		 ORDER BY v.seq`, args...)
	if err != nil {
		return nil, errors.Wrap(err, "unable to read verifications")
	}

	defer rows.Close() //nolint:errcheck

	out := []Verification{}

	for rows.Next() {
		v, err := scanVerification(rows)
		if err != nil {
			return nil, err
		}

		out = append(out, v)
	}

	return out, errors.Wrap(rows.Err(), "unable to read verifications")
}

// GetVerification returns one verification.
func (s *Store) GetVerification(id int64) (Verification, bool, error) {
	v, err := scanVerification(s.db.QueryRow(`SELECT `+verificationColumns+` FROM snapshot_verifications v WHERE v.seq = ?`, id))
	if err != nil {
		if strings.Contains(err.Error(), "no rows") {
			return Verification{}, false, nil
		}

		return Verification{}, false, err
	}

	return v, true, nil
}

// VerificationFailures returns the failures of one verification, up to limit (0 means all).
func (s *Store) VerificationFailures(id int64, limit int) ([]VerificationFailure, error) {
	q := `SELECT path, error FROM verification_failures WHERE verification_seq = ? ORDER BY path`
	args := []any{id}

	if limit > 0 {
		q += ` LIMIT ?`

		args = append(args, limit)
	}

	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, errors.Wrap(err, "unable to read verification failures")
	}

	defer rows.Close() //nolint:errcheck

	out := []VerificationFailure{}

	for rows.Next() {
		var f VerificationFailure
		if err := rows.Scan(&f.Path, &f.Error); err != nil {
			return nil, errors.Wrap(err, "unable to read verification failures")
		}

		out = append(out, f)
	}

	return out, errors.Wrap(rows.Err(), "unable to read verification failures")
}

// FailingVerifications returns the newest verification of each source, for the full/sample mode and for the
// new-data mode separately (a source can have one of each failing at once), but only the ones that currently
// show a failure and have not been dismissed with DismissVerifications.
func (s *Store) FailingVerifications() ([]Verification, error) {
	rows, err := s.db.Query(
		`SELECT ` + verificationColumns + ` FROM snapshot_verifications v
		 WHERE v.seq = (SELECT MAX(w.seq) FROM snapshot_verifications w
		                WHERE w.source = v.source AND (w.mode = 'new') = (v.mode = 'new'))
		   AND v.ok = 0
		   AND v.seq NOT IN (SELECT verification_seq FROM dismissed_verifications)
		 ORDER BY v.source, v.mode, v.seq`)
	if err != nil {
		return nil, errors.Wrap(err, "unable to read failing verifications")
	}

	defer rows.Close() //nolint:errcheck

	out := []Verification{}

	for rows.Next() {
		v, err := scanVerification(rows)
		if err != nil {
			return nil, err
		}

		out = append(out, v)
	}

	return out, errors.Wrap(rows.Err(), "unable to read failing verifications")
}

// DismissVerifications hides the given verifications from FailingVerifications until a newer verification of
// the same source and mode replaces them.
func (s *Store) DismissVerifications(seqs []int64) error {
	if len(seqs) == 0 {
		return nil
	}

	tx, err := s.db.Begin()
	if err != nil {
		return errors.Wrap(err, "unable to dismiss verifications")
	}

	defer tx.Rollback() //nolint:errcheck

	stmt, err := tx.Prepare(`INSERT OR IGNORE INTO dismissed_verifications (verification_seq) VALUES (?)`)
	if err != nil {
		return errors.Wrap(err, "unable to dismiss verifications")
	}

	defer stmt.Close() //nolint:errcheck

	for _, seq := range seqs {
		if _, err := stmt.Exec(seq); err != nil {
			return errors.Wrap(err, "unable to dismiss verifications")
		}
	}

	return errors.Wrap(tx.Commit(), "unable to dismiss verifications")
}

// NewDataVerificationCounts says how many new-data read-backs (the automatic check right after a snapshot
// finishes, mode "new") finished since the given time, and how many of those failed and have not been
// dismissed. A sample or full check failing is a different check's business, not this one's.
func (s *Store) NewDataVerificationCounts(since time.Time) (total, failed int64, err error) {
	var bad *int64

	err = s.db.QueryRow(
		`SELECT COUNT(*), SUM(ok = 0) FROM snapshot_verifications v
		 WHERE v.finished_at >= ? AND v.mode = 'new'
		   AND v.seq NOT IN (SELECT verification_seq FROM dismissed_verifications)`,
		since.UnixNano()).Scan(&total, &bad)
	if bad != nil {
		failed = *bad
	}

	return total, failed, errors.Wrap(err, "unable to count verifications")
}

// FailingNewDataVerifications returns the mode="new" verifications that failed since the given time and have
// not been dismissed, so the check that reports them can name the source and snapshot responsible.
func (s *Store) FailingNewDataVerifications(since time.Time) ([]Verification, error) {
	rows, err := s.db.Query(
		`SELECT `+verificationColumns+` FROM snapshot_verifications v
		 WHERE v.finished_at >= ? AND v.mode = 'new' AND v.ok = 0
		   AND v.seq NOT IN (SELECT verification_seq FROM dismissed_verifications)
		 ORDER BY v.finished_at`, since.UnixNano())
	if err != nil {
		return nil, errors.Wrap(err, "unable to read failing verifications")
	}

	defer rows.Close() //nolint:errcheck

	out := []Verification{}

	for rows.Next() {
		v, err := scanVerification(rows)
		if err != nil {
			return nil, err
		}

		out = append(out, v)
	}

	return out, errors.Wrap(rows.Err(), "unable to read failing verifications")
}

// RecentlyClearedTaskIDs returns the task ids of verifications, finished since the given time, that found a
// previous failure of the same source and mode passing again -- so the Tasks list can mark that task as
// having resolved a problem.
func (s *Store) RecentlyClearedTaskIDs(since time.Time) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT task_seq FROM snapshot_verifications WHERE cleared_seq != 0 AND finished_at >= ? AND task_seq > 0`,
		since.UnixNano())
	if err != nil {
		return nil, errors.Wrap(err, "unable to read cleared verifications")
	}

	defer rows.Close() //nolint:errcheck

	out := []string{}

	for rows.Next() {
		var seq int
		if err := rows.Scan(&seq); err != nil {
			return nil, errors.Wrap(err, "unable to read cleared verifications")
		}

		out = append(out, uitask.FormatTaskID(seq))
	}

	return out, errors.Wrap(rows.Err(), "unable to read cleared verifications")
}

// LastVerificationOfSource returns when a source was last verified in the given mode's bucket (mode "new"
// is its own bucket; sample and full share one, same as FailingVerifications), so a scheduled periodic
// verify knows whether it's due -- a manual or automatic run of the same kind already counts, same as a
// manually-triggered snapshot counts toward a source's own snapshot schedule.
func (s *Store) LastVerificationOfSource(source, mode string) (time.Time, bool, error) {
	var finishedAt int64

	err := s.db.QueryRow(
		`SELECT finished_at FROM snapshot_verifications WHERE source = ? AND (mode = 'new') = (? = 'new')
		 ORDER BY seq DESC LIMIT 1`, source, mode).Scan(&finishedAt)

	switch {
	case errors.Is(err, sql.ErrNoRows):
		return time.Time{}, false, nil
	case err != nil:
		return time.Time{}, false, errors.Wrap(err, "unable to read the last verification")
	default:
		return time.Unix(0, finishedAt).UTC(), true, nil
	}
}
