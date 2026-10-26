package taskstore

import (
	"strings"
	"time"

	"github.com/pkg/errors"
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
	ID          int64     `json:"id"`
	SnapshotID  string    `json:"snapshotId"`
	Source      string    `json:"source"`
	Mode        string    `json:"mode"`
	Percent     float64   `json:"percent"`
	StartedAt   time.Time `json:"startedAt"`
	FinishedAt  time.Time `json:"finishedAt"`
	OK          bool      `json:"ok"`
	Files       int64     `json:"files"`
	Bytes       int64     `json:"bytes"`
	ReadFiles   int64     `json:"readFiles"`
	ReadBytes   int64     `json:"readBytes"`
	ErrorCount  int64     `json:"errorCount"`
	Error       string    `json:"error,omitempty"`
	TaskSeq     int       `json:"taskSeq,omitempty"`
	FailureKept int64     `json:"failuresKept"`
}

// RecordVerification keeps a finished verification and its failures, and returns its ID.
func (s *Store) RecordVerification(v Verification, failures []VerificationFailure) (int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, errors.Wrap(err, "unable to record verification")
	}

	defer tx.Rollback() //nolint:errcheck

	res, err := tx.Exec(
		`INSERT INTO snapshot_verifications
		 (snapshot_id, source, mode, percent, started_at, finished_at, ok, files, bytes, read_files, read_bytes, error_count, error, task_seq)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		v.SnapshotID, v.Source, v.Mode, v.Percent, v.StartedAt.UnixNano(), v.FinishedAt.UnixNano(), boolInt(v.OK),
		v.Files, v.Bytes, v.ReadFiles, v.ReadBytes, v.ErrorCount, v.Error, v.TaskSeq)
	if err != nil {
		return 0, errors.Wrap(err, "unable to record verification")
	}

	id, err := res.LastInsertId()
	if err != nil {
		return 0, errors.Wrap(err, "unable to record verification")
	}

	if len(failures) > 0 {
		stmt, err := tx.Prepare(`INSERT INTO verification_failures (verification_seq, path, error) VALUES (?, ?, ?)`)
		if err != nil {
			return 0, errors.Wrap(err, "unable to record verification failures")
		}

		defer stmt.Close() //nolint:errcheck

		for _, f := range failures {
			if _, err := stmt.Exec(id, f.Path, f.Error); err != nil {
				return 0, errors.Wrap(err, "unable to record verification failures")
			}
		}
	}

	return id, errors.Wrap(tx.Commit(), "unable to record verification")
}

func boolInt(b bool) int {
	if b {
		return 1
	}

	return 0
}

const verificationColumns = `v.seq, v.snapshot_id, v.source, v.mode, v.percent, v.started_at, v.finished_at, v.ok, v.files, v.bytes,
	v.read_files, v.read_bytes, v.error_count, v.error, v.task_seq,
	(SELECT COUNT(*) FROM verification_failures f WHERE f.verification_seq = v.seq)`

type rowScanner interface{ Scan(...any) error }

func scanVerification(row rowScanner) (Verification, error) {
	var (
		v          Verification
		start, end int64
		ok         int
	)

	if err := row.Scan(&v.ID, &v.SnapshotID, &v.Source, &v.Mode, &v.Percent, &start, &end, &ok, &v.Files, &v.Bytes,
		&v.ReadFiles, &v.ReadBytes, &v.ErrorCount, &v.Error, &v.TaskSeq, &v.FailureKept); err != nil {
		return v, errors.Wrap(err, "unable to read verification")
	}

	v.StartedAt = time.Unix(0, start).UTC()
	v.FinishedAt = time.Unix(0, end).UTC()
	v.OK = ok == 1

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

// NewDataVerificationCounts says how many verifications finished since the given time, whatever the mode, and how
// many of those failed.
func (s *Store) NewDataVerificationCounts(since time.Time) (total, failed int64, err error) {
	var bad *int64

	err = s.db.QueryRow(
		`SELECT COUNT(*), SUM(ok = 0) FROM snapshot_verifications WHERE finished_at >= ?`,
		since.UnixNano()).Scan(&total, &bad)
	if bad != nil {
		failed = *bad
	}

	return total, failed, errors.Wrap(err, "unable to count verifications")
}
