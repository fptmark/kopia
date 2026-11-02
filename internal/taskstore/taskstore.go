// Package taskstore keeps a permanent record of server tasks (snapshots, maintenance, restores, ...),
// their logs, the files that failed in each snapshot, and the size of the repository over time,
// in a SQLite database that can also be examined with the sqlite3 command line tool.
package taskstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pkg/errors"
	_ "modernc.org/sqlite" // pure Go SQLite driver

	"github.com/kopia/kopia/internal/uitask"
)

const (
	defaultListLimit = 50
	maxListLimit     = 1000

	interruptedMessage = "interrupted: the server stopped while this task was running"
)

// Store is a SQLite database of task history.
type Store struct {
	db   *sql.DB
	path string
}

// Open opens (creating if needed) the database at the given path. Tasks that were still running when the
// server last stopped are marked as failed (interrupted).
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, errors.Wrap(err, "unable to create directory for task history")
	}

	dsn := "file:" + path +
		"?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)"

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, errors.Wrap(err, "unable to open task history")
	}

	// WAL lets readers run while one writer writes; a few connections keep a long backup from blocking writes.
	db.SetMaxOpenConns(4) //nolint:mnd

	s := &Store{db: db, path: path}

	if err := s.migrate(); err != nil {
		_ = db.Close()

		return nil, err
	}

	if err := s.markInterrupted(); err != nil {
		_ = db.Close()

		return nil, err
	}

	return s, nil
}

// Close closes the database.
func (s *Store) Close() error {
	return errors.Wrap(s.db.Close(), "unable to close task history")
}

// Path returns the database file path.
func (s *Store) Path() string {
	return s.path
}

const schemaV1 = `
CREATE TABLE tasks (
	seq          INTEGER PRIMARY KEY,
	kind         TEXT    NOT NULL,
	description  TEXT    NOT NULL,
	status       TEXT    NOT NULL,
	start_time   INTEGER NOT NULL, -- unix nanoseconds, UTC
	end_time     INTEGER,
	error        TEXT    NOT NULL DEFAULT '',
	counters     TEXT    NOT NULL DEFAULT '{}',
	source       TEXT    NOT NULL DEFAULT '',
	snapshot_id  TEXT    NOT NULL DEFAULT '',
	total_size   INTEGER NOT NULL DEFAULT 0,
	total_files  INTEGER NOT NULL DEFAULT 0,
	failed_files INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX tasks_by_start  ON tasks (start_time);
CREATE INDEX tasks_by_status ON tasks (status, seq);
CREATE INDEX tasks_by_kind   ON tasks (kind, seq);

CREATE TABLE task_logs (
	task_seq INTEGER NOT NULL REFERENCES tasks (seq) ON DELETE CASCADE,
	n        INTEGER NOT NULL,
	line     TEXT    NOT NULL,
	PRIMARY KEY (task_seq, n)
) WITHOUT ROWID;

CREATE TABLE snapshot_errors (
	task_seq INTEGER NOT NULL REFERENCES tasks (seq) ON DELETE CASCADE,
	path     TEXT    NOT NULL,
	error    TEXT    NOT NULL
);
CREATE INDEX snapshot_errors_by_task ON snapshot_errors (task_seq);

CREATE TABLE storage_usage (
	computed_at INTEGER PRIMARY KEY, -- unix nanoseconds, UTC
	total_bytes INTEGER NOT NULL,
	blob_count  INTEGER NOT NULL,
	elapsed_ms  INTEGER NOT NULL
);

-- readable times for use from the sqlite3 command line
CREATE VIEW task_history AS
SELECT printf('%x', seq) AS id, kind, status,
       datetime(start_time / 1000000000, 'unixepoch', 'localtime') AS started,
       datetime(end_time / 1000000000, 'unixepoch', 'localtime') AS ended,
       (end_time - start_time) / 1000000000.0 AS seconds,
       description, source, total_files, failed_files, error
FROM tasks;

CREATE VIEW snapshot_error_history AS
SELECT printf('%x', t.seq) AS task, datetime(t.start_time / 1000000000, 'unixepoch', 'localtime') AS started,
       t.source, e.path, e.error
FROM snapshot_errors e JOIN tasks t ON t.seq = e.task_seq;
`

// schemaV2 adds the record of notifications sent.
const schemaV2 = `
CREATE TABLE notification_log (
	seq         INTEGER PRIMARY KEY AUTOINCREMENT,
	sent_at     INTEGER NOT NULL, -- unix nanoseconds, UTC
	destination TEXT    NOT NULL,
	event       TEXT    NOT NULL,
	mode        TEXT    NOT NULL, -- now or roll
	status      TEXT    NOT NULL, -- sent or failed
	attempts    INTEGER NOT NULL,
	error       TEXT    NOT NULL
);
CREATE INDEX notification_log_by_time ON notification_log (sent_at);
`

// schemaV3 adds when each destination last received its periodic summary.
const schemaV3 = `
CREATE TABLE notification_state (
	destination    TEXT PRIMARY KEY,
	last_rollup_at INTEGER NOT NULL -- unix nanoseconds, UTC
);
`

// schemaV4 remembers which failures each destination was told about, and when, so a failure that goes on is
// reported once per period and its end is reported only to those who heard of it.
const schemaV4 = `
CREATE TABLE notification_repeat (
	destination  TEXT    NOT NULL,
	kind         TEXT    NOT NULL, -- failure type
	detail       TEXT    NOT NULL, -- what makes it the same failure again (a source, a problem code)
	last_sent_at INTEGER NOT NULL, -- unix nanoseconds, UTC
	PRIMARY KEY (destination, kind, detail)
);
`

// schemaV5 keeps the result of each read-back verification of a snapshot, with every file that failed.
const schemaV5 = `
CREATE TABLE snapshot_verifications (
	seq          INTEGER PRIMARY KEY AUTOINCREMENT,
	snapshot_id  TEXT    NOT NULL,
	source       TEXT    NOT NULL,
	mode         TEXT    NOT NULL, -- full, sample or new
	percent      REAL    NOT NULL, -- share of the files read back in full
	started_at   INTEGER NOT NULL, -- unix nanoseconds, UTC
	finished_at  INTEGER NOT NULL,
	ok           INTEGER NOT NULL,
	files        INTEGER NOT NULL,
	bytes        INTEGER NOT NULL,
	read_files   INTEGER NOT NULL,
	read_bytes   INTEGER NOT NULL,
	error_count  INTEGER NOT NULL,
	error        TEXT    NOT NULL DEFAULT '',
	task_seq     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX snapshot_verifications_by_snapshot ON snapshot_verifications (snapshot_id, seq);

CREATE TABLE verification_failures (
	verification_seq INTEGER NOT NULL REFERENCES snapshot_verifications (seq) ON DELETE CASCADE,
	path             TEXT    NOT NULL,
	error            TEXT    NOT NULL
);
CREATE INDEX verification_failures_by_verification ON verification_failures (verification_seq);
`

const schemaV6 = `
CREATE TABLE dismissed_verifications (
	verification_seq INTEGER PRIMARY KEY REFERENCES snapshot_verifications (seq) ON DELETE CASCADE
);
`

const schemaV7 = `
ALTER TABLE snapshot_verifications ADD COLUMN cleared_seq INTEGER NOT NULL DEFAULT 0;
`

// schemaV8 tracks reads that didn't happen because of a connection problem or a cancellation, separately from
// reads that actually came back bad -- so a flaky connection never shows up looking like data corruption.
const schemaV8 = `
ALTER TABLE snapshot_verifications ADD COLUMN interrupted_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE verification_failures ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0;
`

// schemaV9 records why a task was canceled, when it wasn't a user clicking Stop -- e.g. the server canceling
// a Snapshot/Verify/Maintenance task itself because the machine looked like it had just woken from sleep.
const schemaV9 = `
ALTER TABLE tasks ADD COLUMN cancel_reason TEXT NOT NULL DEFAULT '';
`

// migrations are applied in order; the database version is the number applied.
var migrations = []string{schemaV1, schemaV2, schemaV3, schemaV4, schemaV5, schemaV6, schemaV7, schemaV8, schemaV9} //nolint:gochecknoglobals

func (s *Store) migrate() error {
	var v int

	if err := s.db.QueryRow("PRAGMA user_version").Scan(&v); err != nil {
		return errors.Wrap(err, "unable to read task history version")
	}

	if v > len(migrations) {
		return errors.Errorf("task history was written by a newer version (schema %d, this build understands %d)", v, len(migrations))
	}

	if v == len(migrations) {
		return nil
	}

	tx, err := s.db.Begin()
	if err != nil {
		return errors.Wrap(err, "unable to start task history setup")
	}

	defer tx.Rollback() //nolint:errcheck

	for _, m := range migrations[v:] {
		if _, err := tx.Exec(m); err != nil {
			return errors.Wrap(err, "unable to update task history tables")
		}
	}

	if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", len(migrations))); err != nil {
		return errors.Wrap(err, "unable to set task history version")
	}

	return errors.Wrap(tx.Commit(), "unable to commit task history setup")
}

func (s *Store) markInterrupted() error {
	_, err := s.db.Exec(
		`UPDATE tasks SET status = ?, end_time = ?, error = ? WHERE status IN (?, ?)`,
		string(uitask.StatusFailed), time.Now().UnixNano(), interruptedMessage,
		string(uitask.StatusRunning), string(uitask.StatusCanceling))

	return errors.Wrap(err, "unable to mark interrupted tasks")
}

func seqOf(info uitask.Info) (int, error) {
	seq, ok := uitask.ParseTaskID(info.TaskID)
	if !ok {
		return 0, errors.Errorf("invalid task ID %q", info.TaskID)
	}

	return seq, nil
}

func countersJSON(c map[string]uitask.CounterValue) string {
	if c == nil {
		return "{}"
	}

	b, err := json.Marshal(c)
	if err != nil {
		return "{}"
	}

	return string(b)
}

// TaskStarted implements uitask.HistoryStore.
func (s *Store) TaskStarted(info uitask.Info) error {
	seq, err := seqOf(info)
	if err != nil {
		return err
	}

	_, err = s.db.Exec(
		`INSERT OR REPLACE INTO tasks (seq, kind, description, status, start_time, counters) VALUES (?, ?, ?, ?, ?, ?)`,
		seq, info.Kind, info.Description, string(info.Status), info.StartTime.UnixNano(), countersJSON(info.Counters))

	return errors.Wrap(err, "unable to record task start")
}

// TaskFinished implements uitask.HistoryStore.
func (s *Store) TaskFinished(info uitask.Info, logLines []json.RawMessage) error {
	seq, err := seqOf(info)
	if err != nil {
		return err
	}

	tx, err := s.db.Begin()
	if err != nil {
		return errors.Wrap(err, "unable to record task end")
	}

	defer tx.Rollback() //nolint:errcheck

	var end any
	if info.EndTime != nil {
		end = info.EndTime.UnixNano()
	}

	res, err := tx.Exec(
		`UPDATE tasks SET status = ?, end_time = ?, error = ?, counters = ?, description = ?, cancel_reason = ? WHERE seq = ?`,
		string(info.Status), end, info.ErrorMessage, countersJSON(info.Counters), info.Description, info.CancelReason, seq)
	if err != nil {
		return errors.Wrap(err, "unable to record task end")
	}

	if n, _ := res.RowsAffected(); n == 0 {
		// the start was not recorded (e.g. the history was attached while the task was running)
		if _, err := tx.Exec(
			`INSERT INTO tasks (seq, kind, description, status, start_time, end_time, error, counters, cancel_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			seq, info.Kind, info.Description, string(info.Status), info.StartTime.UnixNano(), end, info.ErrorMessage, countersJSON(info.Counters), info.CancelReason); err != nil {
			return errors.Wrap(err, "unable to record task")
		}
	}

	if _, err := tx.Exec(`DELETE FROM task_logs WHERE task_seq = ?`, seq); err != nil {
		return errors.Wrap(err, "unable to record task log")
	}

	if len(logLines) > 0 {
		stmt, err := tx.Prepare(`INSERT INTO task_logs (task_seq, n, line) VALUES (?, ?, ?)`)
		if err != nil {
			return errors.Wrap(err, "unable to record task log")
		}

		defer stmt.Close() //nolint:errcheck

		for i, l := range logLines {
			if _, err := stmt.Exec(seq, i, string(l)); err != nil {
				return errors.Wrap(err, "unable to record task log")
			}
		}
	}

	return errors.Wrap(tx.Commit(), "unable to record task end")
}

// MaxTaskSeq implements uitask.HistoryStore.
func (s *Store) MaxTaskSeq() (int, error) {
	var n sql.NullInt64

	if err := s.db.QueryRow(`SELECT MAX(seq) FROM tasks`).Scan(&n); err != nil {
		return 0, errors.Wrap(err, "unable to read last task number")
	}

	return int(n.Int64), nil
}

func scanTask(row interface{ Scan(...any) error }) (uitask.Info, error) {
	var (
		seq        int
		start      int64
		end        sql.NullInt64
		counters   string
		info       uitask.Info
		statusText string
	)

	if err := row.Scan(&seq, &info.Kind, &info.Description, &statusText, &start, &end, &info.ErrorMessage, &counters, &info.FailedFiles, &info.CancelReason); err != nil {
		return uitask.Info{}, err //nolint:wrapcheck
	}

	info.TaskID = uitask.FormatTaskID(seq)
	info.Status = uitask.Status(statusText)
	info.StartTime = time.Unix(0, start)

	if end.Valid {
		t := time.Unix(0, end.Int64)
		info.EndTime = &t
	}

	info.Counters = map[string]uitask.CounterValue{}
	_ = json.Unmarshal([]byte(counters), &info.Counters)

	return info, nil
}

const taskColumns = `seq, kind, description, status, start_time, end_time, error, counters, failed_files, cancel_reason`

// ListTasks implements uitask.HistoryStore.
func (s *Store) ListTasks(q uitask.TaskQuery) ([]uitask.Info, int, error) {
	var (
		where []string
		args  []any
	)

	add := func(cond string, a ...any) {
		where = append(where, cond)
		args = append(args, a...)
	}

	if q.Status != "" {
		add("status = ?", q.Status)
	}

	if q.Kind != "" {
		add("kind = ?", q.Kind)
	}

	if !q.From.IsZero() {
		add("start_time >= ?", q.From.UnixNano())
	}

	if !q.To.IsZero() {
		add("start_time <= ?", q.To.UnixNano())
	}

	if q.Text != "" {
		add("(instr(lower(description), lower(?)) > 0 OR instr(lower(error), lower(?)) > 0)", q.Text, q.Text)
	}

	filter := ""
	if len(where) > 0 {
		filter = " WHERE " + strings.Join(where, " AND ")
	}

	var total int

	if err := s.db.QueryRow(`SELECT COUNT(*) FROM tasks`+filter, args...).Scan(&total); err != nil {
		return nil, 0, errors.Wrap(err, "unable to count tasks")
	}

	pageWhere := filter
	pageArgs := append([]any(nil), args...)

	if q.BeforeSeq > 0 {
		if pageWhere == "" {
			pageWhere = " WHERE seq < ?"
		} else {
			pageWhere += " AND seq < ?"
		}

		pageArgs = append(pageArgs, q.BeforeSeq)
	}

	limit := q.Limit
	if limit <= 0 {
		limit = defaultListLimit
	}

	limit = min(limit, maxListLimit)

	rows, err := s.db.Query(`SELECT `+taskColumns+` FROM tasks`+pageWhere+` ORDER BY seq DESC LIMIT ?`, append(pageArgs, limit)...)
	if err != nil {
		return nil, 0, errors.Wrap(err, "unable to list tasks")
	}

	defer rows.Close() //nolint:errcheck

	var out []uitask.Info

	for rows.Next() {
		info, err := scanTask(rows)
		if err != nil {
			return nil, 0, errors.Wrap(err, "unable to read task")
		}

		out = append(out, info)
	}

	return out, total, errors.Wrap(rows.Err(), "unable to list tasks")
}

// GetTask implements uitask.HistoryStore.
func (s *Store) GetTask(seq int) (uitask.Info, bool, error) {
	info, err := scanTask(s.db.QueryRow(`SELECT `+taskColumns+` FROM tasks WHERE seq = ?`, seq))
	if errors.Is(err, sql.ErrNoRows) {
		return uitask.Info{}, false, nil
	}

	if err != nil {
		return uitask.Info{}, false, errors.Wrap(err, "unable to read task")
	}

	return info, true, nil
}

// TaskLogs implements uitask.HistoryStore.
func (s *Store) TaskLogs(seq int) ([]json.RawMessage, error) {
	rows, err := s.db.Query(`SELECT line FROM task_logs WHERE task_seq = ? ORDER BY n`, seq)
	if err != nil {
		return nil, errors.Wrap(err, "unable to read task log")
	}

	defer rows.Close() //nolint:errcheck

	var out []json.RawMessage

	for rows.Next() {
		var l string
		if err := rows.Scan(&l); err != nil {
			return nil, errors.Wrap(err, "unable to read task log")
		}

		out = append(out, json.RawMessage(l))
	}

	return out, errors.Wrap(rows.Err(), "unable to read task log")
}

// SnapshotError is a file or directory that could not be backed up.
type SnapshotError struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// SnapshotResult is what a snapshot task produced.
type SnapshotResult struct {
	Source      string
	SnapshotID  string
	TotalSize   int64
	TotalFiles  int64
	FailedFiles int64
	Errors      []SnapshotError
}

// RecordSnapshotResult attaches the outcome of a snapshot, including each failed file, to its task.
func (s *Store) RecordSnapshotResult(taskID string, r SnapshotResult) error {
	seq, ok := uitask.ParseTaskID(taskID)
	if !ok {
		return errors.Errorf("invalid task ID %q", taskID)
	}

	tx, err := s.db.Begin()
	if err != nil {
		return errors.Wrap(err, "unable to record snapshot result")
	}

	defer tx.Rollback() //nolint:errcheck

	if _, err := tx.Exec(
		`UPDATE tasks SET source = ?, snapshot_id = ?, total_size = ?, total_files = ?, failed_files = ? WHERE seq = ?`,
		r.Source, r.SnapshotID, r.TotalSize, r.TotalFiles, r.FailedFiles, seq); err != nil {
		return errors.Wrap(err, "unable to record snapshot result")
	}

	if _, err := tx.Exec(`DELETE FROM snapshot_errors WHERE task_seq = ?`, seq); err != nil {
		return errors.Wrap(err, "unable to record snapshot errors")
	}

	if len(r.Errors) > 0 {
		stmt, err := tx.Prepare(`INSERT INTO snapshot_errors (task_seq, path, error) VALUES (?, ?, ?)`)
		if err != nil {
			return errors.Wrap(err, "unable to record snapshot errors")
		}

		defer stmt.Close() //nolint:errcheck

		for _, e := range r.Errors {
			if _, err := stmt.Exec(seq, e.Path, e.Error); err != nil {
				return errors.Wrap(err, "unable to record snapshot errors")
			}
		}
	}

	return errors.Wrap(tx.Commit(), "unable to record snapshot result")
}

// SnapshotErrors returns the files that failed in the given snapshot task.
func (s *Store) SnapshotErrors(taskID string) ([]SnapshotError, error) {
	seq, ok := uitask.ParseTaskID(taskID)
	if !ok {
		return nil, errors.Errorf("invalid task ID %q", taskID)
	}

	rows, err := s.db.Query(`SELECT path, error FROM snapshot_errors WHERE task_seq = ? ORDER BY path`, seq)
	if err != nil {
		return nil, errors.Wrap(err, "unable to read snapshot errors")
	}

	defer rows.Close() //nolint:errcheck

	out := []SnapshotError{}

	for rows.Next() {
		var e SnapshotError
		if err := rows.Scan(&e.Path, &e.Error); err != nil {
			return nil, errors.Wrap(err, "unable to read snapshot errors")
		}

		out = append(out, e)
	}

	return out, errors.Wrap(rows.Err(), "unable to read snapshot errors")
}

// StorageUsage is the size of the repository at one point in time.
type StorageUsage struct {
	ComputedAt time.Time `json:"computedAt"`
	TotalBytes int64     `json:"totalBytes"`
	BlobCount  int64     `json:"blobCount"`
	ElapsedMS  int64     `json:"elapsedMs"`
}

// RecordStorageUsage keeps the result of a repository size calculation.
func (s *Store) RecordStorageUsage(u StorageUsage) error {
	_, err := s.db.Exec(
		`INSERT OR REPLACE INTO storage_usage (computed_at, total_bytes, blob_count, elapsed_ms) VALUES (?, ?, ?, ?)`,
		u.ComputedAt.UnixNano(), u.TotalBytes, u.BlobCount, u.ElapsedMS)

	return errors.Wrap(err, "unable to record storage usage")
}

// StorageUsageHistory returns recorded repository sizes, newest first.
func (s *Store) StorageUsageHistory(limit int) ([]StorageUsage, error) {
	if limit <= 0 {
		limit = defaultListLimit
	}

	rows, err := s.db.Query(`SELECT computed_at, total_bytes, blob_count, elapsed_ms FROM storage_usage ORDER BY computed_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, errors.Wrap(err, "unable to read storage usage history")
	}

	defer rows.Close() //nolint:errcheck

	out := []StorageUsage{}

	for rows.Next() {
		var (
			u  StorageUsage
			at int64
		)

		if err := rows.Scan(&at, &u.TotalBytes, &u.BlobCount, &u.ElapsedMS); err != nil {
			return nil, errors.Wrap(err, "unable to read storage usage history")
		}

		u.ComputedAt = time.Unix(0, at)
		out = append(out, u)
	}

	return out, errors.Wrap(rows.Err(), "unable to read storage usage history")
}

// Prune deletes finished tasks (with their logs and snapshot errors) that started before the cutoff
// and returns how many were deleted.
func (s *Store) Prune(cutoff time.Time) (int64, error) {
	res, err := s.db.Exec(`DELETE FROM tasks WHERE start_time < ? AND status NOT IN (?, ?)`,
		cutoff.UnixNano(), string(uitask.StatusRunning), string(uitask.StatusCanceling))
	if err != nil {
		return 0, errors.Wrap(err, "unable to prune task history")
	}

	n, _ := res.RowsAffected()

	return n, nil
}

// BackupTo writes a consistent copy of the database to the given file (replacing it). The copy is a normal
// SQLite database, safe to include in a file backup even while this one is being written.
func (s *Store) BackupTo(ctx context.Context, dest string) error {
	tmp := dest + ".tmp"

	_ = os.Remove(tmp)

	if _, err := s.db.ExecContext(ctx, `VACUUM INTO ?`, tmp); err != nil {
		return errors.Wrap(err, "unable to back up task history")
	}

	return errors.Wrap(os.Rename(tmp, dest), "unable to back up task history")
}

// Kinds returns the distinct kinds of tasks recorded (Snapshot, Maintenance, ...), for filtering.
func (s *Store) Kinds() ([]string, error) {
	rows, err := s.db.Query(`SELECT DISTINCT kind FROM tasks ORDER BY kind`)
	if err != nil {
		return nil, errors.Wrap(err, "unable to read task kinds")
	}

	defer rows.Close() //nolint:errcheck

	out := []string{}

	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, errors.Wrap(err, "unable to read task kinds")
		}

		out = append(out, k)
	}

	return out, errors.Wrap(rows.Err(), "unable to read task kinds")
}

// SnapshotSource returns the source (user@host:/path) a snapshot task ran for.
func (s *Store) SnapshotSource(taskID string) (string, error) {
	seq, ok := uitask.ParseTaskID(taskID)
	if !ok {
		return "", errors.Errorf("invalid task ID %q", taskID)
	}

	var src string

	err := s.db.QueryRow(`SELECT source FROM tasks WHERE seq = ?`, seq).Scan(&src)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}

	return src, errors.Wrap(err, "unable to read the task source")
}

// SnapshotIDOf returns the ID of the snapshot a snapshot task made, or "" when it made none or predates the record.
func (s *Store) SnapshotIDOf(taskID string) (string, error) {
	seq, ok := uitask.ParseTaskID(taskID)
	if !ok {
		return "", errors.Errorf("invalid task ID %q", taskID)
	}

	var id string

	err := s.db.QueryRow(`SELECT snapshot_id FROM tasks WHERE seq = ?`, seq).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}

	return id, errors.Wrap(err, "unable to read the task snapshot")
}

// TaskOfSnapshot returns the ID of the snapshot task that made the snapshot, or "" when none is on record.
func (s *Store) TaskOfSnapshot(snapshotID string) (string, error) {
	if snapshotID == "" {
		return "", nil
	}

	var seq int

	err := s.db.QueryRow(
		`SELECT seq FROM tasks WHERE snapshot_id = ? AND kind = 'Snapshot' ORDER BY seq DESC LIMIT 1`, snapshotID).Scan(&seq)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}

	if err != nil {
		return "", errors.Wrap(err, "unable to find the task of the snapshot")
	}

	return uitask.FormatTaskID(seq), nil
}

// SourceError is a failed file of a snapshot, with the source it belongs to.
type SourceError struct {
	Source string
	SnapshotError
}

// LatestSnapshotErrors returns the failed files of the newest finished snapshot of every source.
func (s *Store) LatestSnapshotErrors() ([]SourceError, error) {
	rows, err := s.db.Query(`SELECT t.source, e.path, e.error FROM snapshot_errors e JOIN tasks t ON t.seq = e.task_seq
WHERE t.seq IN (SELECT MAX(seq) FROM tasks WHERE source <> '' AND kind = 'Snapshot' AND status = 'SUCCESS' GROUP BY source)`)
	if err != nil {
		return nil, errors.Wrap(err, "unable to read snapshot errors")
	}

	defer rows.Close() //nolint:errcheck

	var out []SourceError

	for rows.Next() {
		var e SourceError
		if err := rows.Scan(&e.Source, &e.Path, &e.Error); err != nil {
			return nil, errors.Wrap(err, "unable to read snapshot errors")
		}

		out = append(out, e)
	}

	return out, errors.Wrap(rows.Err(), "unable to read snapshot errors")
}
