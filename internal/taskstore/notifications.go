package taskstore

import (
	"database/sql"
	"time"

	"github.com/pkg/errors"
)

// NotificationEntry is one attempt to deliver a notification.
type NotificationEntry struct {
	SentAt      time.Time `json:"sentAt"`
	Destination string    `json:"destination"`
	Event       string    `json:"event"`
	Mode        string    `json:"mode"`
	Status      string    `json:"status"`
	Attempts    int       `json:"attempts"`
	Error       string    `json:"error,omitempty"`
}

// RecordNotification keeps the outcome of delivering a notification.
func (s *Store) RecordNotification(e NotificationEntry) error {
	_, err := s.db.Exec(
		`INSERT INTO notification_log (sent_at, destination, event, mode, status, attempts, error) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		e.SentAt.UnixNano(), e.Destination, e.Event, e.Mode, e.Status, e.Attempts, e.Error)

	return errors.Wrap(err, "unable to record notification")
}

// Notifications returns the recorded notifications, newest first.
func (s *Store) Notifications(limit int) ([]NotificationEntry, error) {
	if limit <= 0 {
		limit = defaultListLimit
	}

	rows, err := s.db.Query(`SELECT sent_at, destination, event, mode, status, attempts, error FROM notification_log ORDER BY sent_at DESC, seq DESC LIMIT ?`, limit)
	if err != nil {
		return nil, errors.Wrap(err, "unable to read notification log")
	}

	defer rows.Close() //nolint:errcheck

	out := []NotificationEntry{}

	for rows.Next() {
		var (
			e  NotificationEntry
			at int64
		)

		if err := rows.Scan(&at, &e.Destination, &e.Event, &e.Mode, &e.Status, &e.Attempts, &e.Error); err != nil {
			return nil, errors.Wrap(err, "unable to read notification log")
		}

		e.SentAt = time.Unix(0, at)
		out = append(out, e)
	}

	return out, errors.Wrap(rows.Err(), "unable to read notification log")
}

// SourceActivity is what happened to one source's snapshots in a period.
type SourceActivity struct {
	Source      string // user@host:/path
	Snapshots   int    // completed
	Files       int64  // in the newest completed snapshot
	Failed      int    // snapshots that failed
	WithSkipped int    // completed snapshots that skipped files
	MostSkipped int64
}

// SnapshotActivity summarizes snapshot tasks that started in [from, to), by source.
func (s *Store) SnapshotActivity(from, to time.Time) ([]SourceActivity, error) {
	rows, err := s.db.Query(
		`SELECT source, status, total_files, failed_files FROM tasks
		 WHERE kind = 'Snapshot' AND status IN ('SUCCESS', 'FAILED') AND source <> '' AND start_time >= ? AND start_time < ?
		 ORDER BY start_time`, from.UnixNano(), to.UnixNano())
	if err != nil {
		return nil, errors.Wrap(err, "unable to read snapshot activity")
	}

	defer rows.Close() //nolint:errcheck

	bySource := map[string]*SourceActivity{}

	var order []string

	for rows.Next() {
		var (
			src, status    string
			files, skipped int64
		)

		if err := rows.Scan(&src, &status, &files, &skipped); err != nil {
			return nil, errors.Wrap(err, "unable to read snapshot activity")
		}

		a := bySource[src]
		if a == nil {
			a = &SourceActivity{Source: src}
			bySource[src] = a
			order = append(order, src)
		}

		if status == "FAILED" {
			a.Failed++
			continue
		}

		a.Snapshots++
		a.Files = files

		if skipped > 0 {
			a.WithSkipped++

			if skipped > a.MostSkipped {
				a.MostSkipped = skipped
			}
		}
	}

	if err := rows.Err(); err != nil {
		return nil, errors.Wrap(err, "unable to read snapshot activity")
	}

	out := make([]SourceActivity, 0, len(order))
	for _, src := range order {
		out = append(out, *bySource[src])
	}

	return out, nil
}

// MaintenanceActivity counts maintenance runs that started in [from, to) and how many failed.
func (s *Store) MaintenanceActivity(from, to time.Time) (runs, failed int, err error) {
	err = s.db.QueryRow(
		`SELECT COUNT(*), COALESCE(SUM(status = 'FAILED'), 0) FROM tasks
		 WHERE kind = 'Maintenance' AND status IN ('SUCCESS', 'FAILED') AND start_time >= ? AND start_time < ?`,
		from.UnixNano(), to.UnixNano()).Scan(&runs, &failed)

	return runs, failed, errors.Wrap(err, "unable to read maintenance activity")
}

// LastRollup returns when a destination last received its periodic summary.
func (s *Store) LastRollup(destination string) (time.Time, bool, error) {
	var at int64

	err := s.db.QueryRow(`SELECT last_rollup_at FROM notification_state WHERE destination = ?`, destination).Scan(&at)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, false, nil
	}

	if err != nil {
		return time.Time{}, false, errors.Wrap(err, "unable to read notification state")
	}

	return time.Unix(0, at), true, nil
}

// SetLastRollup records when a destination received its periodic summary.
func (s *Store) SetLastRollup(destination string, at time.Time) error {
	_, err := s.db.Exec(`INSERT OR REPLACE INTO notification_state (destination, last_rollup_at) VALUES (?, ?)`, destination, at.UnixNano())

	return errors.Wrap(err, "unable to record notification state")
}

// LastSent returns when a destination was last told about this failure.
func (s *Store) LastSent(destination, kind, detail string) (time.Time, bool, error) {
	var at int64

	err := s.db.QueryRow(
		`SELECT last_sent_at FROM notification_repeat WHERE destination = ? AND kind = ? AND detail = ?`,
		destination, kind, detail).Scan(&at)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, false, nil
	}

	if err != nil {
		return time.Time{}, false, errors.Wrap(err, "unable to read notification repeat state")
	}

	return time.Unix(0, at), true, nil
}

// SetSent records that a destination was told about a failure.
func (s *Store) SetSent(destination, kind, detail string, at time.Time) error {
	_, err := s.db.Exec(
		`INSERT OR REPLACE INTO notification_repeat (destination, kind, detail, last_sent_at) VALUES (?, ?, ?, ?)`,
		destination, kind, detail, at.UnixNano())

	return errors.Wrap(err, "unable to record notification repeat state")
}

// TakeSent forgets what a destination was told about a failure kind (or only one detail of it when detail is
// not empty) and reports whether there was anything to forget.
func (s *Store) TakeSent(destination, kind, detail string) (bool, error) {
	q := `DELETE FROM notification_repeat WHERE destination = ? AND kind = ?`
	args := []any{destination, kind}

	if detail != "" {
		q += ` AND detail = ?`

		args = append(args, detail)
	}

	res, err := s.db.Exec(q, args...)
	if err != nil {
		return false, errors.Wrap(err, "unable to clear notification repeat state")
	}

	n, err := res.RowsAffected()

	return n > 0, errors.Wrap(err, "unable to clear notification repeat state")
}
